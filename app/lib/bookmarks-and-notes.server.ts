import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import * as schema from "~/db/schema";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";

// ─── Bookmarks and Notes ───
// Things a Student attaches to a Lesson for themselves and nobody else. A
// Bookmark is a flag; a Note is the Student's own writing. See GLOSSARY.md.
//
// Nothing here reads another Student's rows: every query is scoped to the
// Student it is asked about. Content access is the caller's job — the lesson
// route checks it before calling in.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;

export const MAX_NOTE_LENGTH = 2000;

// Plain text: trimmed and capped, never rendered as Markdown.
const noteBodySchema = z.string().trim().max(MAX_NOTE_LENGTH);

// Where a Bookmark or Note's Lesson lives, so the Saved page can link to it and
// name its Course.
const lessonPlace = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  moduleTitle: modules.title,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

function bookmarkOn(studentId: number, lessonId: number) {
  return and(eq(bookmarks.userId, studentId), eq(bookmarks.lessonId, lessonId));
}

function noteOn(studentId: number, lessonId: number) {
  return and(eq(notes.userId, studentId), eq(notes.lessonId, lessonId));
}

export function isBookmarked(db: Db, studentId: number, lessonId: number) {
  return !!db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(bookmarkOn(studentId, lessonId))
    .get();
}

/**
 * Bookmarks the Lesson, or removes the Bookmark if the Student already has one.
 * Returns whether the Lesson is now bookmarked.
 */
export function toggleBookmark(
  db: Db,
  studentId: number,
  lessonId: number,
  now: Date
): boolean {
  const removed = db
    .delete(bookmarks)
    .where(bookmarkOn(studentId, lessonId))
    .returning({ id: bookmarks.id })
    .all();
  if (removed.length > 0) return false;

  // The unique index on (user, lesson) turns a racing second insert into a
  // no-op rather than a duplicate or a crash.
  db.insert(bookmarks)
    .values({ userId: studentId, lessonId, createdAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  return true;
}

/** The Student's Bookmarks, newest first, each with its Lesson and Course. */
export function listBookmarks(db: Db, studentId: number) {
  return db
    .select({
      id: bookmarks.id,
      createdAt: bookmarks.createdAt,
      ...lessonPlace,
    })
    .from(bookmarks)
    .innerJoin(lessons, eq(bookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(bookmarks.userId, studentId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .all();
}

export function getNote(db: Db, studentId: number, lessonId: number) {
  return (
    db
      .select({ body: notes.body, updatedAt: notes.updatedAt })
      .from(notes)
      .where(noteOn(studentId, lessonId))
      .get() ?? null
  );
}

export type SaveNoteResult =
  | { ok: true; note: typeof notes.$inferSelect | null }
  | { ok: false; error: string };

/**
 * Saves the Student's Note on the Lesson. Saving again replaces the body and
 * moves the "last edited" time on; an empty body removes the Note. A body over
 * MAX_NOTE_LENGTH is refused, not truncated.
 */
export function saveNote(
  db: Db,
  studentId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const parsed = noteBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Notes can be at most ${MAX_NOTE_LENGTH.toLocaleString("en-US")} characters. Yours is ${body.trim().length.toLocaleString("en-US")}.`,
    };
  }

  if (parsed.data.length === 0) {
    db.delete(notes).where(noteOn(studentId, lessonId)).run();
    return { ok: true, note: null };
  }

  const at = now.toISOString();
  const note = db
    .insert(notes)
    .values({
      userId: studentId,
      lessonId,
      body: parsed.data,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: parsed.data, updatedAt: at },
    })
    .returning()
    .get();
  return { ok: true, note };
}

/** The Student's Notes, last edited first, each with its Lesson and Course. */
export function listNotes(db: Db, studentId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      ...lessonPlace,
    })
    .from(notes)
    .innerJoin(lessons, eq(notes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(notes.userId, studentId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
