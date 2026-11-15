import { and, eq } from "drizzle-orm";
import {
  comments,
  courses,
  enrollments,
  lessons,
  modules,
  users,
} from "~/db/schema";
import type { Db, Queryable } from "~/db/types";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";
import {
  queueNotification,
  toNotificationUser,
} from "~/lib/notification-outbox.server";
import { getUser } from "~/lib/users.server";

// ─── Comments ───
// Posting a Comment on a lesson: a top-level Comment or a Reply. The lesson
// page and the Instructor's Questions page both post through here, so they
// apply the same rules. See GLOSSARY.md for Comment, Question and Reply.
//
// Posting queues the Notifications in the same transaction: New Question to
// the course's Instructor, or Reply to the Question's author (PRD #37, rows 7
// and 8). Editing never notifies anyone.
//
// Takes the database first, so tests can hand in an in-memory one. Uses
// positional parameters (project convention).

type Comment = typeof comments.$inferSelect;

export type Failure = { ok: false; status: 400 | 403 | 404; error: string };

export type CreateCommentResult =
  | {
      ok: true;
      comment: Comment;
      /** For the route to hand to sendInBackground after the commit. */
      outboxRowIds: number[];
    }
  | Failure;

export function createComment(
  db: Db,
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date
): CreateCommentResult {
  const trimmed = body.trim();
  const invalid = checkBody(trimmed);
  if (invalid) return invalid;

  return db.transaction((tx): CreateCommentResult => {
    const lesson = tx
      .select({ id: lessons.id, title: lessons.title, course: courses })
      .from(lessons)
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .innerJoin(courses, eq(courses.id, modules.courseId))
      .where(eq(lessons.id, lessonId))
      .get();
    if (!lesson) {
      return { ok: false, status: 404, error: "Lesson not found" };
    }

    let question: Comment | null = null;
    if (parentId !== null) {
      const parent = tx
        .select()
        .from(comments)
        .where(eq(comments.id, parentId))
        .get();
      if (!parent) {
        return { ok: false, status: 404, error: "Parent comment not found" };
      }
      if (parent.lessonId !== lessonId) {
        return {
          ok: false,
          status: 400,
          error: "Parent comment belongs to a different lesson",
        };
      }
      // A Reply can't itself be replied to: replies are one level deep.
      if (parent.parentId !== null) {
        return {
          ok: false,
          status: 400,
          error: "Replies can only be one level deep",
        };
      }
      question = parent;
    }

    const comment = tx
      .insert(comments)
      .values({
        userId,
        lessonId,
        parentId,
        body: trimmed,
        createdAt: now.toISOString(),
      })
      .returning()
      .get();

    // Notifications go in the same transaction, so they commit with the
    // Comment or not at all. The author is the actor, never a recipient.
    const author = getUser(tx, userId);
    const outboxRowIds = !author
      ? []
      : question === null
        ? queueNewQuestion(tx, lesson, author, trimmed, now)
        : queueReply(tx, lesson, question, author, trimmed, now);

    return { ok: true, comment, outboxRowIds };
  });
}

export type EditCommentResult = { ok: true; comment: Comment } | Failure;

/** Edits the author's own Comment. Edits never fire a Notification. */
export function editComment(
  db: Db,
  commentId: number,
  userId: number,
  body: string,
  now: Date
): EditCommentResult {
  const trimmed = body.trim();
  const invalid = checkBody(trimmed);
  if (invalid) return invalid;

  const existing = db
    .select()
    .from(comments)
    .where(eq(comments.id, commentId))
    .get();
  if (!existing) {
    return { ok: false, status: 404, error: "Comment not found" };
  }
  if (existing.deletedAt !== null) {
    return { ok: false, status: 400, error: "Comment has been deleted" };
  }
  if (existing.userId !== userId) {
    return {
      ok: false,
      status: 403,
      error: "You can only edit your own comments",
    };
  }

  const comment = db
    .update(comments)
    .set({ body: trimmed, editedAt: now.toISOString() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
  return { ok: true, comment };
}

function checkBody(trimmed: string): Failure | null {
  if (trimmed.length < MIN_COMMENT_LENGTH) {
    return { ok: false, status: 400, error: "Comment cannot be empty" };
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer`,
    };
  }
  return null;
}

type User = typeof users.$inferSelect;

type CommentedLesson = {
  id: number;
  title: string;
  course: typeof courses.$inferSelect;
};

/** New Question, to the course's Instructor. Their own Comments aren't Questions. */
function queueNewQuestion(
  tx: Queryable,
  lesson: CommentedLesson,
  asker: User,
  body: string,
  now: Date
): number[] {
  const instructor = getUser(tx, lesson.course.instructorId);
  if (!instructor) return [];

  return queueNotification(
    tx,
    "new-question",
    [toNotificationUser(instructor)],
    toNotificationUser(asker),
    {
      course_title: lesson.course.title,
      course_id: lesson.course.id,
      lesson_title: lesson.title,
      asker_name: asker.name,
      question_excerpt: quote(body),
      path: "/instructor/questions",
    },
    now
  );
}

/**
 * Reply, to the Question's author. Not for a deleted Question, nor for an
 * author with no Enrollment on the course (a Lapsed Student has none).
 */
function queueReply(
  tx: Queryable,
  lesson: CommentedLesson,
  question: Comment,
  replier: User,
  body: string,
  now: Date
): number[] {
  if (question.deletedAt !== null) return [];

  const author = tx
    .select({ user: users })
    .from(users)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, users.id),
        eq(enrollments.courseId, lesson.course.id)
      )
    )
    .where(eq(users.id, question.userId))
    .get()?.user;
  if (!author) return [];

  return queueNotification(
    tx,
    "reply",
    [toNotificationUser(author)],
    toNotificationUser(replier),
    {
      course_title: lesson.course.title,
      lesson_title: lesson.title,
      replier_name: replier.name,
      reply_excerpt: quote(body),
      path: `/courses/${lesson.course.slug}/lessons/${lesson.id}`,
    },
    now
  );
}

/** How much of a Comment a Notification quotes. Under Knock's 256-character cut. */
const QUOTE_LENGTH = 200;

/**
 * A Comment as a Notification quotes it: on one line, so its Markdown can't
 * start a list or heading in the feed sentence, and cut short with "…".
 */
function quote(body: string): string {
  const oneLine = body.replace(/\s+/g, " ");
  const characters = [...oneLine];
  return characters.length <= QUOTE_LENGTH
    ? oneLine
    : `${characters.slice(0, QUOTE_LENGTH - 1).join("")}…`;
}
