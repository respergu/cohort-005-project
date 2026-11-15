import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "~/test/setup";
import {
  fakeNotificationTransport,
  type FakeNotificationTransport,
} from "~/test/fake-notification-transport";
import type { NotificationUser } from "~/db/schema";
import { listOutboxRows } from "~/test/outbox";
import { queueNotification } from "./notification-outbox.server";
import {
  createNotificationSender,
  sendInBackground,
} from "./notification-sender.server";
import {
  folderTransport,
  type NotificationTransport,
} from "./notification-transports.server";

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

function secondsLater(seconds: number) {
  return new Date(NOW.getTime() + seconds * 1000);
}

const quietLog = { error: () => {} };

function recordingLog() {
  const messages: string[] = [];
  return {
    messages,
    error: (message: unknown) => messages.push(String(message)),
  };
}

/** The server's sweep, every 30s from `from` minutes after NOW to `to`. */
async function sweepEvery30Seconds(
  sender: ReturnType<typeof createNotificationSender>,
  { from, to }: { from: number; to: number }
) {
  for (let seconds = from * 60 + 30; seconds <= to * 60; seconds += 30) {
    await sender.sweep(secondsLater(seconds));
  }
}

/** Queues a row and has Knock reject it, so it's parked. */
async function queueParkedRow(
  db: ReturnType<typeof createTestDb>,
  sender: ReturnType<typeof createNotificationSender>,
  transport: ReturnType<typeof fakeNotificationTransport>
) {
  const [rowId] = queueRefundRequestRaised(db);
  transport.respondWith(400);
  await sender.send([rowId], NOW);
  transport.recover();
  expect(listOutboxRows(db)).toMatchObject([{ id: rowId, status: "parked" }]);
  return rowId;
}

describe("the notification sender", () => {
  it("hands the whole trigger to the transport and deletes the row once it's accepted", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const rowIds = queueRefundRequestRaised(db);
    const [{ idempotencyKey }] = listOutboxRows(db);

    await createNotificationSender(db, transport, quietLog).send(rowIds, NOW);

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
      rowIds,
      NOW
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
    }).send([rowId], NOW);

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
    await sender.send([failedRowId], NOW);
    // This one was committed, but the server stopped before sending it.
    queueRefundRequestRaised(db);
    const idempotencyKeys = listOutboxRows(db).map((row) => row.idempotencyKey);
    transport.recover();

    await sender.sweep(secondsLater(30));

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

    await Promise.all([sender.send(rowIds, NOW), sender.sweep(NOW)]);

    expect(transport.attempts).toHaveLength(1);
    expect(listOutboxRows(db)).toEqual([]);
  });
});

// #45 and #48: an action that writes an outbox row succeeds even when every
// send fails. The route hands its rows to sendInBackground after the commit.
describe("sending in the background, as a route does", () => {
  const unhandledRejections: unknown[] = [];
  const recordUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  beforeEach(() => {
    unhandledRejections.length = 0;
    process.on("unhandledRejection", recordUnhandledRejection);
  });
  afterEach(() => {
    process.off("unhandledRejection", recordUnhandledRejection);
  });

  function failingFake(fail: (transport: FakeNotificationTransport) => void) {
    return () => {
      const transport = fakeNotificationTransport();
      fail(transport);
      return transport;
    };
  }

  const throwsSynchronously: NotificationTransport = {
    send() {
      throw new Error("The transport blew up before it could send.");
    },
  };

  it.each<{
    failure: string;
    transport: () => NotificationTransport;
    status: "waiting" | "parked";
  }>([
    {
      failure: "a 5xx",
      transport: failingFake((t) => t.respondWith(503)),
      status: "waiting",
    },
    {
      failure: "a 4xx",
      transport: failingFake((t) => t.respondWith(400)),
      status: "parked",
    },
    {
      failure: "a timeout",
      transport: failingFake((t) => t.timeOut()),
      status: "waiting",
    },
    {
      failure: "a lost connection",
      transport: failingFake((t) => t.loseConnection()),
      status: "waiting",
    },
    {
      failure: "a synchronous throw",
      transport: () => throwsSynchronously,
      status: "waiting",
    },
  ])(
    "never throws or rejects when the send fails with $failure, and leaves the row $status",
    async ({ transport, status }) => {
      const db = createTestDb();
      // sendInBackground sends with the real clock, so the row is written
      // with it too, or it would already be 24 hours old.
      const [rowId] = queueNotification(
        db,
        "refund-request-raised",
        [platformAdmin],
        buyer,
        DATA,
        new Date()
      );
      const sender = createNotificationSender(db, transport(), quietLog);

      expect(() => sendInBackground([rowId], sender)).not.toThrow();

      await vi.waitFor(() =>
        expect(listOutboxRows(db)).toMatchObject([
          { id: rowId, status, attempts: 1 },
        ])
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    }
  );
});

describe("retrying a send that might pass", () => {
  it.each([408, 429, 500, 503])(
    "retries a %i once its backoff is over, with the same idempotency key",
    async (status) => {
      const db = createTestDb();
      const transport = fakeNotificationTransport();
      const sender = createNotificationSender(db, transport, quietLog);
      const [rowId] = queueRefundRequestRaised(db);
      const [{ idempotencyKey }] = listOutboxRows(db);
      transport.respondWith(status);

      await sender.send([rowId], NOW);
      await sender.sweep(secondsLater(29));
      expect(transport.attempts).toHaveLength(1);

      transport.recover();
      await sender.sweep(secondsLater(30));

      expect(
        transport.attempts.map((trigger) => trigger.idempotencyKey)
      ).toEqual([idempotencyKey, idempotencyKey]);
      expect(transport.accepted).toHaveLength(1);
      expect(listOutboxRows(db)).toEqual([]);
    }
  );

  it.each([
    ["a send that timed out", "timeOut"],
    ["a send that never reached Knock", "loseConnection"],
  ] as const)("retries %s", async (_, failure) => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    const [rowId] = queueRefundRequestRaised(db);
    transport[failure]();

    await sender.send([rowId], NOW);
    transport.recover();
    await sender.sweep(secondsLater(30));

    expect(transport.attempts).toHaveLength(2);
    expect(transport.accepted).toHaveLength(1);
    expect(listOutboxRows(db)).toEqual([]);
  });
});

describe("parking a send Knock rejects", () => {
  it("logs the row id, the workflow and Knock's response when Knock rejects it", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const log = recordingLog();
    const sender = createNotificationSender(db, transport, log);
    const [rowId] = queueRefundRequestRaised(db);
    transport.respondWith(422, {
      code: "trigger_data_invalid",
      message: "course_title is missing",
      status: 422,
      type: "invalid_request_error",
    });

    await sender.send([rowId], NOW);

    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toContain(
      `Outbox row ${rowId} (refund-request-raised)`
    );
    expect(log.messages[0]).toContain("parked");
    expect(log.messages[0]).toContain(
      '422 {"code":"trigger_data_invalid","message":"course_title is missing","status":422,"type":"invalid_request_error"}'
    );
  });

  it("logs the row id, the workflow and Knock's last response when its retries run out", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const log = recordingLog();
    const sender = createNotificationSender(db, transport, log);
    const [rowId] = queueRefundRequestRaised(db);
    transport.respondWith(503, { code: "unavailable", message: "Down" });

    await sender.send([rowId], NOW);
    await sweepEvery30Seconds(sender, { from: 0, to: 2 * 60 });

    const parked = log.messages.at(-1);
    expect(parked).toContain(`Outbox row ${rowId} (refund-request-raised)`);
    expect(parked).toContain("parked after 8 attempts");
    expect(parked).toContain('503 {"code":"unavailable","message":"Down"}');
  });

  it("backs off exponentially for about an hour, then parks the row", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    const [rowId] = queueRefundRequestRaised(db);
    transport.respondWith(503);

    // The route's send, then the server's sweep every 30s for two hours.
    const attemptedAt: number[] = [];
    await sender.send([rowId], NOW);
    attemptedAt.push(0);
    for (let seconds = 30; seconds <= 2 * 60 * 60; seconds += 30) {
      const before = transport.attempts.length;
      await sender.sweep(secondsLater(seconds));
      if (transport.attempts.length > before) attemptedAt.push(seconds / 60);
    }

    expect(attemptedAt).toEqual([0, 0.5, 1.5, 3.5, 7.5, 15.5, 31.5, 63.5]);
    expect(listOutboxRows(db)).toMatchObject([
      { id: rowId, status: "parked", attempts: 8 },
    ]);
  });

  it.each([400, 401, 404, 409, 422])(
    "parks the row at once on a %i, and doesn't retry it",
    async (status) => {
      const db = createTestDb();
      const transport = fakeNotificationTransport();
      const sender = createNotificationSender(db, transport, quietLog);
      const [rowId] = queueRefundRequestRaised(db);
      transport.respondWith(status);

      await sender.send([rowId], NOW);
      transport.recover();
      await sender.sweep(secondsLater(60 * 60));

      expect(transport.attempts).toHaveLength(1);
      expect(listOutboxRows(db)).toMatchObject([
        { id: rowId, status: "parked" },
      ]);
    }
  );
});

describe("expiring a row 24 hours after it was written", () => {
  const ONE_DAY = 24 * 60 * 60;

  it.each(["waiting", "parked"] as const)(
    "deletes a %s row without sending it, and logs that it did",
    async (status) => {
      const db = createTestDb();
      const transport = fakeNotificationTransport();
      const log = recordingLog();
      const sender = createNotificationSender(db, transport, log);
      const [rowId] = queueRefundRequestRaised(db);
      if (status === "parked") {
        transport.respondWith(400);
        await sender.send([rowId], NOW);
        transport.recover();
      }
      expect(listOutboxRows(db)).toMatchObject([{ id: rowId, status }]);
      const attemptsBefore = transport.attempts.length;

      await sender.sweep(secondsLater(ONE_DAY));

      expect(transport.attempts).toHaveLength(attemptsBefore);
      expect(listOutboxRows(db)).toEqual([]);
      expect(log.messages.at(-1)).toContain(
        `Outbox row ${rowId} (refund-request-raised)`
      );
      expect(log.messages.at(-1)).toContain("24 hours");
    }
  );

  it("still sends a row a moment before it's 24 hours old", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    queueRefundRequestRaised(db);

    await sender.sweep(secondsLater(ONE_DAY - 1));

    expect(transport.accepted).toHaveLength(1);
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("doesn't send an expired row the route asks for either", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    const rowIds = queueRefundRequestRaised(db);

    await sender.send(rowIds, secondsLater(ONE_DAY));

    expect(transport.attempts).toEqual([]);
    expect(listOutboxRows(db)).toEqual([]);
  });
});

describe("re-sending a parked row", () => {
  it("sends it again with its original idempotency key, and deletes it once Knock accepts it", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    const rowId = await queueParkedRow(db, sender, transport);
    const [{ idempotencyKey }] = listOutboxRows(db);

    const outcome = await sender.resend(rowId, secondsLater(10 * 60));

    expect(outcome).toBe("sent");
    expect(transport.accepted.map((trigger) => trigger.idempotencyKey)).toEqual(
      [idempotencyKey]
    );
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("puts it back into the normal retries when the re-send fails", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    const rowId = await queueParkedRow(db, sender, transport);
    const [{ idempotencyKey }] = listOutboxRows(db);
    transport.respondWith(503);

    const outcome = await sender.resend(rowId, secondsLater(10 * 60));
    expect(outcome).toBe("retrying");
    expect(listOutboxRows(db)).toMatchObject([
      { id: rowId, status: "waiting" },
    ]);
    await sweepEvery30Seconds(sender, { from: 10, to: 10 + 2 * 60 });

    // The parked send, then the re-send and its seven retries.
    expect(transport.attempts.map((trigger) => trigger.idempotencyKey)).toEqual(
      Array(9).fill(idempotencyKey)
    );
    expect(listOutboxRows(db)).toMatchObject([
      { id: rowId, status: "parked", attempts: 8 },
    ]);
  });

  it("still drops it 24 hours after it was first written", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const log = recordingLog();
    const sender = createNotificationSender(db, transport, log);
    const rowId = await queueParkedRow(db, sender, transport);
    transport.respondWith(503);

    await sender.resend(rowId, secondsLater(23 * 60 * 60 + 59 * 60));
    transport.recover();
    await sender.sweep(secondsLater(24 * 60 * 60));

    expect(transport.accepted).toEqual([]);
    expect(listOutboxRows(db)).toEqual([]);
    expect(log.messages.at(-1)).toContain(`Outbox row ${rowId}`);
    expect(log.messages.at(-1)).toContain("24 hours");
  });

  it("drops a parked row that's 24 hours old instead of re-sending it", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    const rowId = await queueParkedRow(db, sender, transport);

    const outcome = await sender.resend(rowId, secondsLater(24 * 60 * 60));

    expect(outcome).toBe("expired");
    expect(transport.accepted).toEqual([]);
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("leaves a row that isn't parked alone", async () => {
    const db = createTestDb();
    const transport = fakeNotificationTransport();
    const sender = createNotificationSender(db, transport, quietLog);
    const [waitingRowId] = queueRefundRequestRaised(db);

    expect(await sender.resend(waitingRowId, NOW)).toBe("not parked");
    expect(await sender.resend(waitingRowId + 1, NOW)).toBe("not parked");
    expect(transport.attempts).toEqual([]);
    expect(listOutboxRows(db)).toMatchObject([
      { id: waitingRowId, status: "waiting" },
    ]);
  });
});
