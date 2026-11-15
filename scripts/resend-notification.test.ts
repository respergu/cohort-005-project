import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../app/db/schema";
import { queueNotification } from "../app/lib/notification-outbox.server";
import { createNotificationSender } from "../app/lib/notification-sender.server";
import { fakeNotificationTransport } from "../app/test/fake-notification-transport";
import { listOutboxRows } from "../app/test/outbox";

// `npm run notifications:resend -- <row id>` is run the way an operator runs
// it, against a data.db in a scratch directory. Sending is off, so the row
// goes to that directory's .outbox/notifications/ folder, never to Knock.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/resend-notification.ts");
const TSX = join(ROOT, "node_modules/.bin/tsx");

let directory: string;
let db: ReturnType<typeof openDb>;

function openDb() {
  const sqlite = new Database(join(directory, "data.db"));
  const opened = drizzle(sqlite, { schema });
  migrate(opened, { migrationsFolder: join(ROOT, "drizzle") });
  return opened;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "resend-notification-"));
  db = openDb();
});

afterEach(() => {
  db.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

async function queueParkedRow() {
  const [rowId] = queueNotification(
    db,
    "refund-request-raised",
    [{ id: "admin-knock-id", name: "Pat Admin", email: "pat@example.com" }],
    { id: "buyer-knock-id", name: "Liam", email: "liam@example.com" },
    {
      buyer_name: "Liam",
      course_title: "Test Course",
      reason: "It was not what I expected.",
      path: "/admin/refunds",
    },
    new Date()
  );
  const transport = fakeNotificationTransport();
  transport.respondWith(404);
  await createNotificationSender(db, transport, { error: () => {} }).send(
    [rowId],
    new Date()
  );
  return rowId;
}

function resend(...args: string[]) {
  // spawnSync leaves out a variable that's undefined, so sending stays off.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    KNOCK_TRIGGERS: undefined,
    KNOCK_API_KEY: undefined,
  };
  return spawnSync(
    TSX,
    ["--tsconfig", join(ROOT, "tsconfig.json"), SCRIPT, ...args],
    { cwd: directory, env, encoding: "utf8" }
  );
}

describe("npm run notifications:resend", () => {
  it("re-sends a parked row with its original idempotency key", async () => {
    const rowId = await queueParkedRow();
    const [{ idempotencyKey }] = listOutboxRows(db);

    const run = resend(String(rowId));

    expect(run.stdout).toContain(`Sent outbox row ${rowId}`);
    expect(run.status).toBe(0);
    const folder = join(directory, ".outbox/notifications");
    const [file] = readdirSync(folder);
    expect(JSON.parse(readFileSync(join(folder, file), "utf8"))).toMatchObject({
      workflow: "refund-request-raised",
      idempotencyKey,
    });
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("refuses a row id that isn't a number", () => {
    const run = resend("twelve");

    expect(run.stderr).toContain("npm run notifications:resend -- <row id>");
    expect(run.status).toBe(1);
  });
});
