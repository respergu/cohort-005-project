import { and, eq, isNull, sql } from "drizzle-orm";
import { coupons, courses, enrollments, purchases, users } from "~/db/schema";
import type { Db, Tx } from "~/db/types";
import {
  queueNotification,
  toNotificationUser,
} from "~/lib/notification-outbox.server";
import { getSeatAvailability } from "~/lib/refunds.server";
import { getUser } from "~/lib/users.server";

// ─── Enrollments ───
// The two ways a Student gets an Enrollment: claiming a Seat, and buying the
// course for themselves. Each runs in one transaction, so the Notifications
// these events fire can write their outbox rows in it (docs/adr/0014).
//
// Every function takes the database first, so tests can hand in an in-memory
// one.

type Enrollment = typeof enrollments.$inferSelect;
type User = typeof users.$inferSelect;
type Course = typeof courses.$inferSelect;

export const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
export const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";
const ALREADY_ENROLLED = "You are already enrolled in this course";

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

/** Seats on a Team Licence that a Student could still claim. */
function countSeatsLeft(tx: Tx, teamLicenceId: number): number {
  const row = tx
    .select({ count: sql<number>`count(*)` })
    .from(coupons)
    .where(
      and(
        eq(coupons.purchaseId, teamLicenceId),
        isNull(coupons.redeemedAt),
        isNull(coupons.refundedAt)
      )
    )
    .get();
  return row?.count ?? 0;
}

function getCourse(tx: Tx, courseId: number) {
  return tx.select().from(courses).where(eq(courses.id, courseId)).get();
}

/**
 * New Enrollment, to the course's Instructor. The Student is the actor, so an
 * Instructor enrolling on their own course isn't told about it.
 */
function queueNewEnrollment(
  tx: Tx,
  student: User,
  course: Course,
  now: Date
): number[] {
  const instructor = getUser(tx, course.instructorId);
  if (!instructor) {
    throw new Error(`Course ${course.id} has no Instructor.`);
  }
  return queueNotification(
    tx,
    "new-enrollment",
    [toNotificationUser(instructor)],
    toNotificationUser(student),
    {
      course_title: course.title,
      course_id: course.id,
      path: `/instructor/${course.id}/students`,
    },
    now
  );
}

export type ClaimResult =
  | { ok: true; enrollment: Enrollment; outboxRowIds: number[] }
  | { ok: false; error: string };

/**
 * Claims a Seat for a Student and gives them an Enrollment on its course. The
 * Seat update, the Enrollment and its Notifications (Seat claimed to the Team
 * Admin, New Enrollment to the Instructor) commit together or not at all.
 * Returns the outbox row ids for the route to send after the commit.
 */
export function claimSeat(
  db: Db,
  code: string,
  studentId: number,
  country: string | null,
  now: Date
): ClaimResult {
  return db.transaction((tx): ClaimResult => {
    const seat = tx.select().from(coupons).where(eq(coupons.code, code)).get();
    if (!seat) return { ok: false, error: "Seat not found" };

    const availability = getSeatAvailability(tx, seat);
    if (availability === "claimed") {
      return { ok: false, error: "This seat has already been claimed" };
    }
    if (availability === "on_hold") return { ok: false, error: SEAT_ON_HOLD };
    if (availability === "refunded") return { ok: false, error: SEAT_REFUNDED };

    if (isEnrolled(tx, studentId, seat.courseId)) {
      return { ok: false, error: ALREADY_ENROLLED };
    }

    // A Seat is claimed from the country its Team Licence was bought in. The
    // country is the one recorded on the Purchase (docs/adr/0009).
    const purchase = tx
      .select({ country: purchases.country, buyerId: purchases.userId })
      .from(purchases)
      .where(eq(purchases.id, seat.purchaseId))
      .get();
    if (purchase?.country && purchase.country !== country) {
      return {
        ok: false,
        error:
          "This seat can only be claimed from the same country as the purchaser",
      };
    }

    tx.update(coupons)
      .set({
        redeemedByUserId: studentId,
        redeemedAt: now.toISOString(),
      })
      .where(eq(coupons.id, seat.id))
      .run();

    const enrollment = tx
      .insert(enrollments)
      .values({ userId: studentId, courseId: seat.courseId })
      .returning()
      .get();

    const student = getUser(tx, studentId);
    const teamAdmin = purchase && getUser(tx, purchase.buyerId);
    const course = getCourse(tx, seat.courseId);
    if (!student || !teamAdmin || !course) {
      throw new Error(`Seat ${seat.id} has no Student, Team Admin or course.`);
    }

    // Every claim carries seats_left. Only the final claim sets last_seat,
    // and the others leave the key out, so the order the triggers reach
    // Knock in can't hide it from the batch.
    const seatsLeft = countSeatsLeft(tx, seat.purchaseId);
    const seatClaimedRowIds = queueNotification(
      tx,
      "seat-claimed",
      [toNotificationUser(teamAdmin)],
      toNotificationUser(student),
      {
        course_title: course.title,
        team_licence_id: seat.purchaseId,
        seats_left: seatsLeft,
        ...(seatsLeft === 0 && { last_seat: true }),
        path: "/team",
      },
      now
    );

    return {
      ok: true,
      enrollment,
      outboxRowIds: [
        ...seatClaimedRowIds,
        ...queueNewEnrollment(tx, student, course, now),
      ],
    };
  });
}

export type PurchaseResult =
  | { ok: true; enrollment: Enrollment; outboxRowIds: number[] }
  | { ok: false; error: string };

/**
 * Records an Individual Purchase and gives the buyer their Enrollment on the
 * course. The Purchase, the Enrollment and New Enrollment to the course's
 * Instructor commit together or not at all. Returns the outbox row ids for
 * the route to send after the commit.
 */
export function makeIndividualPurchase(
  db: Db,
  buyerId: number,
  courseId: number,
  amountPaid: number,
  country: string | null,
  now: Date
): PurchaseResult {
  return db.transaction((tx): PurchaseResult => {
    if (isEnrolled(tx, buyerId, courseId)) {
      return { ok: false, error: ALREADY_ENROLLED };
    }

    const purchase = tx
      .insert(purchases)
      .values({ userId: buyerId, courseId, amountPaid, country })
      .returning()
      .get();

    const enrollment = tx
      .insert(enrollments)
      .values({ userId: buyerId, courseId })
      .returning()
      .get();

    const buyer = getUser(tx, buyerId);
    const course = getCourse(tx, courseId);
    if (!buyer || !course) {
      throw new Error(`Purchase ${purchase.id} has no buyer or course.`);
    }

    return {
      ok: true,
      enrollment,
      outboxRowIds: queueNewEnrollment(tx, buyer, course, now),
    };
  });
}
