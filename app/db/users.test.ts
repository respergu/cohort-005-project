import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle"
);

/** A copy of the migrations folder holding only the ones before `tagPrefix`. */
function migrationsBefore(tagPrefix: string) {
  const folder = mkdtempSync(path.join(tmpdir(), "migrations-"));
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = path.join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const cut = journal.entries.findIndex((entry: { tag: string }) =>
    entry.tag.startsWith(tagPrefix)
  );
  if (cut === -1) throw new Error(`No migration starts with ${tagPrefix}`);
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

describe("Knock ids", () => {
  it("gives every new user their own random Knock id", () => {
    const db = createTestDb();

    const [liam, priya] = db
      .insert(schema.users)
      .values([
        { name: "Liam", email: "liam@example.com", role: UserRole.Student },
        { name: "Priya", email: "priya@example.com", role: UserRole.Admin },
      ])
      .returning()
      .all();

    expect(liam.knockId).toMatch(UUID);
    expect(priya.knockId).toMatch(UUID);
    expect(liam.knockId).not.toBe(priya.knockId);
  });

  it("fills in a Knock id for users who existed before the migration", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsBefore("0012_") });
    const insertUser = sqlite.prepare(
      "INSERT INTO users (name, email, role, created_at) VALUES (?, ?, 'student', ?)"
    );
    insertUser.run("Liam", "liam@example.com", "2026-01-01T00:00:00.000Z");
    insertUser.run("Priya", "priya@example.com", "2026-01-01T00:00:00.000Z");

    migrate(db, { migrationsFolder });

    const knockIds = db
      .select({ knockId: schema.users.knockId })
      .from(schema.users)
      .all()
      .map((row) => row.knockId);
    expect(knockIds).toHaveLength(2);
    for (const knockId of knockIds) expect(knockId).toMatch(UUID);
    expect(new Set(knockIds).size).toBe(2);
  });
});
