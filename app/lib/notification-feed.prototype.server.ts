// PROTOTYPE, throwaway. Wayfinder ticket "What does the Notification Feed look
// like in Cadence?" (respergu/cohort-005-project#24). Lives on the
// prototype/notification-feed branch only; never merge to main.
//
// Talks to the real Knock Development environment:
// - signs a per-user RS256 token so the browser reads its own Notification Feed
// - triggers a single generic workflow whose in-app step renders `{{ body }}`
//   with action URL `{{ url }}`
// No SDK: plain fetch + node:crypto, so the moving parts stay visible.
//
// Imports are relative/stdlib only so scripts/seed-notification-feed.prototype.ts
// can reuse this file under tsx.
import { createSign } from "node:crypto";
import type Database from "better-sqlite3";

export const PROTOTYPE_WORKFLOW_KEY = "prototype-notification-feed";
const KNOCK_API = "https://api.knock.app/v1";

// Knock user ids are namespaced so prototype messages never land in the feed of
// whatever id scheme "How do Cadence users and audiences reach the vendor?"
// (#26) settles on.
export function prototypeKnockUserId(userId: number) {
  return `prototype-${userId}`;
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from the environment`);
  return value;
}

export function signKnockUserToken(knockUserId: string, ttlSeconds = 3600) {
  const pem = Buffer.from(requireEnv("KNOCK_SIGNING_KEY"), "base64").toString(
    "utf8"
  );
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    sub: knockUserId,
    iat: now,
    exp: now + ttlSeconds,
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(pem)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

export type FeedClientConfig = {
  apiBase: string;
  publicKey: string;
  channelId: string;
  knockUserId: string;
  userToken: string;
};

export function getFeedClientConfig(userId: number): FeedClientConfig | null {
  if (
    !process.env.KNOCK_PUBLIC_API_KEY ||
    !process.env.KNOCK_FEED_CHANNEL_ID ||
    !process.env.KNOCK_SIGNING_KEY
  ) {
    return null;
  }
  const knockUserId = prototypeKnockUserId(userId);
  return {
    apiBase: KNOCK_API,
    publicKey: requireEnv("KNOCK_PUBLIC_API_KEY"),
    channelId: requireEnv("KNOCK_FEED_CHANNEL_ID"),
    knockUserId,
    userToken: signKnockUserToken(knockUserId),
  };
}

// ---------------------------------------------------------------------------
// Catalogue: a few Notifications from "Which Notifications does Cadence send,
// and to whom?" (#20), built from rows in data.db so links go somewhere real.
// ---------------------------------------------------------------------------

export type NotificationKind =
  | "refund-request-raised" // #1  -> Platform Admin
  | "refund-request-decided" // #2 -> buyer
  | "refund-approved-instructor" // #3 -> Instructor
  | "seat-claimed" // #4 -> Team Admin
  | "last-seat-claimed" // #5 -> Team Admin
  | "new-enrollment" // #6 -> Instructor
  | "new-question" // #7 -> Instructor
  | "reply" // #8 -> top-level Comment author
  | "new-lesson"; // #9 -> enrolled Students

export type PrototypeNotification = {
  actor?: { id: string; name: string };
  data: {
    kind: NotificationKind;
    // Markdown, rendered by the Knock template as `{{ body }}`
    body: string;
    url: string;
    course?: { title: string; slug: string; coverImageUrl: string | null };
    // Quoted user content: a refund reason, a Question, a Reply, a decision note
    excerpt?: string;
    // Label for the primary action in variants that show one
    cta: string;
    tone?: "positive" | "negative" | "warning";
  };
};

type CourseRow = {
  id: number;
  title: string;
  slug: string;
  coverImageUrl: string | null;
};

const bold = (s: string) => `**${s}**`;
const course = (c: CourseRow) => ({
  title: c.title,
  slug: c.slug,
  coverImageUrl: c.coverImageUrl,
});
const actor = (row: { id: number; name: string }) => ({
  id: prototypeKnockUserId(row.id),
  name: row.name,
});
const clip = (s: string, n = 140) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

export function prototypeNotificationsFor(
  sqlite: Database.Database,
  userId: number
): PrototypeNotification[] {
  const user = sqlite
    .prepare("select id, name, role from users where id = ?")
    .get(userId) as { id: number; name: string; role: string } | undefined;
  if (!user) return [];

  const out: PrototypeNotification[] = [];

  if (user.role === "admin") {
    const openRequests = sqlite
      .prepare(
        `select r.reason, u.id as buyerId, u.name as buyerName,
                c.id, c.title, c.slug, c.cover_image_url as coverImageUrl
           from refunds r
           join purchases p on p.id = r.purchase_id
           join users u on u.id = p.user_id
           join courses c on c.id = p.course_id
          order by r.requested_at desc limit 3`
      )
      .all() as (CourseRow & {
      reason: string;
      buyerId: number;
      buyerName: string;
    })[];
    for (const r of openRequests) {
      out.push({
        actor: actor({ id: r.buyerId, name: r.buyerName }),
        data: {
          kind: "refund-request-raised",
          body: `${bold(r.buyerName)} asked for a refund on ${bold(r.title)}`,
          excerpt: r.reason,
          url: "/admin/refunds",
          course: course(r),
          cta: "Review request",
          tone: "warning",
        },
      });
    }
  }

  if (user.role === "instructor") {
    const courses = sqlite
      .prepare(
        `select id, title, slug, cover_image_url as coverImageUrl
           from courses where instructor_id = ? and status = 'published'
          order by id`
      )
      .all(user.id) as CourseRow[];

    for (const [i, c] of courses.slice(0, 2).entries()) {
      // Batched hourly per course, so the count is per window, not a total
      const newStudents = [5, 2][i];
      out.push({
        data: {
          kind: "new-enrollment",
          body: `${bold(`${newStudents} new Students`)} enrolled on ${bold(c.title)}`,
          url: `/instructor/${c.id}/students`,
          course: course(c),
          cta: "See Students",
          tone: "positive",
        },
      });
    }

    const question = sqlite
      .prepare(
        `select cm.body, u.id as authorId, u.name as authorName,
                l.id as lessonId, l.title as lessonTitle,
                c.id, c.title, c.slug, c.cover_image_url as coverImageUrl
           from comments cm
           join users u on u.id = cm.user_id
           join lessons l on l.id = cm.lesson_id
           join modules m on m.id = l.module_id
           join courses c on c.id = m.course_id
          where cm.parent_id is null and cm.deleted_at is null
            and c.instructor_id = ? and cm.user_id <> ?
          order by cm.id desc limit 1`
      )
      .get(user.id, user.id) as
      | (CourseRow & {
          body: string;
          authorId: number;
          authorName: string;
          lessonId: number;
          lessonTitle: string;
        })
      | undefined;
    if (question) {
      out.push({
        actor: actor({ id: question.authorId, name: question.authorName }),
        data: {
          kind: "new-question",
          body: `${bold(question.authorName)} asked a Question on ${bold(question.lessonTitle)}`,
          excerpt: clip(question.body),
          url: `/courses/${question.slug}/lessons/${question.lessonId}`,
          course: course(question),
          cta: "Answer",
        },
      });
    }

    const refunded = sqlite
      .prepare(
        `select u.name as buyerName, c.id, c.title, c.slug,
                c.cover_image_url as coverImageUrl
           from refunds r
           join purchases p on p.id = r.purchase_id
           join users u on u.id = p.user_id
           join courses c on c.id = p.course_id
          where c.instructor_id = ? limit 1`
      )
      .get(user.id) as (CourseRow & { buyerName: string }) | undefined;
    if (refunded) {
      out.push({
        data: {
          kind: "refund-approved-instructor",
          body: `A refund on ${bold(refunded.title)} was approved: ${bold(refunded.buyerName)} lost their Enrollment`,
          url: `/instructor/${refunded.id}/students`,
          course: course(refunded),
          cta: "See Students",
          tone: "negative",
        },
      });
    }
  }

  // Students, and anyone else holding an Enrollment (Team Admins often do)
  const enrolledCourses = sqlite
    .prepare(
      `select c.id, c.title, c.slug, c.cover_image_url as coverImageUrl
         from enrollments e join courses c on c.id = e.course_id
        where e.user_id = ? and c.status = 'published' order by e.id`
    )
    .all(user.id) as CourseRow[];

  if (user.role === "student") {
    const reply = sqlite
      .prepare(
        `select r.body, u.id as authorId, u.name as authorName,
                l.id as lessonId, l.title as lessonTitle,
                c.id, c.title, c.slug, c.cover_image_url as coverImageUrl
           from comments q
           join comments r on r.parent_id = q.id and r.user_id <> q.user_id
           join users u on u.id = r.user_id
           join lessons l on l.id = q.lesson_id
           join modules m on m.id = l.module_id
           join courses c on c.id = m.course_id
          where q.user_id = ? and q.parent_id is null
          order by r.id desc limit 1`
      )
      .get(user.id) as
      | (CourseRow & {
          body: string;
          authorId: number;
          authorName: string;
          lessonId: number;
          lessonTitle: string;
        })
      | undefined;
    if (reply) {
      out.push({
        actor: actor({ id: reply.authorId, name: reply.authorName }),
        data: {
          kind: "reply",
          body: `${bold(reply.authorName)} replied to your Question on ${bold(reply.lessonTitle)}`,
          excerpt: clip(reply.body),
          url: `/courses/${reply.slug}/lessons/${reply.lessonId}`,
          course: course(reply),
          cta: "Read Reply",
        },
      });
    }

    const lessonCourse = enrolledCourses[enrolledCourses.length - 1];
    if (lessonCourse) {
      out.push({
        data: {
          kind: "new-lesson",
          body: `${bold("2 new lessons")} in ${bold(lessonCourse.title)}`,
          url: `/courses/${lessonCourse.slug}`,
          course: course(lessonCourse),
          cta: "Watch",
        },
      });
    }

    const decidedCourse = enrolledCourses[0];
    if (decidedCourse) {
      out.push({
        actor: { id: prototypeKnockUserId(1), name: "Alex Rivera" },
        data: {
          kind: "refund-request-decided",
          body: `Your refund request on ${bold(decidedCourse.title)} was ${bold("declined")}`,
          excerpt:
            "You've completed most of the course, which is past the refund window. Happy to talk it through.",
          url: `/courses/${decidedCourse.slug}`,
          course: course(decidedCourse),
          cta: "View course",
          tone: "negative",
        },
      });
    }
  }

  const seats = sqlite
    .prepare(
      `select cp.course_id as id, c.title, c.slug, c.cover_image_url as coverImageUrl,
              count(*) as total,
              sum(cp.redeemed_by_user_id is not null) as claimed,
              group_concat(u.name, ', ') as claimers
         from team_members tm
         join coupons cp on cp.team_id = tm.team_id
         join courses c on c.id = cp.course_id
         left join users u on u.id = cp.redeemed_by_user_id
        where tm.user_id = ? and tm.role = 'admin'
        group by cp.course_id`
    )
    .all(user.id) as (CourseRow & {
    total: number;
    claimed: number;
    claimers: string | null;
  })[];
  for (const s of seats.slice(0, 1)) {
    const names = s.claimers?.split(", ").slice(0, 2) ?? ["Two teammates"];
    out.push({
      data: {
        kind: "seat-claimed",
        body: `${bold(names.join(" and "))} claimed Seats on ${bold(s.title)}, ${s.total - s.claimed} left`,
        url: "/team",
        course: course(s),
        cta: "Manage Seats",
      },
    });
    out.push({
      data: {
        kind: "last-seat-claimed",
        body: `${bold(names[0] ?? "A teammate")} claimed the last Seat on ${bold(s.title)}, none left`,
        url: "/team",
        course: course(s),
        cta: "Buy more Seats",
        tone: "warning",
      },
    });
  }

  return out;
}

export async function triggerPrototypeNotification(
  recipient: { id: number; name: string },
  notification: PrototypeNotification
) {
  const response = await fetch(
    `${KNOCK_API}/workflows/${PROTOTYPE_WORKFLOW_KEY}/trigger`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv("KNOCK_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipients: [
          { id: prototypeKnockUserId(recipient.id), name: recipient.name },
        ],
        actor: notification.actor,
        data: notification.data,
      }),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Knock trigger failed: ${response.status} ${await response.text()}`
    );
  }
  return (await response.json()) as { workflow_run_id: string };
}

// Secret-key read, used by the seed script to skip users who already have a
// populated feed (every Feed message counts toward Knock's 10K/month).
export async function countFeedItems(userId: number) {
  const response = await fetch(
    `${KNOCK_API}/users/${prototypeKnockUserId(userId)}/feeds/${requireEnv(
      "KNOCK_FEED_CHANNEL_ID"
    )}?page_size=1&archived=include`,
    { headers: { Authorization: `Bearer ${requireEnv("KNOCK_API_KEY")}` } }
  );
  if (!response.ok) {
    throw new Error(`Knock feed read failed: ${response.status}`);
  }
  const body = (await response.json()) as { meta: { total_count: number } };
  return body.meta.total_count;
}
