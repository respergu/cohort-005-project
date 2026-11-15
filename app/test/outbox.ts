import { asc } from "drizzle-orm";
import { notificationOutbox } from "~/db/schema";
import type { Queryable } from "~/db/types";
import type { OutboxRow } from "~/lib/notification-outbox.server";

/** Every row still in the outbox, waiting or parked, oldest first. */
export function listOutboxRows(db: Queryable): OutboxRow[] {
  return db
    .select()
    .from(notificationOutbox)
    .orderBy(asc(notificationOutbox.id))
    .all();
}
