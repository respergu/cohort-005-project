import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { comments, lessons } from "~/db/schema";
import { MAX_COMMENT_LENGTH, MIN_COMMENT_LENGTH } from "~/lib/comments";

// ─── Comments ───
// Posting a Comment on a lesson: a top-level Comment or a Reply. The lesson
// page and the Instructor's Questions page both post through here, so they
// apply the same rules. See GLOSSARY.md for Comment, Question and Reply.
//
// Takes the database first, so tests can hand in an in-memory one. Uses
// positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;

type Comment = typeof comments.$inferSelect;

export type Failure = { ok: false; status: 400 | 404; error: string };

export type CreateCommentResult = { ok: true; comment: Comment } | Failure;

export function createComment(
  db: Db,
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string
): CreateCommentResult {
  const trimmed = body.trim();

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

  return db.transaction((tx): CreateCommentResult => {
    const lesson = tx
      .select({ id: lessons.id })
      .from(lessons)
      .where(eq(lessons.id, lessonId))
      .get();
    if (!lesson) {
      return { ok: false, status: 404, error: "Lesson not found" };
    }

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
    }

    const comment = tx
      .insert(comments)
      .values({ userId, lessonId, parentId, body: trimmed })
      .returning()
      .get();

    return { ok: true, comment };
  });
}
