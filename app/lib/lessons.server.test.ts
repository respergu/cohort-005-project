import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { listOutboxRows } from "~/lib/notification-outbox.server";
import { createLesson, updateLesson } from "./lessons.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 10, 14, 12);
const VIDEO = "https://videos.example.com/first.mp4";

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let moduleId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  moduleId = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get().id;
});

describe("createLesson", () => {
  it("creates a lesson without a video", () => {
    const { lesson, videoAdded } = createLesson(
      db,
      moduleId,
      "Welcome",
      "Hello there",
      null,
      1,
      5,
      base.instructor.id,
      NOW
    );

    expect(lesson).toMatchObject({
      moduleId,
      title: "Welcome",
      content: "Hello there",
      videoUrl: null,
      position: 1,
      durationMinutes: 5,
    });
    expect(videoAdded).toBe(false);
  });

  it("creates a lesson with a video, which counts as the video being added", () => {
    const { lesson, videoAdded } = createLesson(
      db,
      moduleId,
      "Setup",
      null,
      "https://videos.example.com/setup.mp4",
      1,
      null,
      base.instructor.id,
      NOW
    );

    expect(lesson.videoUrl).toBe("https://videos.example.com/setup.mp4");
    expect(videoAdded).toBe(true);
  });

  it("puts a lesson created without a position at the end of its module", () => {
    createLesson(
      db,
      moduleId,
      "First",
      null,
      null,
      1,
      null,
      base.instructor.id,
      NOW
    );
    createLesson(
      db,
      moduleId,
      "Second",
      null,
      null,
      2,
      null,
      base.instructor.id,
      NOW
    );
    createLesson(
      db,
      moduleId,
      "Fourth",
      null,
      null,
      4,
      null,
      base.instructor.id,
      NOW
    );

    const { lesson } = createLesson(
      db,
      moduleId,
      "Last",
      null,
      null,
      null,
      null,
      base.instructor.id,
      NOW
    );

    expect(lesson.position).toBe(5);
  });

  it("puts the first lesson of an empty module at position 1", () => {
    const { lesson } = createLesson(
      db,
      moduleId,
      "Only",
      null,
      null,
      null,
      null,
      base.instructor.id,
      NOW
    );

    expect(lesson.position).toBe(1);
  });
});

describe("updateLesson", () => {
  const original = {
    title: "Original title",
    content: "Original content",
    videoUrl: "https://videos.example.com/original.mp4",
    durationMinutes: 10,
    githubRepoUrl: "https://github.com/example/original",
  };

  let lessonId: number;

  beforeEach(() => {
    lessonId = db
      .insert(schema.lessons)
      .values({ moduleId, position: 1, ...original })
      .returning()
      .get().id;
  });

  it.each([
    ["title", { title: "New title" }],
    ["content", { content: "New content" }],
    ["video", { videoUrl: "https://videos.example.com/new.mp4" }],
    ["duration", { durationMinutes: 25 }],
    ["GitHub repo", { githubRepoUrl: "https://github.com/example/new" }],
  ] as const)("updates the %s", (_field, changes) => {
    const result = updateLesson(db, lessonId, changes, base.instructor.id, NOW);

    expect(result?.lesson).toMatchObject({ ...original, ...changes });
  });

  it("leaves the fields it isn't given as they were", () => {
    const result = updateLesson(
      db,
      lessonId,
      { content: "Only this changes" },
      base.instructor.id,
      NOW
    );

    expect(result?.lesson).toMatchObject({
      title: "Original title",
      content: "Only this changes",
      videoUrl: "https://videos.example.com/original.mp4",
      durationMinutes: 10,
      githubRepoUrl: "https://github.com/example/original",
      position: 1,
      moduleId,
    });
  });

  it("returns the lesson as it was when given no changes", () => {
    const result = updateLesson(db, lessonId, {}, base.instructor.id, NOW);

    expect(result).toEqual({
      lesson: expect.objectContaining(original),
      videoAdded: false,
      outboxRowIds: [],
    });
  });

  it("treats a field given as undefined as left out", () => {
    const result = updateLesson(
      db,
      lessonId,
      {
        videoUrl: undefined,
        durationMinutes: undefined,
      },
      base.instructor.id,
      NOW
    );

    expect(result?.lesson).toMatchObject(original);
  });

  it("returns null for a lesson that doesn't exist", () => {
    expect(
      updateLesson(
        db,
        lessonId + 100,
        { title: "Nope" },
        base.instructor.id,
        NOW
      )
    ).toBeNull();
  });

  describe("telling whether the video was added", () => {
    let emptyLessonId: number;

    beforeEach(() => {
      emptyLessonId = db
        .insert(schema.lessons)
        .values({ moduleId, position: 2, title: "No video yet" })
        .returning()
        .get().id;
    });

    it("says so when the video goes from empty to set", () => {
      const result = updateLesson(
        db,
        emptyLessonId,
        {
          videoUrl: "https://videos.example.com/first.mp4",
        },
        base.instructor.id,
        NOW
      );

      expect(result?.videoAdded).toBe(true);
    });

    it("doesn't when an existing video is replaced", () => {
      const result = updateLesson(
        db,
        lessonId,
        {
          videoUrl: "https://videos.example.com/replacement.mp4",
        },
        base.instructor.id,
        NOW
      );

      expect(result?.videoAdded).toBe(false);
    });

    it("doesn't when the video is cleared", () => {
      const result = updateLesson(
        db,
        lessonId,
        { videoUrl: null },
        base.instructor.id,
        NOW
      );

      expect(result?.lesson.videoUrl).toBeNull();
      expect(result?.videoAdded).toBe(false);
    });

    it("treats a blank video as empty", () => {
      const blankLessonId = db
        .insert(schema.lessons)
        .values({ moduleId, position: 3, title: "Blank video", videoUrl: "" })
        .returning()
        .get().id;

      const result = updateLesson(
        db,
        blankLessonId,
        {
          videoUrl: "https://videos.example.com/first.mp4",
        },
        base.instructor.id,
        NOW
      );

      expect(result?.videoAdded).toBe(true);
    });

    it("doesn't when a lesson without a video is edited in other ways", () => {
      const result = updateLesson(
        db,
        emptyLessonId,
        { title: "Still no video" },
        base.instructor.id,
        NOW
      );

      expect(result?.videoAdded).toBe(false);
    });
  });
});

describe("the New lesson Notification", () => {
  let lessonId: number;

  function addStudent(name: string) {
    return db
      .insert(schema.users)
      .values({
        name,
        email: `${name.split(" ")[0].toLowerCase()}@example.com`,
        role: schema.UserRole.Student,
      })
      .returning()
      .get();
  }

  function enroll(userId: number) {
    db.insert(schema.enrollments)
      .values({ userId, courseId: base.course.id })
      .run();
  }

  beforeEach(() => {
    enroll(base.user.id);
    lessonId = db
      .insert(schema.lessons)
      .values({ moduleId, position: 1, title: "Routing" })
      .returning()
      .get().id;
  });

  it("is queued for every Student enrolled on the course when a lesson gets its first video", () => {
    const sam = addStudent("Sam Student");
    enroll(sam.id);

    updateLesson(db, lessonId, { videoUrl: VIDEO }, base.instructor.id, NOW);

    const [row] = listOutboxRows(db);
    expect(row.workflow).toBe("new-lesson");
    expect(row.recipients).toEqual([
      { id: base.user.knockId, name: "Test User", email: "test@example.com" },
      { id: sam.knockId, name: "Sam Student", email: "sam@example.com" },
    ]);
  });

  it("tells them which course and lesson, keyed by the course, and opens the course page", () => {
    updateLesson(db, lessonId, { videoUrl: VIDEO }, base.instructor.id, NOW);

    const [row] = listOutboxRows(db);
    expect(row.data).toEqual({
      course_title: "Test Course",
      course_id: base.course.id,
      lesson_title: "Routing",
      path: "/courses/test-course",
    });
    expect(row.createdAt).toBe(NOW.toISOString());
  });

  it("names whoever added the video as the actor", () => {
    updateLesson(db, lessonId, { videoUrl: VIDEO }, base.instructor.id, NOW);

    const [row] = listOutboxRows(db);
    expect(row.actor).toEqual({
      id: base.instructor.knockId,
      name: "Test Instructor",
      email: "instructor@example.com",
    });
  });

  it("returns the rows it queued, for the route to send", () => {
    const result = updateLesson(
      db,
      lessonId,
      { videoUrl: VIDEO },
      base.instructor.id,
      NOW
    );

    expect(result?.outboxRowIds).toEqual(listOutboxRows(db).map((r) => r.id));
    expect(result?.outboxRowIds).toHaveLength(1);
  });

  it("is queued when a lesson is created with a video", () => {
    const result = createLesson(
      db,
      moduleId,
      "Loaders",
      null,
      VIDEO,
      null,
      null,
      base.instructor.id,
      NOW
    );

    const [row] = listOutboxRows(db);
    expect(row).toMatchObject({
      workflow: "new-lesson",
      recipients: [{ id: base.user.knockId }],
      data: { lesson_title: "Loaders" },
    });
    expect(result.outboxRowIds).toEqual([row.id]);
  });

  describe("is never queued", () => {
    function setCourseStatus(status: schema.CourseStatus) {
      db.update(schema.courses)
        .set({ status })
        .where(eq(schema.courses.id, base.course.id))
        .run();
    }

    it.each([
      ["a Draft", schema.CourseStatus.Draft],
      ["an Archived", schema.CourseStatus.Archived],
    ])("for a lesson on %s course", (_name, status) => {
      setCourseStatus(status);

      const updated = updateLesson(
        db,
        lessonId,
        { videoUrl: VIDEO },
        base.instructor.id,
        NOW
      );
      const created = createLesson(
        db,
        moduleId,
        "Loaders",
        null,
        VIDEO,
        null,
        null,
        base.instructor.id,
        NOW
      );

      expect(updated?.videoAdded).toBe(true);
      expect(created.videoAdded).toBe(true);
      expect(updated?.outboxRowIds).toEqual([]);
      expect(created.outboxRowIds).toEqual([]);
      expect(listOutboxRows(db)).toEqual([]);
    });

    it("for a Draft course's lessons once it's published", () => {
      setCourseStatus(schema.CourseStatus.Draft);
      updateLesson(db, lessonId, { videoUrl: VIDEO }, base.instructor.id, NOW);

      setCourseStatus(schema.CourseStatus.Published);
      updateLesson(
        db,
        lessonId,
        { title: "Routing, again" },
        base.instructor.id,
        NOW
      );

      expect(listOutboxRows(db)).toEqual([]);
    });

    it("when a lesson is created without a video", () => {
      const result = createLesson(
        db,
        moduleId,
        "Loaders",
        "Notes only",
        null,
        null,
        null,
        base.instructor.id,
        NOW
      );

      expect(result.outboxRowIds).toEqual([]);
      expect(listOutboxRows(db)).toEqual([]);
    });

    it.each([
      ["its video replaced", { videoUrl: "https://videos.example.com/v2.mp4" }],
      ["its title edited", { title: "Routing in depth" }],
      ["its content edited", { content: "New notes" }],
      ["its duration edited", { durationMinutes: 12 }],
      ["its GitHub repo edited", { githubRepoUrl: "https://github.com/x/y" }],
    ] as const)("when a lesson with a video has %s", (_edit, changes) => {
      updateLesson(db, lessonId, { videoUrl: VIDEO }, base.instructor.id, NOW);
      const [first] = listOutboxRows(db);

      const result = updateLesson(
        db,
        lessonId,
        changes,
        base.instructor.id,
        NOW
      );

      expect(result?.outboxRowIds).toEqual([]);
      expect(listOutboxRows(db)).toEqual([first]);
    });

    it("when a lesson without a video is edited in other ways", () => {
      updateLesson(
        db,
        lessonId,
        { title: "Still no video", content: "Coming soon" },
        base.instructor.id,
        NOW
      );

      expect(listOutboxRows(db)).toEqual([]);
    });
  });

  describe("goes only to people with a current Enrollment on the course", () => {
    it("leaves out whoever added the video, even when they're enrolled", () => {
      enroll(base.instructor.id);

      updateLesson(db, lessonId, { videoUrl: VIDEO }, base.instructor.id, NOW);

      const [row] = listOutboxRows(db);
      expect(row.recipients.map((r) => r.id)).toEqual([base.user.knockId]);
    });

    it("leaves out a Lapsed Student, who has progress but no Enrollment", () => {
      const lapsed = addStudent("Lee Lapsed");
      enroll(lapsed.id);
      db.insert(schema.lessonProgress)
        .values({
          userId: lapsed.id,
          lessonId,
          status: schema.LessonProgressStatus.Completed,
        })
        .run();
      // Approving a Refund Request deletes the Enrollment (docs/adr/0002).
      db.delete(schema.enrollments)
        .where(eq(schema.enrollments.userId, lapsed.id))
        .run();

      updateLesson(db, lessonId, { videoUrl: VIDEO }, base.instructor.id, NOW);

      const [row] = listOutboxRows(db);
      expect(row.recipients.map((r) => r.id)).toEqual([base.user.knockId]);
    });

    it("leaves out Students enrolled only on another course", () => {
      const other = db
        .insert(schema.courses)
        .values({
          title: "Other Course",
          slug: "other-course",
          description: "Another course",
          salesCopy: "## Other Course",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
      const elsewhere = addStudent("Eli Elsewhere");
      db.insert(schema.enrollments)
        .values({ userId: elsewhere.id, courseId: other.id })
        .run();

      updateLesson(db, lessonId, { videoUrl: VIDEO }, base.instructor.id, NOW);

      const [row] = listOutboxRows(db);
      expect(row.recipients.map((r) => r.id)).toEqual([base.user.knockId]);
    });

    it("writes nothing when nobody else is enrolled", () => {
      db.delete(schema.enrollments).run();
      enroll(base.instructor.id);

      const result = updateLesson(
        db,
        lessonId,
        { videoUrl: VIDEO },
        base.instructor.id,
        NOW
      );

      expect(result?.videoAdded).toBe(true);
      expect(result?.outboxRowIds).toEqual([]);
      expect(listOutboxRows(db)).toEqual([]);
    });
  });

  it("splits an audience of more than 1,000 across rows of at most 1,000, each with its own idempotency key", () => {
    const students = db
      .insert(schema.users)
      .values(
        Array.from({ length: 1000 }, (_, i) => ({
          name: `Student ${i}`,
          email: `student${i}@example.com`,
          role: schema.UserRole.Student,
        }))
      )
      .returning()
      .all();
    db.insert(schema.enrollments)
      .values(students.map((s) => ({ userId: s.id, courseId: base.course.id })))
      .run();

    const result = updateLesson(
      db,
      lessonId,
      { videoUrl: VIDEO },
      base.instructor.id,
      NOW
    );

    const rows = listOutboxRows(db);
    expect(rows.map((row) => row.recipients.length)).toEqual([1000, 1]);
    expect(rows.map((row) => row.workflow)).toEqual([
      "new-lesson",
      "new-lesson",
    ]);
    expect(
      new Set(rows.flatMap((row) => row.recipients.map((r) => r.id))).size
    ).toBe(1001);
    expect(rows[0].idempotencyKey).not.toBe(rows[1].idempotencyKey);
    expect(rows[1].data).toEqual(rows[0].data);
    expect(result?.outboxRowIds).toEqual(rows.map((row) => row.id));
  });
});
