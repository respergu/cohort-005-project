import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { TeamMemberRole } from "~/db/schema";
import { buyTeamLicence } from "./team-licences.server";

type TestDb = ReturnType<typeof createTestDb>;

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function buySeats(seats: number) {
  return buyTeamLicence(
    db,
    base.user.id,
    base.course.id,
    7900 * seats,
    "GB",
    seats
  );
}

function purchasesOf(userId: number) {
  return db
    .select()
    .from(schema.purchases)
    .where(eq(schema.purchases.userId, userId))
    .all();
}

function membershipsOf(userId: number) {
  return db
    .select()
    .from(schema.teamMembers)
    .where(eq(schema.teamMembers.userId, userId))
    .all();
}

describe("buying a Team Licence", () => {
  it("records the Purchase, makes the buyer its Team Admin, and grants one Unclaimed Seat per place bought", () => {
    buySeats(3);

    const [purchase] = purchasesOf(base.user.id);
    expect(purchasesOf(base.user.id)).toEqual([
      {
        id: expect.any(Number),
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 23700,
        country: "GB",
        createdAt: expect.any(String),
      },
    ]);
    const [membership] = membershipsOf(base.user.id);
    expect(membershipsOf(base.user.id)).toEqual([
      expect.objectContaining({ role: TeamMemberRole.Admin }),
    ]);

    const seats = db.select().from(schema.coupons).all();
    expect(seats).toHaveLength(3);
    for (const seat of seats) {
      expect(seat).toMatchObject({
        teamId: membership.teamId,
        courseId: base.course.id,
        purchaseId: purchase.id,
        redeemedByUserId: null,
        redeemedAt: null,
        refundedAt: null,
      });
    }
    expect(new Set(seats.map((seat) => seat.code)).size).toBe(3);
  });

  it("adds a second Team Licence's Seats to the Team Admin's existing team", () => {
    buySeats(3);
    buySeats(2);

    expect(db.select().from(schema.teams).all()).toHaveLength(1);
    const [membership] = membershipsOf(base.user.id);
    expect(membershipsOf(base.user.id)).toHaveLength(1);
    expect(purchasesOf(base.user.id)).toHaveLength(2);
    const seats = db.select().from(schema.coupons).all();
    expect(seats).toHaveLength(5);
    expect(seats.every((seat) => seat.teamId === membership.teamId)).toBe(true);
  });

  it("gives the buyer no Enrollment", () => {
    buySeats(3);

    expect(db.select().from(schema.enrollments).all()).toEqual([]);
  });

  it("writes no team, Purchase or Seats when a Seat can't be written", () => {
    db.$client.exec(`
      CREATE TRIGGER seats_down BEFORE INSERT ON coupons
      BEGIN SELECT RAISE(ABORT, 'seats are down'); END;
    `);

    expect(() => buySeats(3)).toThrow("seats are down");
    expect(purchasesOf(base.user.id)).toEqual([]);
    expect(db.select().from(schema.teams).all()).toEqual([]);
    expect(membershipsOf(base.user.id)).toEqual([]);
  });
});
