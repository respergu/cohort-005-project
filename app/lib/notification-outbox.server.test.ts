import { describe, expect, it } from "vitest";
import { createTestDb } from "~/test/setup";
import type { NotificationUser } from "~/db/schema";
import { listOutboxRows, queueNotification } from "./notification-outbox.server";

const NOW = new Date(2026, 9, 6, 12, 0, 0);

const buyer: NotificationUser = {
  id: "8d1c0c1e-2f4b-4c55-9a59-6f0f8c1b2a01",
  name: "Liam",
  email: "liam@example.com",
};

const VALID_DATA = {
  buyer_name: "Liam",
  course_title: "Test Course",
  reason: "It was not what I expected.",
  path: "/admin/refunds",
};

function platformAdmins(count: number): NotificationUser[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `admin-${i}`,
    name: `Admin ${i}`,
    email: `admin-${i}@example.com`,
  }));
}

describe("queueNotification", () => {
  it("throws before writing anything when the data breaks the workflow's schema", () => {
    const db = createTestDb();

    expect(() =>
      queueNotification(
        db,
        "refund-request-raised",
        platformAdmins(1),
        buyer,
        { ...VALID_DATA, path: "admin/refunds" },
        NOW
      )
    ).toThrow();
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("writes nothing when the actor was the only one to tell", () => {
    const db = createTestDb();

    const rowIds = queueNotification(
      db,
      "refund-request-raised",
      [buyer],
      buyer,
      VALID_DATA,
      NOW
    );

    expect(rowIds).toEqual([]);
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("splits an audience of more than 1,000 across rows, each with its own idempotency key", () => {
    const db = createTestDb();

    queueNotification(
      db,
      "refund-request-raised",
      platformAdmins(2001),
      buyer,
      VALID_DATA,
      NOW
    );

    const rows = listOutboxRows(db);
    expect(rows.map((row) => row.recipients.length)).toEqual([1000, 1000, 1]);
    expect(rows.map((row) => row.recipients[0].id)).toEqual([
      "admin-0",
      "admin-1000",
      "admin-2000",
    ]);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(3);
  });
});
