import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { createLesson, updateLesson } from "./lessons.server";

type TestDb = ReturnType<typeof createTestDb>;

let db: TestDb;
let moduleId: number;

beforeEach(() => {
  db = createTestDb();
  const base = seedBaseData(db);
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
      5
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
      null
    );

    expect(lesson.videoUrl).toBe("https://videos.example.com/setup.mp4");
    expect(videoAdded).toBe(true);
  });

  it("puts a lesson created without a position at the end of its module", () => {
    createLesson(db, moduleId, "First", null, null, 1, null);
    createLesson(db, moduleId, "Second", null, null, 2, null);
    createLesson(db, moduleId, "Fourth", null, null, 4, null);

    const { lesson } = createLesson(db, moduleId, "Last", null, null, null, null);

    expect(lesson.position).toBe(5);
  });

  it("puts the first lesson of an empty module at position 1", () => {
    const { lesson } = createLesson(db, moduleId, "Only", null, null, null, null);

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
    const result = updateLesson(db, lessonId, changes);

    expect(result?.lesson).toMatchObject({ ...original, ...changes });
  });

  it("leaves the fields it isn't given as they were", () => {
    const result = updateLesson(db, lessonId, { content: "Only this changes" });

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
    const result = updateLesson(db, lessonId, {});

    expect(result).toEqual({
      lesson: expect.objectContaining(original),
      videoAdded: false,
    });
  });

  it("treats a field given as undefined as left out", () => {
    const result = updateLesson(db, lessonId, {
      videoUrl: undefined,
      durationMinutes: undefined,
    });

    expect(result?.lesson).toMatchObject(original);
  });

  it("returns null for a lesson that doesn't exist", () => {
    expect(updateLesson(db, lessonId + 100, { title: "Nope" })).toBeNull();
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
      const result = updateLesson(db, emptyLessonId, {
        videoUrl: "https://videos.example.com/first.mp4",
      });

      expect(result?.videoAdded).toBe(true);
    });

    it("doesn't when an existing video is replaced", () => {
      const result = updateLesson(db, lessonId, {
        videoUrl: "https://videos.example.com/replacement.mp4",
      });

      expect(result?.videoAdded).toBe(false);
    });

    it("doesn't when the video is cleared", () => {
      const result = updateLesson(db, lessonId, { videoUrl: null });

      expect(result?.lesson.videoUrl).toBeNull();
      expect(result?.videoAdded).toBe(false);
    });

    it("treats a blank video as empty", () => {
      const blankLessonId = db
        .insert(schema.lessons)
        .values({ moduleId, position: 3, title: "Blank video", videoUrl: "" })
        .returning()
        .get().id;

      const result = updateLesson(db, blankLessonId, {
        videoUrl: "https://videos.example.com/first.mp4",
      });

      expect(result?.videoAdded).toBe(true);
    });

    it("doesn't when a lesson without a video is edited in other ways", () => {
      const result = updateLesson(db, emptyLessonId, { title: "Still no video" });

      expect(result?.videoAdded).toBe(false);
    });
  });
});
