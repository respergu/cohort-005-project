import { eq } from "drizzle-orm";
import { users } from "~/db/schema";
import type { Queryable } from "~/db/types";

/** A user by id, inside a transaction or out of one. */
export function getUser(db: Queryable, userId: number) {
  return db.select().from(users).where(eq(users.id, userId)).get();
}
