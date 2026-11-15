import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { claimSeat, enrollUser } from "./enrollments.server";

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

/** Every Seat and Enrollment, to show a refused claim wrote nothing. */
function seatsAndEnrollments() {
  return {
    seats: db.select().from(schema.coupons).all(),
    enrollments: db.select().from(schema.enrollments).all(),
  };
}

describe("claiming a Seat", () => {
  it("claims the Seat for the Student and gives them an Enrollment", () => {
    const { seats } = buySeats(3);
    const student = addLearner("Ben");

    const result = claimSeat(db, seats[0].code, student.id, "GB");

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

    expect(() => claimSeat(db, seats[0].code, student.id, "GB")).toThrow(
      "enrollments are down"
    );
    expect(getSeat(seats[0].id)).toMatchObject({
      redeemedByUserId: null,
      redeemedAt: null,
    });
  });
});

describe("refusing a Seat claim", () => {
  it("refuses a Seat someone has already claimed, writing nothing", () => {
    const { seats } = buySeats(3);
    claimSeat(db, seats[0].code, addLearner("Ben").id, "GB");
    const before = seatsAndEnrollments();

    const result = claimSeat(db, seats[0].code, addLearner("Cara").id, "GB");

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

    const result = claimSeat(db, seats[0].code, addLearner("Ben").id, "GB");

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

    const result = claimSeat(db, seats[0].code, addLearner("Ben").id, "GB");

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

    const result = claimSeat(db, seats[0].code, student.id, "GB");

    expect(result).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(seatsAndEnrollments()).toEqual(before);
  });

  it("refuses a Student in a different country from the buyer, writing nothing", () => {
    const { seats } = buySeats(3, "GB");
    const before = seatsAndEnrollments();

    const result = claimSeat(db, seats[0].code, addLearner("Ben").id, "IN");

    expect(result).toEqual({
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    });
    expect(seatsAndEnrollments()).toEqual(before);
  });
});

describe("enrolling a buyer after an Individual Purchase", () => {
  it("gives the buyer an Enrollment on the course", () => {
    const result = enrollUser(db, base.user.id, base.course.id);

    expect(result).toMatchObject({ ok: true });
    expect(enrollmentsOf(base.user.id)).toHaveLength(1);
  });

  it("refuses a second Enrollment on the same course", () => {
    enrollUser(db, base.user.id, base.course.id);

    const result = enrollUser(db, base.user.id, base.course.id);

    expect(result).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
    expect(enrollmentsOf(base.user.id)).toHaveLength(1);
  });
});
