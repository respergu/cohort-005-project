import { asc } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "~/db/schema";
import { notificationOutbox, type NotificationUser } from "~/db/schema";
import {
  notificationWorkflows,
  type WorkflowData,
  type WorkflowKey,
} from "~/lib/notification-workflows";

// ─── Writing Notifications to the outbox ───
// A domain function that records an event also queues its Notifications here,
// inside the same transaction, so the event and its rows commit or roll back
// together. Domain functions never send: after the commit, the route hands the
// returned row ids to sendInBackground (notification-sender.server.ts).
// See docs/adr/0014 and docs/adr/0015.

type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

/** Knock takes at most this many recipients in one trigger. */
export const MAX_RECIPIENTS_PER_TRIGGER = 1000;

/** A user as a trigger names them: Knock id, name and email, nothing else. */
export function toNotificationUser(user: {
  knockId: string;
  name: string;
  email: string;
}): NotificationUser {
  return { id: user.knockId, name: user.name, email: user.email };
}

/**
 * Queues one Notification. Throws, before writing anything, if `data` doesn't
 * match the workflow's schema, which rolls back the caller's transaction.
 *
 * The actor is removed from the recipients. An audience of more than 1,000 is
 * split across several rows, each with its own idempotency key, and an empty
 * one writes nothing. Returns the ids of the rows written.
 */
export function queueNotification<K extends WorkflowKey>(
  tx: Queryable,
  workflow: K,
  recipients: NotificationUser[],
  actor: NotificationUser | null,
  data: WorkflowData<K>,
  now: Date
): number[] {
  const checkedData = notificationWorkflows[workflow].parse(data);
  const audience = recipients.filter((recipient) => recipient.id !== actor?.id);

  const rowIds: number[] = [];
  for (
    let start = 0;
    start < audience.length;
    start += MAX_RECIPIENTS_PER_TRIGGER
  ) {
    const row = tx
      .insert(notificationOutbox)
      .values({
        workflow,
        recipients: audience.slice(start, start + MAX_RECIPIENTS_PER_TRIGGER),
        actor,
        data: checkedData,
        createdAt: now.toISOString(),
      })
      .returning({ id: notificationOutbox.id })
      .get();
    rowIds.push(row.id);
  }
  return rowIds;
}

export type OutboxRow = typeof notificationOutbox.$inferSelect;

/** Every row still in the outbox, waiting or parked, oldest first. */
export function listOutboxRows(db: Queryable): OutboxRow[] {
  return db
    .select()
    .from(notificationOutbox)
    .orderBy(asc(notificationOutbox.id))
    .all();
}
