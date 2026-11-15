import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { LessonProgressStatus, RefundStatus, UserRole } from "~/db/schema";
import {
  approveRefundRequest,
  checkRefundRequest,
  declineRefundRequest,
  getRefundOffer,
  getSeatAvailability,
  listRefundRequestsForBuyer,
  listRefundRequestsForReview,
  listTeamLicences,
  raiseRefundRequest,
} from "./refunds.server";
import { listOutboxRows } from "./notification-outbox.server";
import { createNotificationSender } from "./notification-sender.server";
import {
  fakeNotificationTransport,
  type FakeNotificationTransport,
} from "~/test/fake-notification-transport";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function daysBefore(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let platformAdmin: typeof schema.users.$inferSelect;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  platformAdmin = db
    .insert(schema.users)
    .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
    .returning()
    .get();

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3, 4].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function addLearner(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function buyForSelf(userId: number, daysAgo = 3, amountPaid = 7900) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
  return purchase;
}

function buySeats(userId: number, seats: number, daysAgo = 3) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid: 7900 * seats,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
  const seatRows = Array.from({ length: seats }, (_, i) =>
    db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `SEAT-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .returning()
      .get()
  );
  return { purchase, seats: seatRows };
}

function claimSeat(seatId: number, userId: number) {
  db.update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: daysBefore(1) })
    .where(eq(schema.coupons.id, seatId))
    .run();
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

function isEnrolled(userId: number) {
  return !!db
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .get();
}

function raise(purchaseId: number, buyerId: number) {
  const result = raiseRefundRequest(
    db,
    purchaseId,
    buyerId,
    "It was not what I expected.",
    NOW
  );
  if (!result.ok) throw new Error(result.error);
  return result.refundRequestId;
}

function getSeat(seatId: number) {
  const seat = db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.id, seatId))
    .get();
  if (!seat) throw new Error("Seat not found");
  return seat;
}

describe("raising a Refund Request", () => {
  it("lets the buyer raise one on an Individual Purchase inside the window", () => {
    const purchase = buyForSelf(base.user.id);

    const result = raiseRefundRequest(db, purchase.id, base.user.id, "Nope.", NOW);

    expect(result).toMatchObject({ ok: true, kind: "individual_purchase" });
  });

  it("refuses anyone but the buyer", () => {
    const purchase = buyForSelf(base.user.id);
    const someoneElse = addLearner("Ben");

    expect(checkRefundRequest(db, purchase.id, someoneElse.id, NOW)).toMatchObject(
      { ok: false, status: 404 }
    );
  });

  it("allows only one Open Refund Request per Purchase", () => {
    const purchase = buyForSelf(base.user.id);
    raise(purchase.id, base.user.id);

    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW)).toMatchObject(
      { ok: false, status: 409 }
    );
  });

  it("keeps the fourteenth day open and closes the fifteenth", () => {
    const onDay14 = buyForSelf(base.user.id, 14);
    const onDay15 = buyForSelf(addLearner("Ben").id, 15);

    expect(checkRefundRequest(db, onDay14.id, onDay14.userId, NOW).ok).toBe(true);
    expect(
      checkRefundRequest(db, onDay15.id, onDay15.userId, NOW)
    ).toMatchObject({ ok: false, error: "The 14-day window has closed." });
  });

  it("refuses a buyer who has completed half the lessons", () => {
    const purchase = buyForSelf(base.user.id);
    db.insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: LessonProgressStatus.Completed,
        }))
      )
      .run();

    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW)).toMatchObject(
      { ok: false, status: 403 }
    );
  });

  it("refuses a buyer who has watched two hours", () => {
    const purchase = buyForSelf(base.user.id);
    db.insert(schema.videoWatchEvents)
      .values([
        { userId: base.user.id, lessonId: lessonIds[0], eventType: "progress", positionSeconds: 3600 },
        { userId: base.user.id, lessonId: lessonIds[1], eventType: "progress", positionSeconds: 3600 },
      ])
      .run();

    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW)).toMatchObject(
      { ok: false, status: 403 }
    );
  });

  it("refuses a Team Licence with a Claimed Seat", () => {
    const teamAdmin = addLearner("Priya");
    const { purchase, seats } = buySeats(teamAdmin.id, 3);
    claimSeat(seats[0].id, addLearner("Ben").id);

    expect(checkRefundRequest(db, purchase.id, teamAdmin.id, NOW)).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

describe("the Refund Request raised Notification", () => {
  function addPlatformAdmin(name: string) {
    return db
      .insert(schema.users)
      .values({
        name,
        email: `${name.split(" ")[0].toLowerCase()}@example.com`,
        role: UserRole.Admin,
      })
      .returning()
      .get();
  }

  it("is queued for every Platform Admin", () => {
    const sam = addPlatformAdmin("Sam Admin");
    const purchase = buyForSelf(base.user.id);

    raise(purchase.id, base.user.id);

    const [row] = listOutboxRows(db);
    expect(row.workflow).toBe("refund-request-raised");
    expect(row.recipients).toEqual([
      { id: platformAdmin.knockId, name: "Pat Admin", email: "pat@example.com" },
      { id: sam.knockId, name: "Sam Admin", email: "sam@example.com" },
    ]);
  });

  it("names the buyer as the actor, by Knock id, name and email only", () => {
    const purchase = buyForSelf(base.user.id);

    raise(purchase.id, base.user.id);

    const [row] = listOutboxRows(db);
    expect(row.actor).toEqual({
      id: base.user.knockId,
      name: "Test User",
      email: "test@example.com",
    });
  });

  it("tells them who asked, for which course, why, and where to review it", () => {
    const purchase = buyForSelf(base.user.id);

    raise(purchase.id, base.user.id);

    const [row] = listOutboxRows(db);
    expect(row.data).toEqual({
      buyer_name: "Test User",
      course_title: "Test Course",
      reason: "It was not what I expected.",
      path: "/admin/refunds",
    });
  });

  it("leaves out a Platform Admin raising one on their own Purchase", () => {
    const sam = addPlatformAdmin("Sam Admin");
    const purchase = buyForSelf(platformAdmin.id);

    raise(purchase.id, platformAdmin.id);

    const [row] = listOutboxRows(db);
    expect(row.recipients.map((recipient) => recipient.id)).toEqual([
      sam.knockId,
    ]);
  });

  it.each([
    [
      "a 429",
      (transport: FakeNotificationTransport) => transport.respondWith(429),
    ],
    [
      "a 500",
      (transport: FakeNotificationTransport) => transport.respondWith(500),
    ],
    [
      "a 400",
      (transport: FakeNotificationTransport) => transport.respondWith(400),
    ],
    [
      "a timeout",
      (transport: FakeNotificationTransport) => transport.timeOut(),
    ],
    [
      "no connection",
      (transport: FakeNotificationTransport) => transport.loseConnection(),
    ],
    [
      "an unexpected throw",
      (transport: FakeNotificationTransport) =>
        transport.failWith(
          new TypeError("Cannot read properties of undefined")
        ),
    ],
  ])(
    "keeps the Refund Request when its Notification's send gets %s",
    async (_, fail) => {
      const purchase = buyForSelf(base.user.id);
      const result = raiseRefundRequest(
        db,
        purchase.id,
        base.user.id,
        "It was not what I expected.",
        NOW
      );
      if (!result.ok) throw new Error(result.error);
      const transport = fakeNotificationTransport();
      fail(transport);

      await createNotificationSender(db, transport, { error: () => {} }).send(
        result.outboxRowIds,
        NOW
      );

      expect(transport.attempts).toHaveLength(1);
      expect(listRefundRequestsForBuyer(db, base.user.id)).toHaveLength(1);
      expect(listOutboxRows(db)).toHaveLength(1);
    }
  );

  it("keeps neither the Refund Request nor the Notification if the transaction fails", () => {
    // A course with no title breaks the workflow's schema, which throws
    // after the Refund Request has been inserted.
    db.update(schema.courses)
      .set({ title: "" })
      .where(eq(schema.courses.id, base.course.id))
      .run();
    const purchase = buyForSelf(base.user.id);

    expect(() => raise(purchase.id, base.user.id)).toThrow();

    expect(listRefundRequestsForBuyer(db, base.user.id)).toEqual([]);
    expect(listOutboxRows(db)).toEqual([]);
  });
});

describe("the refund offer on the course page", () => {
  it("offers the newest Individual Purchase, not a newer Team Licence", () => {
    const individual = buyForSelf(base.user.id, 3);
    buySeats(base.user.id, 5, 1);

    expect(getRefundOffer(db, base.user.id, base.course.id, NOW)).toMatchObject({
      purchaseId: individual.id,
      amount: 7900,
    });
  });

  it("offers nothing once the purchase has been refunded", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);
    approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    expect(getRefundOffer(db, base.user.id, base.course.id, NOW)).toBeNull();
  });
});

describe("approving a Refund Request", () => {
  it("removes the buyer's Enrollment but keeps their progress", () => {
    const purchase = buyForSelf(base.user.id);
    db.insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: lessonIds[0],
        status: LessonProgressStatus.Completed,
      })
      .run();
    const id = raise(purchase.id, base.user.id);

    const result = approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    expect(result.ok).toBe(true);
    expect(isEnrolled(base.user.id)).toBe(false);
    expect(
      db
        .select()
        .from(schema.lessonProgress)
        .where(eq(schema.lessonProgress.userId, base.user.id))
        .all()
    ).toHaveLength(1);

    const refundRequest = db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, id))
      .get();
    expect(refundRequest).toMatchObject({
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedByUserId: platformAdmin.id,
    });
  });

  it("keeps the buyer's Enrollment if they also hold a Claimed Seat for the course", () => {
    const priya = addLearner("Priya");
    const { seats } = buySeats(priya.id, 2);
    // Liam claims a Seat first, so his Enrollment came from it.
    claimSeat(seats[0].id, base.user.id);
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: daysBefore(2),
      })
      .returning()
      .get();
    const id = raise(purchase.id, base.user.id);

    approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    expect(isEnrolled(base.user.id)).toBe(true);
  });

  it("makes a Team Licence's Unclaimed Seats unclaimable", () => {
    const priya = addLearner("Priya");
    const { purchase, seats } = buySeats(priya.id, 2);
    const id = raise(purchase.id, priya.id);

    const result = approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    expect(result.ok).toBe(true);
    for (const seat of seats) {
      expect(getSeatAvailability(db, getSeat(seat.id))).toBe("refunded");
    }
  });

  it("refuses a Team Licence whose Seat was claimed after the request", () => {
    const priya = addLearner("Priya");
    const { purchase, seats } = buySeats(priya.id, 2);
    const id = raise(purchase.id, priya.id);
    // Seats are on hold while Open, but older data can still hold a claim.
    claimSeat(seats[0].id, addLearner("Ben").id);

    expect(approveRefundRequest(db, id, platformAdmin.id, null, NOW)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(getSeatAvailability(db, getSeat(seats[1].id))).toBe("on_hold");
  });

  it("lets the first decision win", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);
    approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    expect(
      declineRefundRequest(db, id, platformAdmin.id, "Too late.", NOW)
    ).toMatchObject({
      ok: false,
      status: 409,
      error: "This refund request was already approved.",
    });
  });

  it("hands back its Notifications for the route to send, and no email", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);
    const raisedRowIds = listOutboxRows(db).map((row) => row.id);

    const result = approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    expect(result).toEqual({
      ok: true,
      outboxRowIds: listOutboxRows(db)
        .map((row) => row.id)
        .filter((rowId) => !raisedRowIds.includes(rowId)),
    });
  });
});

describe("the Refund Request decided Notification", () => {
  function decidedRows() {
    return listOutboxRows(db).filter(
      (row) => row.workflow === "refund-request-decided"
    );
  }

  it("is queued for the buyer when their Refund Request is approved", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);

    approveRefundRequest(db, id, platformAdmin.id, "Sorry it didn't fit.", NOW);

    const [row] = decidedRows();
    expect(row.recipients).toEqual([
      { id: base.user.knockId, name: "Test User", email: "test@example.com" },
    ]);
    expect(row.data).toEqual({
      decision: "approved",
      note: "Sorry it didn't fit.",
      course_title: "Test Course",
      amount_paid: "$79.00",
      path: "/settings#refund-requests",
    });
  });

  it("is queued for the buyer, with the Platform Admin's note, when it's declined", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);

    declineRefundRequest(db, id, platformAdmin.id, "  You finished the course. ", NOW);

    const [row] = decidedRows();
    expect(row.recipients.map((recipient) => recipient.id)).toEqual([
      base.user.knockId,
    ]);
    expect(row.data).toEqual({
      decision: "declined",
      note: "You finished the course.",
      course_title: "Test Course",
      amount_paid: "$79.00",
      path: "/settings#refund-requests",
    });
  });

  it("leaves the note out when the approval has none", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);

    approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    const [row] = decidedRows();
    expect(row.data).not.toHaveProperty("note");
  });

  it("names the deciding Platform Admin as the actor", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);

    approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    const [row] = decidedRows();
    expect(row.actor).toEqual({
      id: platformAdmin.knockId,
      name: "Pat Admin",
      email: "pat@example.com",
    });
  });

  it("isn't queued when a Platform Admin decides a Refund Request on their own Purchase", () => {
    const purchase = buyForSelf(platformAdmin.id);
    const id = raise(purchase.id, platformAdmin.id);

    declineRefundRequest(db, id, platformAdmin.id, "Not for me.", NOW);

    expect(decidedRows()).toEqual([]);
  });

  it.each(["approve", "decline"] as const)(
    "is written in the decision's transaction, so a failed %s keeps neither",
    (decide) => {
      const purchase = buyForSelf(base.user.id);
      const id = raise(purchase.id, base.user.id);
      const raisedRows = listOutboxRows(db);
      // A course with no title breaks the workflows' schemas, which throws
      // after the decision has been written.
      db.update(schema.courses)
        .set({ title: "" })
        .where(eq(schema.courses.id, base.course.id))
        .run();

      expect(() =>
        decide === "approve"
          ? approveRefundRequest(db, id, platformAdmin.id, null, NOW)
          : declineRefundRequest(db, id, platformAdmin.id, "No.", NOW)
      ).toThrow();

      expect(listRefundRequestsForBuyer(db, base.user.id)).toMatchObject([
        { id, status: RefundStatus.Open, decisionNote: null },
      ]);
      expect(isEnrolled(base.user.id)).toBe(true);
      expect(listOutboxRows(db)).toEqual(raisedRows);
    }
  );

  it.each([
    [
      "approved",
      "a 500",
      (transport: FakeNotificationTransport) => transport.respondWith(500),
    ],
    [
      "approved",
      "a 400",
      (transport: FakeNotificationTransport) => transport.respondWith(400),
    ],
    [
      "declined",
      "a 500",
      (transport: FakeNotificationTransport) => transport.respondWith(500),
    ],
    [
      "declined",
      "no connection",
      (transport: FakeNotificationTransport) => transport.loseConnection(),
    ],
  ] as const)(
    "keeps the %s decision when its Notifications' send gets %s",
    async (decision, _, fail) => {
      const purchase = buyForSelf(base.user.id);
      const id = raise(purchase.id, base.user.id);
      const result =
        decision === "approved"
          ? approveRefundRequest(db, id, platformAdmin.id, null, NOW)
          : declineRefundRequest(db, id, platformAdmin.id, "No.", NOW);
      if (!result.ok) throw new Error(result.error);
      const transport = fakeNotificationTransport();
      fail(transport);

      await createNotificationSender(db, transport, { error: () => {} }).send(
        result.outboxRowIds,
        NOW
      );

      expect(transport.attempts.length).toBeGreaterThan(0);
      expect(listRefundRequestsForBuyer(db, base.user.id)).toMatchObject([
        { id, status: decision },
      ]);
      expect(decidedRows()).toHaveLength(1);
    }
  );
});

describe("the Refund Request approved Notification", () => {
  function approvedRows() {
    return listOutboxRows(db).filter(
      (row) => row.workflow === "refund-request-approved"
    );
  }

  it("tells the course's Instructor that the Student lost their Enrollment", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);

    approveRefundRequest(db, id, platformAdmin.id, "Sorry.", NOW);

    const [row] = approvedRows();
    expect(row.recipients).toEqual([
      {
        id: base.instructor.knockId,
        name: "Test Instructor",
        email: "instructor@example.com",
      },
    ]);
    expect(row.actor?.id).toBe(platformAdmin.knockId);
    expect(row.data).toEqual({
      buyer_name: "Test User",
      outcome: "enrollment_lost",
      course_title: "Test Course",
      path: `/instructor/${base.course.id}/students`,
    });
  });

  it("says when the buyer keeps their Enrollment through a Claimed Seat", () => {
    const { seats } = buySeats(addLearner("Priya").id, 2);
    claimSeat(seats[0].id, base.user.id);
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: daysBefore(2),
      })
      .returning()
      .get();
    const id = raise(purchase.id, base.user.id);

    approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    const [row] = approvedRows();
    expect(row.data).toEqual({
      buyer_name: "Test User",
      outcome: "enrollment_kept",
      course_title: "Test Course",
      path: `/instructor/${base.course.id}/students`,
    });
  });

  it("says how many Unclaimed Seats a Team Licence lost", () => {
    const priya = addLearner("Priya");
    const { purchase } = buySeats(priya.id, 3);
    const id = raise(purchase.id, priya.id);

    approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    const [row] = approvedRows();
    expect(row.data).toEqual({
      buyer_name: "Priya",
      outcome: "seats_cancelled",
      seats_cancelled: 3,
      course_title: "Test Course",
      path: `/instructor/${base.course.id}/students`,
    });
  });

  it("isn't queued when the Refund Request is declined", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);

    declineRefundRequest(db, id, platformAdmin.id, "Past half way.", NOW);

    expect(approvedRows()).toEqual([]);
  });

  it("isn't queued for a Platform Admin who approves a refund on their own course", () => {
    db.update(schema.courses)
      .set({ instructorId: platformAdmin.id })
      .where(eq(schema.courses.id, base.course.id))
      .run();
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);

    approveRefundRequest(db, id, platformAdmin.id, null, NOW);

    expect(approvedRows()).toEqual([]);
  });
});

describe("declining a Refund Request", () => {
  it("needs a note", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);

    expect(declineRefundRequest(db, id, platformAdmin.id, "  ", NOW)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("keeps the buyer's Enrollment and lets them raise a new Refund Request", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);

    const result = declineRefundRequest(
      db,
      id,
      platformAdmin.id,
      "You finished the course.",
      NOW
    );

    expect(result.ok).toBe(true);
    expect(isEnrolled(base.user.id)).toBe(true);
    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW).ok).toBe(true);
  });

  it("frees a Team Licence's Seats again", () => {
    const priya = addLearner("Priya");
    const { purchase, seats } = buySeats(priya.id, 1);
    const id = raise(purchase.id, priya.id);
    expect(getSeatAvailability(db, getSeat(seats[0].id))).toBe("on_hold");

    declineRefundRequest(db, id, platformAdmin.id, "Seats are in use.", NOW);

    expect(getSeatAvailability(db, getSeat(seats[0].id))).toBe("available");
  });
});

describe("listing Refund Requests", () => {
  it("shows a Platform Admin live figures and the rules a request breaks", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);
    // Since raising the request, the buyer has finished half the course.
    db.insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: LessonProgressStatus.Completed,
        }))
      )
      .run();

    const [row] = listRefundRequestsForReview(db, RefundStatus.Open, NOW);

    expect(row).toMatchObject({
      id,
      buyerName: "Test User",
      daysSincePurchase: 3,
      figures: {
        kind: "individual_purchase",
        lessonsCompleted: 2,
        lessonCount: 4,
      },
      ruleBreaks: ["completed_too_much"],
      canApprove: true,
    });
  });

  it("shows a Team Licence's Seats instead of the buyer's progress", () => {
    const priya = addLearner("Priya");
    const { purchase } = buySeats(priya.id, 3);
    raise(purchase.id, priya.id);

    const [row] = listRefundRequestsForReview(db, RefundStatus.Open, NOW);

    expect(row.figures).toEqual({
      kind: "team_licence",
      seatCount: 3,
      claimedSeatCount: 0,
    });
  });

  it("lists only the requested status, oldest first", () => {
    const first = buyForSelf(base.user.id);
    const ben = addLearner("Ben");
    const second = buyForSelf(ben.id);
    const firstId = raise(first.id, base.user.id);
    const secondId = raiseRefundRequest(
      db,
      second.id,
      ben.id,
      "Changed my mind.",
      new Date(NOW.getTime() + 60_000)
    );
    if (!secondId.ok) throw new Error(secondId.error);

    expect(
      listRefundRequestsForReview(db, RefundStatus.Open, NOW).map((r) => r.id)
    ).toEqual([firstId, secondId.refundRequestId]);

    approveRefundRequest(db, firstId, platformAdmin.id, null, NOW);

    expect(
      listRefundRequestsForReview(db, RefundStatus.Approved, NOW)
    ).toMatchObject([{ id: firstId, decidedByName: "Pat Admin" }]);
  });

  it("shows a buyer their decided requests with the decline note", () => {
    const purchase = buyForSelf(base.user.id);
    const id = raise(purchase.id, base.user.id);
    declineRefundRequest(db, id, platformAdmin.id, "Past half way.", NOW);

    expect(listRefundRequestsForBuyer(db, base.user.id)).toMatchObject([
      { id, status: RefundStatus.Declined, decisionNote: "Past half way." },
    ]);
  });

  it("lists a Team Admin's Team Licences and whether each can be refunded", () => {
    const priya = addLearner("Priya");
    buySeats(priya.id, 2);
    const { seats } = buySeats(priya.id, 2);
    claimSeat(seats[0].id, addLearner("Ben").id);

    expect(listTeamLicences(db, priya.id, NOW)).toMatchObject([
      { seatCount: 2, claimedSeatCount: 1, canRequestRefund: false },
      { seatCount: 2, claimedSeatCount: 0, canRequestRefund: true },
    ]);
  });
});
