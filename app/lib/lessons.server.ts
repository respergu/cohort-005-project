import { asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  CourseStatus,
  courses,
  enrollments,
  lessons,
  modules,
  users,
} from "~/db/schema";
import {
  queueNotification,
  toNotificationUser,
} from "~/lib/notification-outbox.server";

// ─── Lessons ───
// Creating and editing a lesson. Both run in one transaction, which also
// queues New lesson when the lesson gets its first video (docs/adr/0014).
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
  /** For the route to hand to sendInBackground after the commit. */
  outboxRowIds: number[];
};

export function createLesson(
  db: Db,
  moduleId: number,
  title: string,
  content: string | null,
  videoUrl: string | null,
  position: number | null,
  durationMinutes: number | null,
  actorId: number,
  now: Date
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

    const videoAdded = hasVideo(lesson);
    const outboxRowIds = videoAdded
      ? queueNewLesson(tx, lesson, actorId, now)
      : [];

    return { lesson, videoAdded, outboxRowIds };
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
  changes: LessonChanges,
  actorId: number,
  now: Date
): LessonWrite | null {
  return db.transaction((tx): LessonWrite | null => {
    const before = tx
      .select()
      .from(lessons)
      .where(eq(lessons.id, lessonId))
      .get();

    if (!before) return null;
    if (Object.values(changes).every((value) => value === undefined)) {
      return { lesson: before, videoAdded: false, outboxRowIds: [] };
    }

    const lesson = tx
      .update(lessons)
      .set(changes)
      .where(eq(lessons.id, lessonId))
      .returning()
      .get();

    const videoAdded = !hasVideo(before) && hasVideo(lesson);
    const outboxRowIds = videoAdded
      ? queueNewLesson(tx, lesson, actorId, now)
      : [];

    return { lesson, videoAdded, outboxRowIds };
  });
}

/**
 * Queues New lesson for everyone with an Enrollment on the lesson's course,
 * if it's Published. A Draft course never fires, not even once it's published.
 */
function queueNewLesson(
  tx: Tx,
  lesson: Lesson,
  actorId: number,
  now: Date
): number[] {
  const course = tx
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      status: courses.status,
    })
    .from(modules)
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(modules.id, lesson.moduleId))
    .get();
  if (course?.status !== CourseStatus.Published) return [];

  const enrolled = tx
    .select({ knockId: users.knockId, name: users.name, email: users.email })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(eq(enrollments.courseId, course.id))
    .orderBy(asc(users.id))
    .all();
  const actor = tx.select().from(users).where(eq(users.id, actorId)).get();

  return queueNotification(
    tx,
    "new-lesson",
    enrolled.map(toNotificationUser),
    actor ? toNotificationUser(actor) : null,
    {
      course_title: course.title,
      path: `/courses/${course.slug}`,
      course_id: course.id,
      lesson_title: lesson.title,
    },
    now
  );
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
