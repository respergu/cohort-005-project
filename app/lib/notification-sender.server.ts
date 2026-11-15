import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "~/db/schema";
import { notificationOutbox, OutboxRowStatus } from "~/db/schema";
import { db as serverDb } from "~/db";
import type { OutboxRow } from "~/lib/notification-outbox.server";
import {
  chooseTransport,
  createTransport,
  describeSendFailure,
  mightPassOnRetry,
  type KnockTrigger,
  type NotificationTransport,
  type SenderEnv,
} from "~/lib/notification-transports.server";

// ─── Sending the outbox ───
// Hands waiting outbox rows to a transport and deletes each row the transport
// accepts. It runs in the server process: routes start it on the rows they
// just committed, and a timer sweeps every ~30s for rows a failure or a crash
// left behind. Domain functions never call it. See docs/adr/0014.
//
// A send that might pass (429, 5xx, timeout, network) is retried with
// exponential backoff for about an hour, then parked. Any other 4xx parks the
// row at once. Every row, waiting or parked, is dropped 24 hours after it was
// written. Parking and dropping are only ever log lines.

type Db = BetterSQLite3Database<typeof schema>;

export type NotificationSender = {
  /** Sends these rows, if they are still waiting and due. */
  send(rowIds: number[], now: Date): Promise<void>;
  /**
   * Sends every waiting row that's due: one a crash left behind, or one whose
   * backoff is over. First drops every row that's 24 hours old.
   */
  sweep(now: Date): Promise<void>;
  /**
   * Sends a parked row again, with the same idempotency key, for an operator
   * recovering from a bad deploy. If it fails, it goes back into the normal
   * retries. Its 24h expiry still counts from when it was written.
   */
  resend(rowId: number, now: Date): Promise<ResendOutcome>;
};

/** What happened to a row handed to the transport. */
type SendOutcome = "sent" | "retrying" | "parked";

export type ResendOutcome = SendOutcome | "expired" | "not parked";

/** The wait after the first failed send. Each later failure doubles it. */
const FIRST_RETRY_DELAY_MS = 30_000;

/**
 * How many times a row is sent before it's parked. With the backoff doubling
 * from 30s, the last send goes about an hour (63.5 minutes) after the first.
 */
const MAX_ATTEMPTS = 8;

function retryAt(failedAttempts: number, now: Date): string {
  const delay = FIRST_RETRY_DELAY_MS * 2 ** (failedAttempts - 1);
  return new Date(now.getTime() + delay).toISOString();
}

/** Every row, waiting or parked, is deleted this long after it was written. */
const ROW_LIFETIME_MS = 24 * 60 * 60 * 1000;

function expiredBefore(now: Date): string {
  return new Date(now.getTime() - ROW_LIFETIME_MS).toISOString();
}

function expiresAt(row: OutboxRow): string {
  return new Date(Date.parse(row.createdAt) + ROW_LIFETIME_MS).toISOString();
}

function isExpired(now: Date) {
  return lte(notificationOutbox.createdAt, expiredBefore(now));
}

function isDue(now: Date) {
  return and(
    eq(notificationOutbox.status, OutboxRowStatus.Waiting),
    or(
      isNull(notificationOutbox.nextAttemptAt),
      lte(notificationOutbox.nextAttemptAt, now.toISOString())
    )
  );
}

function toTrigger(row: OutboxRow): KnockTrigger {
  return {
    workflow: row.workflow,
    recipients: row.recipients,
    actor: row.actor,
    data: row.data,
    idempotencyKey: row.idempotencyKey,
  };
}

export function createNotificationSender(
  db: Db,
  transport: NotificationTransport,
  log: Pick<Console, "error"> = console
): NotificationSender {
  // Rows being sent right now. The route's send and the sweep can pick up the
  // same row; whichever claims it first sends it.
  const inFlight = new Set<number>();

  return {
    async send(rowIds, now) {
      if (rowIds.length === 0) return;
      await sendRows(
        db
          .select()
          .from(notificationOutbox)
          .where(and(inArray(notificationOutbox.id, rowIds), isDue(now)))
          .orderBy(asc(notificationOutbox.id))
          .all(),
        now
      );
    },

    async sweep(now) {
      // Expired rows are picked up whatever their status, to be dropped.
      await sendRows(
        db
          .select()
          .from(notificationOutbox)
          .where(or(isDue(now), isExpired(now)))
          .orderBy(asc(notificationOutbox.id))
          .all(),
        now
      );
    },

    async resend(rowId, now) {
      const parked = db
        .select()
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.id, rowId),
            eq(notificationOutbox.status, OutboxRowStatus.Parked)
          )
        )
        .get();
      if (!parked) return "not parked";
      const [row] = dropExpired([parked], now);
      if (!row) return "expired";

      // It's sent while still parked, so the sweep can't pick it up as well.
      // Its attempts count again from 0, for another hour of retries.
      inFlight.add(row.id);
      try {
        return await sendRow({ ...row, attempts: 0 }, now);
      } finally {
        inFlight.delete(row.id);
      }
    },
  };

  // Claims every row before the first await, so nothing else can start one.
  async function sendRows(rows: OutboxRow[], now: Date) {
    const claimed = dropExpired(rows, now).filter(
      (row) => !inFlight.has(row.id)
    );
    for (const row of claimed) inFlight.add(row.id);

    for (const row of claimed) {
      try {
        await sendRow(row, now);
      } finally {
        inFlight.delete(row.id);
      }
    }
  }

  /**
   * Deletes the rows that are 24 hours old, waiting or parked, without sending
   * them, and logs each one. A stale Notification is worse than a missing one,
   * and Knock forgets an idempotency key after 24 hours. Returns the rest.
   */
  function dropExpired(rows: OutboxRow[], now: Date): OutboxRow[] {
    const cutoff = expiredBefore(now);
    const live: OutboxRow[] = [];
    for (const row of rows) {
      if (row.createdAt > cutoff) {
        live.push(row);
        continue;
      }
      // A send already under way gets to finish.
      if (inFlight.has(row.id)) continue;
      db.delete(notificationOutbox)
        .where(eq(notificationOutbox.id, row.id))
        .run();
      log.error(
        `Outbox row ${row.id} (${row.workflow}) was dropped without being sent: it was written 24 hours ago, at ${row.createdAt}, and was still ${row.status} after ${row.attempts} failed attempts.`
      );
    }
    return live;
  }

  async function sendRow(row: OutboxRow, now: Date): Promise<SendOutcome> {
    try {
      await transport.send(toTrigger(row));
    } catch (error) {
      const attempts = row.attempts + 1;
      const failure = describeSendFailure(error);
      const outboxRow = `Outbox row ${row.id} (${row.workflow})`;

      if (!mightPassOnRetry(error) || attempts >= MAX_ATTEMPTS) {
        db.update(notificationOutbox)
          .set({
            status: OutboxRowStatus.Parked,
            attempts,
            nextAttemptAt: null,
          })
          .where(eq(notificationOutbox.id, row.id))
          .run();
        const why = mightPassOnRetry(error)
          ? `was parked after ${attempts} attempts`
          : "was rejected and parked";
        log.error(
          `${outboxRow} ${why}: ${failure}. Re-send it before ${expiresAt(row)} with: npm run notifications:resend -- ${row.id}`,
          error
        );
        return "parked";
      }

      const nextAttemptAt = retryAt(attempts, now);
      db.update(notificationOutbox)
        .set({ status: OutboxRowStatus.Waiting, attempts, nextAttemptAt })
        .where(eq(notificationOutbox.id, row.id))
        .run();
      log.error(
        `${outboxRow} failed to send (attempt ${attempts} of ${MAX_ATTEMPTS}): ${failure}. It will be retried after ${nextAttemptAt}.`,
        error
      );
      return "retrying";
    }

    db.delete(notificationOutbox)
      .where(eq(notificationOutbox.id, row.id))
      .run();
    return "sent";
  }
}

// ─── The server's sender ───

const SWEEP_INTERVAL_MS = 30_000;

type RunningSender = { sender: NotificationSender; timer: NodeJS.Timeout };

// Kept on globalThis so the dev server's module reloads replace the sweep
// timer instead of stacking another one each time.
const running = globalThis as typeof globalThis & {
  __cadenceNotificationSender?: RunningSender;
};

/**
 * Picks the transport from the environment, starts the ~30s sweep, and sweeps
 * once straight away for rows the last run left behind. Throws if Production
 * is misconfigured, so the server refuses to start. Called once, from
 * entry.server.tsx.
 */
export function startNotificationSender(
  env: SenderEnv = process.env
): NotificationSender {
  const previous = running.__cadenceNotificationSender;
  if (previous) clearInterval(previous.timer);

  const sender = createNotificationSender(
    serverDb,
    createTransport(chooseTransport(env))
  );
  const sweep = () =>
    sender.sweep(new Date()).catch((error) => {
      console.error("The notification outbox sweep failed.", error);
    });
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref();
  running.__cadenceNotificationSender = { sender, timer };

  void sweep();
  return sender;
}

/**
 * For routes, after the domain function's transaction has committed: starts
 * sending these outbox rows without waiting for them. Never throws, so the
 * action succeeds whatever happens to the send; the sweep retries failures.
 * Routes leave out `sender` to use the server's; tests pass their own.
 */
export function sendInBackground(
  rowIds: number[],
  sender?: NotificationSender
): void {
  if (rowIds.length === 0) return;
  // Inside the promise chain, so even a sender that can't start only logs.
  Promise.resolve()
    .then(() => {
      const chosen =
        sender ??
        running.__cadenceNotificationSender?.sender ??
        startNotificationSender();
      return chosen.send(rowIds, new Date());
    })
    .catch((error) => {
      console.error(`Sending outbox rows ${rowIds.join(", ")} failed.`, error);
    });
}
