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
  /**
   * To every Student enrolled on a Published course when one of its lessons
   * gets its first video. Knock batches it per course, so `course_id` is the
   * batch key, and `path` is the course page for every lesson in the batch.
   */
  "new-lesson": z
    .object({
      ...everyTrigger,
      course_id: z.number().int().min(1),
      lesson_title: z.string().min(1),
    })
    .strict(),

  /** To every Platform Admin when a buyer raises a Refund Request. */
  "refund-request-raised": z
    .object({
      ...everyTrigger,
      buyer_name: z.string().min(1),
      reason: z.string().min(1),
    })
    .strict(),

  /** To the course's Instructor when anyone else asks a Question (#50). */
  "new-question": z
    .object({
      ...everyTrigger,
      /** The Batch step's key: one batch per course, per Instructor. */
      course_id: z.number().int().min(1),
      lesson_title: z.string().min(1),
      asker_name: z.string().min(1),
      // Knock's batch merge would cut anything longer.
      question_excerpt: z.string().min(1).max(256),
    })
    .strict(),

  /** To a Question's author when someone replies to it (#50). */
  reply: z
    .object({
      ...everyTrigger,
      lesson_title: z.string().min(1),
      // The replier's name only: data reaches the author's browser as-is.
      replier_name: z.string().min(1),
      reply_excerpt: z.string().min(1).max(256),
    })
    .strict(),

  // ── Seat claims and New Enrollment (#49) ──
  /** To the Team Admin when a Student claims a Seat on their Team Licence. */
  "seat-claimed": z
    .object({
      ...everyTrigger,
      /** The Team Licence (its Purchase id): Knock's batch key. */
      team_licence_id: z.number().int().min(1),
      /** Unclaimed Seats left on the Team Licence after this claim. */
      seats_left: z.number().int().min(0),
      /**
       * Only on the claim of the final Seat, which makes it Last Seat claimed.
       * The other claims leave the key out: Knock's batch merge keeps the
       * latest value of each key, so a later `false` would hide it.
       */
      last_seat: z.literal(true).optional(),
    })
    .strict(),
  /**
   * To the course's Instructor when a Student gets an Enrollment, from a
   * Claimed Seat or an Individual Purchase.
   */
  "new-enrollment": z
    .object({
      ...everyTrigger,
      /** Knock's batch key. */
      course_id: z.number().int().min(1),
    })
    .strict(),
} satisfies Record<string, z.ZodType<NotificationData>>;

export type WorkflowKey = keyof typeof notificationWorkflows;

export type WorkflowData<K extends WorkflowKey> = z.infer<
  (typeof notificationWorkflows)[K]
>;
