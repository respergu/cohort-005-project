import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { lessons } from "~/db/schema";

// ─── Lessons ───
// Creating and editing a lesson. Both run in one transaction, so that a
// Notification about the lesson can be written alongside it (docs/adr/0014).
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Queryable = Db | Tx;

export type Lesson = typeof lessons.$inferSelect;

export type LessonWrite = {
  lesson: Lesson;
  /** The lesson's video went from empty to set. */
  videoAdded: boolean;
};

export function createLesson(
  db: Db,
  moduleId: number,
  title: string,
  content: string | null,
  videoUrl: string | null,
  position: number | null,
  durationMinutes: number | null
): LessonWrite {
  return db.transaction((tx): LessonWrite => {
    const lesson = tx
      .insert(lessons)
      .values({
        moduleId,
        title,
        content,
        videoUrl,
        position: position ?? nextPosition(tx, moduleId),
        durationMinutes,
      })
      .returning()
      .get();

    return { lesson, videoAdded: hasVideo(lesson) };
  });
}

/** The fields an Instructor edits. Leave a field out to keep it as it is. */
export type LessonChanges = Partial<
  Pick<
    Lesson,
    "title" | "content" | "videoUrl" | "durationMinutes" | "githubRepoUrl"
  >
>;

export function updateLesson(
  db: Db,
  lessonId: number,
  changes: LessonChanges
): LessonWrite | null {
  return db.transaction((tx): LessonWrite | null => {
    const before = tx
      .select()
      .from(lessons)
      .where(eq(lessons.id, lessonId))
      .get();

    if (!before) return null;
    if (Object.values(changes).every((value) => value === undefined)) {
      return { lesson: before, videoAdded: false };
    }

    const lesson = tx
      .update(lessons)
      .set(changes)
      .where(eq(lessons.id, lessonId))
      .returning()
      .get();

    return { lesson, videoAdded: !hasVideo(before) && hasVideo(lesson) };
  });
}

function nextPosition(db: Queryable, moduleId: number): number {
  const last = db
    .select({ max: sql<number>`coalesce(max(${lessons.position}), 0)` })
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .get();

  return (last?.max ?? 0) + 1;
}

// Blank counts as empty, the same as everywhere a lesson's video is shown.
function hasVideo(lesson: Lesson): boolean {
  return Boolean(lesson.videoUrl);
}
