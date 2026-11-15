import { and, eq } from "drizzle-orm";
import { coupons, enrollments, purchases } from "~/db/schema";
import { getSeatAvailability, type Db } from "~/lib/refunds.server";

// ─── Enrollments ───
// The two ways a Student gets an Enrollment: claiming a Seat, and buying the
// course for themselves. Each runs in one transaction, so the Notifications
// these events fire can write their outbox rows in it (docs/adr/0014).
//
// Every function takes the database first, so tests can hand in an in-memory
// one.

type Enrollment = typeof enrollments.$inferSelect;

export const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
export const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";
const ALREADY_ENROLLED = "You are already enrolled in this course";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function isEnrolled(tx: Tx, userId: number, courseId: number) {
  const existing = tx
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
  return existing !== undefined;
}

export type ClaimResult =
  | { ok: true; enrollment: Enrollment }
  | { ok: false; error: string };

/**
 * Claims a Seat for a Student and gives them an Enrollment on its course. The
 * Seat update and the Enrollment commit together or not at all.
 */
export function claimSeat(
  db: Db,
  code: string,
  studentId: number,
  country: string | null
): ClaimResult {
  return db.transaction((tx): ClaimResult => {
    const seat = tx.select().from(coupons).where(eq(coupons.code, code)).get();
    if (!seat) return { ok: false, error: "Coupon not found" };

    const availability = getSeatAvailability(tx, seat);
    if (availability === "claimed") {
      return { ok: false, error: "Coupon has already been redeemed" };
    }
    if (availability === "on_hold") return { ok: false, error: SEAT_ON_HOLD };
    if (availability === "refunded") return { ok: false, error: SEAT_REFUNDED };

    if (isEnrolled(tx, studentId, seat.courseId)) {
      return { ok: false, error: ALREADY_ENROLLED };
    }

    // A Seat is claimed from the country its Team Licence was bought in. The
    // country is the one recorded on the Purchase (docs/adr/0009).
    const purchase = tx
      .select({ country: purchases.country })
      .from(purchases)
      .where(eq(purchases.id, seat.purchaseId))
      .get();
    if (purchase?.country && purchase.country !== country) {
      return {
        ok: false,
        error:
          "This coupon can only be redeemed from the same country as the purchaser",
      };
    }

    tx.update(coupons)
      .set({
        redeemedByUserId: studentId,
        redeemedAt: new Date().toISOString(),
      })
      .where(eq(coupons.id, seat.id))
      .run();

    const enrollment = tx
      .insert(enrollments)
      .values({ userId: studentId, courseId: seat.courseId })
      .returning()
      .get();

    return { ok: true, enrollment };
  });
}

export type EnrollResult =
  | { ok: true; enrollment: Enrollment }
  | { ok: false; error: string };

/** Gives the buyer of an Individual Purchase their Enrollment on the course. */
export function enrollUser(
  db: Db,
  buyerId: number,
  courseId: number
): EnrollResult {
  return db.transaction((tx): EnrollResult => {
    if (isEnrolled(tx, buyerId, courseId)) {
      return { ok: false, error: ALREADY_ENROLLED };
    }

    const enrollment = tx
      .insert(enrollments)
      .values({ userId: buyerId, courseId })
      .returning()
      .get();

    return { ok: true, enrollment };
  });
}
