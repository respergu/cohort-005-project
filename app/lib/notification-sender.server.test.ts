import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb } from "~/test/setup";
import { fakeNotificationTransport } from "~/test/fake-notification-transport";
import type { NotificationUser } from "~/db/schema";
import { listOutboxRows, queueNotification } from "./notification-outbox.server";
import { createNotificationSender } from "./notification-sender.server";
import { folderTransport } from "./notification-transports.server";

const NOW = new Date(2026, 9, 6, 12, 0, 0);

const buyer: NotificationUser = {
  id: "buyer-knock-id",
  name: "Liam",
  email: "liam@example.com",
};
const platformAdmin: NotificationUser = {
  id: "admin-knock-id",
  name: "Pat Admin",
  email: "pat@example.com",
};

const DATA = {
  buyer_name: "Liam",
  course_title: "Test Course",
  reason: "It was not what I expected.",
  path: "/admin/refunds",
};

function queueRefundRequestRaised(db: ReturnType<typeof createTestDb>) {
  return queueNotification(
    db,
    "refund-request-raised",
    [platformAdmin],
    buyer,
    DATA,
    NOW
  );
}

const quietLog = { error: () => {} };

describe("the notification sender", () => {
  it("hands the whole trigger to the transport and deletes the row once it's accepted", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const rowIds = queueRefundRequestRaised(db);
    const [{ idempotencyKey }] = listOutboxRows(db);

    await createNotificationSender(db, transport, quietLog).send(rowIds);

    expect(transport.accepted).toEqual([
      {
        workflow: "refund-request-raised",
        recipients: [platformAdmin],
        actor: buyer,
        data: DATA,
        idempotencyKey,
      },
    ]);
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("writes the trigger to the folder as JSON, then deletes the row", async () => {
    const db = createTestDb();
    const directory = mkdtempSync(join(tmpdir(), "notifications-"));
    const rowIds = queueRefundRequestRaised(db);
    const [{ idempotencyKey }] = listOutboxRows(db);

    await createNotificationSender(db, folderTransport(directory), quietLog).send(
      rowIds
    );

    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(directory, files[0]), "utf8"))).toEqual({
      workflow: "refund-request-raised",
      recipients: [platformAdmin],
      actor: buyer,
      data: DATA,
      idempotencyKey,
    });
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("leaves a row waiting when its send fails, and logs it", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    transport.failWith(new Error("Knock is down"));
    const errors: unknown[][] = [];
    const [rowId] = queueRefundRequestRaised(db);

    await createNotificationSender(db, transport, {
      error: (...args: unknown[]) => errors.push(args),
    }).send([rowId]);

    expect(listOutboxRows(db)).toMatchObject([
      { id: rowId, status: "waiting", attempts: 1 },
    ]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toContain(`${rowId}`);
  });

  it("sweeps up rows that a failed send or a crash left behind", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    transport.failWith(new Error("Knock is down"));
    const [failedRowId] = queueRefundRequestRaised(db);
    await sender.send([failedRowId]);
    // This one was committed, but the server stopped before sending it.
    queueRefundRequestRaised(db);
    const idempotencyKeys = listOutboxRows(db).map((row) => row.idempotencyKey);
    transport.recover();

    await sender.sweep();

    expect(transport.accepted.map((trigger) => trigger.idempotencyKey)).toEqual(
      idempotencyKeys
    );
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("doesn't send a row twice when the sweep runs while it's being sent", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    const rowIds = queueRefundRequestRaised(db);

    await Promise.all([sender.send(rowIds), sender.sweep()]);

    expect(transport.attempts).toHaveLength(1);
    expect(listOutboxRows(db)).toEqual([]);
  });
});
