import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { claimSeat, makeIndividualPurchase } from "./enrollments.server";
import { listOutboxRows } from "./notification-outbox.server";

const NOW = new Date(2026, 9, 6, 12, 0, 0);

type TestDb = ReturnType<typeof createTestDb>;

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let teamAdmin: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  teamAdmin = addLearner("Priya");
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

function buySeats(seats: number, country: string | null = "GB") {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: teamAdmin.id,
      courseId: base.course.id,
      amountPaid: 7900 * seats,
      country,
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

function getSeat(seatId: number) {
  const seat = db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.id, seatId))
    .get();
  if (!seat) throw new Error("Seat not found");
  return seat;
}

function enrollmentsOf(userId: number) {
  return db
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .all();
}

/** Every Seat, Enrollment and outbox row, to show a refused claim wrote nothing. */
function seatsAndEnrollments() {
  return {
    seats: db.select().from(schema.coupons).all(),
    enrollments: db.select().from(schema.enrollments).all(),
    outbox: listOutboxRows(db),
  };
}

describe("claiming a Seat", () => {
  it("claims the Seat for the Student and gives them an Enrollment", () => {
    const { seats } = buySeats(3);
    const student = addLearner("Ben");

    const result = claimSeat(db, seats[0].code, student.id, "GB", NOW);

    expect(result).toMatchObject({ ok: true });
    expect(getSeat(seats[0].id)).toMatchObject({
      redeemedByUserId: student.id,
      redeemedAt: expect.any(String),
    });
    expect(enrollmentsOf(student.id)).toHaveLength(1);
  });

  it("leaves the Seat unclaimed when the Enrollment can't be written", () => {
    const { seats } = buySeats(3);
    const student = addLearner("Ben");
    db.$client.exec(`
      CREATE TRIGGER enrollments_down BEFORE INSERT ON enrollments
      BEGIN SELECT RAISE(ABORT, 'enrollments are down'); END;
    `);

    expect(() => claimSeat(db, seats[0].code, student.id, "GB", NOW)).toThrow(
      "enrollments are down"
    );
    expect(getSeat(seats[0].id)).toMatchObject({
      redeemedByUserId: null,
      redeemedAt: null,
    });
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("leaves the Seat unclaimed, with no Enrollment, when its Notifications can't be queued", () => {
    const { seats } = buySeats(3);
    const student = addLearner("Ben");
    db.$client.exec(`
      CREATE TRIGGER outbox_down BEFORE INSERT ON notification_outbox
      BEGIN SELECT RAISE(ABORT, 'the outbox is down'); END;
    `);

    expect(() => claimSeat(db, seats[0].code, student.id, "GB", NOW)).toThrow(
      "the outbox is down"
    );
    expect(getSeat(seats[0].id)).toMatchObject({
      redeemedByUserId: null,
      redeemedAt: null,
    });
    expect(enrollmentsOf(student.id)).toEqual([]);
  });
});

describe("refusing a Seat claim", () => {
  it("refuses a Seat someone has already claimed, writing nothing", () => {
    const { seats } = buySeats(3);
    claimSeat(db, seats[0].code, addLearner("Ben").id, "GB", NOW);
    const before = seatsAndEnrollments();

    const result = claimSeat(
      db,
      seats[0].code,
      addLearner("Cara").id,
      "GB",
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error: "Coupon has already been redeemed",
    });
    expect(seatsAndEnrollments()).toEqual(before);
  });

  it("refuses a Seat on hold while its Team Licence has an Open Refund Request, writing nothing", () => {
    const { purchase, seats } = buySeats(3);
    db.insert(schema.refunds)
      .values({ purchaseId: purchase.id, reason: "Too many seats." })
      .run();
    const before = seatsAndEnrollments();

    const result = claimSeat(
      db,
      seats[0].code,
      addLearner("Ben").id,
      "GB",
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error:
        "This seat can't be claimed right now. Ask the person who shared it with you.",
    });
    expect(seatsAndEnrollments()).toEqual(before);
  });

  it("refuses a Seat whose Team Licence was refunded, writing nothing", () => {
    const { seats } = buySeats(3);
    db.update(schema.coupons)
      .set({ refundedAt: new Date().toISOString() })
      .where(eq(schema.coupons.id, seats[0].id))
      .run();
    const before = seatsAndEnrollments();

    const result = claimSeat(
      db,
      seats[0].code,
      addLearner("Ben").id,
      "GB",
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error:
        "This seat is no longer available. Ask the person who shared it with you.",
    });
    expect(seatsAndEnrollments()).toEqual(before);
  });

  it("refuses a Student already enrolled on the course, writing nothing", () => {
    const { seats } = buySeats(3);
    const student = addLearner("Ben");
    db.insert(schema.enrollments)
      .values({ userId: student.id, courseId: base.course.id })
      .run();
    const before = seatsAndEnrollments();

    const result = claimSeat(db, seats[0].code, student.id, "GB", NOW);

    expect(result).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(seatsAndEnrollments()).toEqual(before);
  });

  it("refuses a Student in a different country from the buyer, writing nothing", () => {
    const { seats } = buySeats(3, "GB");
    const before = seatsAndEnrollments();

    const result = claimSeat(
      db,
      seats[0].code,
      addLearner("Ben").id,
      "IN",
      NOW
    );

    expect(result).toEqual({
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    });
    expect(seatsAndEnrollments()).toEqual(before);
  });
});

const PRICE = 7900;

function buyCourse(buyerId: number) {
  return makeIndividualPurchase(db, buyerId, base.course.id, PRICE, "GB", NOW);
}

function purchasesOf(userId: number) {
  return db
    .select()
    .from(schema.purchases)
    .where(eq(schema.purchases.userId, userId))
    .all();
}

describe("making an Individual Purchase", () => {
  it("records the Purchase and gives the buyer an Enrollment on the course", () => {
    const result = buyCourse(base.user.id);

    expect(result).toMatchObject({ ok: true });
    expect(purchasesOf(base.user.id)).toEqual([
      {
        id: expect.any(Number),
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        country: "GB",
        createdAt: expect.any(String),
      },
    ]);
    expect(enrollmentsOf(base.user.id)).toHaveLength(1);
  });

  it("refuses a buyer already enrolled on the course, writing no Purchase", () => {
    buyCourse(base.user.id);

    const result = buyCourse(base.user.id);

    expect(result).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(purchasesOf(base.user.id)).toHaveLength(1);
    expect(enrollmentsOf(base.user.id)).toHaveLength(1);
  });

  it("writes no Purchase when the Enrollment can't be written", () => {
    db.$client.exec(`
      CREATE TRIGGER enrollments_down BEFORE INSERT ON enrollments
      BEGIN SELECT RAISE(ABORT, 'enrollments are down'); END;
    `);

    expect(() => buyCourse(base.user.id)).toThrow("enrollments are down");
    expect(purchasesOf(base.user.id)).toEqual([]);
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("writes no Purchase and no Enrollment when its Notification can't be queued", () => {
    db.$client.exec(`
      CREATE TRIGGER outbox_down BEFORE INSERT ON notification_outbox
      BEGIN SELECT RAISE(ABORT, 'the outbox is down'); END;
    `);

    expect(() => buyCourse(base.user.id)).toThrow("the outbox is down");
    expect(purchasesOf(base.user.id)).toEqual([]);
    expect(enrollmentsOf(base.user.id)).toEqual([]);
  });
});

describe("the Seat claimed Notification", () => {
  it("is queued for the Team Admin, with the claiming Student as the actor", () => {
    const { seats } = buySeats(3);
    const student = addLearner("Ben");

    claimSeat(db, seats[0].code, student.id, "GB", NOW);

    const rows = listOutboxRows(db).filter(
      (row) => row.workflow === "seat-claimed"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].recipients).toEqual([
      { id: teamAdmin.knockId, name: "Priya", email: "priya@example.com" },
    ]);
    expect(rows[0].actor).toEqual({
      id: student.knockId,
      name: "Ben",
      email: "ben@example.com",
    });
  });

  it("says which course, how many Seats are left, and opens /team", () => {
    const { purchase, seats } = buySeats(3);

    claimSeat(db, seats[0].code, addLearner("Ben").id, "GB", NOW);

    expect(seatClaimedRows().map((row) => row.data)).toEqual([
      {
        course_title: "Test Course",
        team_licence_id: purchase.id,
        seats_left: 2,
        path: "/team",
      },
    ]);
  });

  // Knock's batch merge keeps the latest value of each key, so a later
  // trigger carrying last_seat: false would hide the final claim's true.
  it("sets last_seat only on the claim of the final Seat, and leaves the key out on the others", () => {
    const { seats } = buySeats(2);

    claimSeat(db, seats[0].code, addLearner("Ben").id, "GB", NOW);
    claimSeat(db, seats[1].code, addLearner("Cara").id, "GB", NOW);

    const [first, final] = seatClaimedRows().map((row) => row.data);
    expect(first).not.toHaveProperty("last_seat");
    expect(first).toMatchObject({ seats_left: 1 });
    expect(final).toMatchObject({ seats_left: 0, last_seat: true });
  });

  it("isn't queued when the Team Admin claims a Seat on their own Team Licence", () => {
    const { seats } = buySeats(3);

    claimSeat(db, seats[0].code, teamAdmin.id, "GB", NOW);

    expect(seatClaimedRows()).toEqual([]);
  });
});

function seatClaimedRows() {
  return listOutboxRows(db).filter((row) => row.workflow === "seat-claimed");
}

describe("the New Enrollment Notification", () => {
  it("is queued for the course's Instructor when a Student claims a Seat", () => {
    const { seats } = buySeats(3);
    const student = addLearner("Ben");

    claimSeat(db, seats[0].code, student.id, "GB", NOW);

    const rows = newEnrollmentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipients).toEqual([
      {
        id: base.instructor.knockId,
        name: "Test Instructor",
        email: "instructor@example.com",
      },
    ]);
    expect(rows[0].actor).toEqual({
      id: student.knockId,
      name: "Ben",
      email: "ben@example.com",
    });
  });

  it("says which course and opens its Students page", () => {
    const { seats } = buySeats(3);

    claimSeat(db, seats[0].code, addLearner("Ben").id, "GB", NOW);

    expect(newEnrollmentRows().map((row) => row.data)).toEqual([
      {
        course_title: "Test Course",
        course_id: base.course.id,
        path: `/instructor/${base.course.id}/students`,
      },
    ]);
  });

  it("is queued for the course's Instructor when a buyer enrols after an Individual Purchase", () => {
    buyCourse(base.user.id);

    const rows = newEnrollmentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipients: [
        {
          id: base.instructor.knockId,
          name: "Test Instructor",
          email: "instructor@example.com",
        },
      ],
      actor: {
        id: base.user.knockId,
        name: "Test User",
        email: "test@example.com",
      },
      data: {
        course_title: "Test Course",
        course_id: base.course.id,
        path: `/instructor/${base.course.id}/students`,
      },
    });
  });

  it("isn't queued when the Instructor buys their own course", () => {
    buyCourse(base.instructor.id);

    expect(purchasesOf(base.instructor.id)).toHaveLength(1);
    expect(enrollmentsOf(base.instructor.id)).toHaveLength(1);
    expect(newEnrollmentRows()).toEqual([]);
  });

  it("isn't queued when the Instructor claims a Seat on their own course, though the Team Admin still hears of the claim", () => {
    const { seats } = buySeats(3);

    claimSeat(db, seats[0].code, base.instructor.id, "GB", NOW);

    expect(newEnrollmentRows()).toEqual([]);
    expect(seatClaimedRows()).toHaveLength(1);
  });

  it("isn't queued again when a buyer is refused a second Enrollment", () => {
    buyCourse(base.user.id);

    buyCourse(base.user.id);

    expect(newEnrollmentRows()).toHaveLength(1);
  });
});

function newEnrollmentRows() {
  return listOutboxRows(db).filter((row) => row.workflow === "new-enrollment");
}

describe("handing the Notifications to the route", () => {
  it("returns the ids of the Seat claimed and New Enrollment rows a Seat claim queued", () => {
    const { seats } = buySeats(3);

    const result = claimSeat(
      db,
      seats[0].code,
      addLearner("Ben").id,
      "GB",
      NOW
    );

    expect(result.ok && result.outboxRowIds).toEqual(
      listOutboxRows(db).map((row) => row.id)
    );
    expect(listOutboxRows(db).map((row) => row.workflow)).toEqual([
      "seat-claimed",
      "new-enrollment",
    ]);
  });

  it("returns the id of the New Enrollment row an Individual Purchase queued", () => {
    const result = buyCourse(base.user.id);

    const rows = listOutboxRows(db);
    expect(rows).toHaveLength(1);
    expect(result.ok && result.outboxRowIds).toEqual([rows[0].id]);
  });
});
