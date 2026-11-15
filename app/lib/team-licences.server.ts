import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import {
  coupons,
  purchases,
  teamMembers,
  teams,
  TeamMemberRole,
} from "~/db/schema";
import type { Db } from "~/lib/refunds.server";

// ─── Team Licences ───
// Buying a Team Licence: a Purchase a Team Admin makes for others. It grants
// Seats, not an Enrollment. See GLOSSARY.md.
//
// Every function takes the database first, so tests can hand in an in-memory
// one.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The buyer's team, or a new one with them as its Team Admin. */
function getOrCreateTeam(tx: Tx, teamAdminId: number) {
  const membership = tx
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, teamAdminId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();
  const existing =
    membership &&
    tx.select().from(teams).where(eq(teams.id, membership.teamId)).get();
  if (existing) return existing;

  const team = tx.insert(teams).values({}).returning().get();
  tx.insert(teamMembers)
    .values({
      teamId: team.id,
      userId: teamAdminId,
      role: TeamMemberRole.Admin,
    })
    .run();
  return team;
}

/**
 * Records a Team Licence for the buyer, on their team (made if they have
 * none), with one Unclaimed Seat per place bought. The team, the Purchase and
 * the Seats commit together or not at all.
 */
export function buyTeamLicence(
  db: Db,
  buyerId: number,
  courseId: number,
  amountPaid: number,
  country: string | null,
  seatCount: number
) {
  return db.transaction((tx) => {
    const purchase = tx
      .insert(purchases)
      .values({ userId: buyerId, courseId, amountPaid, country })
      .returning()
      .get();
    const team = getOrCreateTeam(tx, buyerId);
    const seats = Array.from({ length: seatCount }, () =>
      tx
        .insert(coupons)
        .values({
          teamId: team.id,
          courseId,
          code: crypto.randomBytes(12).toString("base64url"),
          purchaseId: purchase.id,
        })
        .returning()
        .get()
    );
    return { purchase, team, seats };
  });
}
