import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema";

// The database types every domain function takes, declared once. Type-only,
// so importing them never opens data.db.

/** Cadence's database: data.db on the server, or an in-memory one in tests. */
export type Db = BetterSQLite3Database<typeof schema>;

/** What a `db.transaction((tx) => …)` callback is handed. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Either one, for a query that runs inside or outside a transaction. */
export type Queryable = Db | Tx;
