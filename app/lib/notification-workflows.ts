import { z } from "zod";
import type { NotificationData } from "~/db/schema";

// ─── Notification workflows ───
// One zod schema per Knock workflow key, and so one TypeScript type for each
// workflow's trigger data. queueNotification checks the data against its
// workflow's schema before it writes the outbox row.
//
// The data contract (see "Wording" in PRD #37):
// - Flat and snake_case. Knock's batch merge drops nested objects and arrays
//   and cuts strings at 256 characters.
// - Every trigger carries `course_title` and `path`, the page the Notification
//   opens, relative to the app. Templates build the link from `vars.app_url`.
// - It reaches the recipient's browser as-is, so it holds only what every
//   recipient may see.
//
// To add a workflow, add its key and schema below and write its rows from the
// domain function with queueNotification. Add new keys as optional at first:
// Knock's copy of the schema changes on merge, before the new code deploys.

const everyTrigger = {
  course_title: z.string().min(1),
  path: z.string().startsWith("/"),
};

export const notificationWorkflows = {
  /** To every Platform Admin when a buyer raises a Refund Request. */
  "refund-request-raised": z
    .object({
      ...everyTrigger,
      buyer_name: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),

  /** To the buyer when a Platform Admin approves or declines their Refund Request. Locked. */
  "refund-request-decided": z
    .object({
      ...everyTrigger,
      decision: z.enum(["approved", "declined"]),
      /** The Platform Admin's note. Required to decline, optional to approve. */
      note: z.string().min(1).optional(),
      /** What the buyer paid, formatted, such as "$79.00". The Refund is all of it. */
      amount_paid: z.string().min(1),
    })
    .strict(),

  /** To the course's Instructor when a Platform Admin approves a Refund Request. */
  "refund-request-approved": z
    .object({
      ...everyTrigger,
      buyer_name: z.string().min(1),
      /**
       * What the approval took away. An Individual Purchase's buyer loses their
       * Enrollment, unless they also hold a Claimed Seat on the course. A Team
       * Licence loses its Unclaimed Seats.
       */
      outcome: z.enum(["enrollment_lost", "enrollment_kept", "seats_cancelled"]),
      /** How many Unclaimed Seats were cancelled. Only for `seats_cancelled`. */
      seats_cancelled: z.number().int().min(1).optional(),
    })
    .strict(),
} satisfies Record<string, z.ZodType<NotificationData>>;

export type WorkflowKey = keyof typeof notificationWorkflows;

export type WorkflowData<K extends WorkflowKey> = z.infer<
  (typeof notificationWorkflows)[K]
>;
