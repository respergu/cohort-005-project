import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "~/db/schema";
import { notificationOutbox, OutboxRowStatus } from "~/db/schema";
import { db as serverDb } from "~/db";
import type { OutboxRow } from "~/lib/notification-outbox.server";
import {
  chooseTransport,
  createTransport,
  type KnockTrigger,
  type NotificationTransport,
  type SenderEnv,
} from "~/lib/notification-transports.server";

// ─── Sending the outbox ───
// Hands waiting outbox rows to a transport and deletes each row the transport
// accepts. It runs in the server process: routes start it on the rows they
// just committed, and a timer sweeps every ~30s for rows a failure or a crash
// left behind. Domain functions never call it. See docs/adr/0014.

type Db = BetterSQLite3Database<typeof schema>;

export type NotificationSender = {
  /** Sends these rows, if they are still waiting. */
  send(rowIds: number[]): Promise<void>;
  /** Sends every waiting row, such as one a failure or a crash left behind. */
  sweep(): Promise<void>;
};

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
    async send(rowIds) {
      if (rowIds.length === 0) return;
      await sendRows(
        db
          .select()
          .from(notificationOutbox)
          .where(
            and(
              inArray(notificationOutbox.id, rowIds),
              eq(notificationOutbox.status, OutboxRowStatus.Waiting)
            )
          )
          .orderBy(asc(notificationOutbox.id))
          .all()
      );
    },

    async sweep() {
      await sendRows(
        db
          .select()
          .from(notificationOutbox)
          .where(eq(notificationOutbox.status, OutboxRowStatus.Waiting))
          .orderBy(asc(notificationOutbox.id))
          .all()
      );
    },
  };

  // Claims every row before the first await, so nothing else can start one.
  async function sendRows(rows: OutboxRow[]) {
    const claimed = rows.filter((row) => !inFlight.has(row.id));
    for (const row of claimed) inFlight.add(row.id);

    for (const row of claimed) {
      try {
        await sendRow(row);
      } finally {
        inFlight.delete(row.id);
      }
    }
  }

  async function sendRow(row: OutboxRow) {
    try {
      await transport.send(toTrigger(row));
    } catch (error) {
      // Backoff and parking come later (#44). Until then the row waits and
      // the sweep tries it again.
      db.update(notificationOutbox)
        .set({ attempts: sql`${notificationOutbox.attempts} + 1` })
        .where(eq(notificationOutbox.id, row.id))
        .run();
      log.error(
        `Outbox row ${row.id} (${row.workflow}) failed to send and is still waiting.`,
        error
      );
      return;
    }

    db.delete(notificationOutbox)
      .where(eq(notificationOutbox.id, row.id))
      .run();
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
    sender.sweep().catch((error) => {
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
 */
export function sendInBackground(rowIds: number[]): void {
  if (rowIds.length === 0) return;
  // Inside the promise chain, so even a sender that can't start only logs.
  Promise.resolve()
    .then(() => {
      const sender =
        running.__cadenceNotificationSender?.sender ??
        startNotificationSender();
      return sender.send(rowIds);
    })
    .catch((error) => {
      console.error(`Sending outbox rows ${rowIds.join(", ")} failed.`, error);
    });
}
