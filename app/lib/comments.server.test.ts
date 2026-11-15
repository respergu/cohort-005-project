import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { createComment } from "./comments.server";

type TestDb = ReturnType<typeof createTestDb>;

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let moduleId: number;
let lessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  moduleId = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get().id;

  lessonId = addLesson("Lesson 1", 1);
});

function addLesson(title: string, position: number) {
  return db
    .insert(schema.lessons)
    .values({ moduleId, title, position })
    .returning()
    .get().id;
}

describe("createComment", () => {
  it("posts a top-level Comment on a lesson", () => {
    const result = createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "  How do I start?  "
    );

    expect(result).toMatchObject({
      ok: true,
      comment: {
        userId: base.user.id,
        lessonId,
        parentId: null,
        body: "How do I start?",
      },
    });
  });

  it("posts a Reply to a top-level Comment on the same lesson", () => {
    const question = postQuestion();

    const result = createComment(
      db,
      base.instructor.id,
      lessonId,
      question.id,
      "Open the first module."
    );

    expect(result).toMatchObject({
      ok: true,
      comment: {
        userId: base.instructor.id,
        lessonId,
        parentId: question.id,
        body: "Open the first module.",
      },
    });
  });

  describe("refuses", () => {
    it("an empty body", () => {
      const result = createComment(db, base.user.id, lessonId, null, "   \n ");

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "Comment cannot be empty",
      });
      expect(commentCount()).toBe(0);
    });

    it("a body over 5000 characters", () => {
      const result = createComment(
        db,
        base.user.id,
        lessonId,
        null,
        "a".repeat(5001)
      );

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "Comment must be 5000 characters or fewer",
      });
      expect(commentCount()).toBe(0);
    });

    it("an unknown lesson", () => {
      const result = createComment(db, base.user.id, 9999, null, "Hello?");

      expect(result).toEqual({
        ok: false,
        status: 404,
        error: "Lesson not found",
      });
      expect(commentCount()).toBe(0);
    });

    it("an unknown parent", () => {
      const result = createComment(
        db,
        base.instructor.id,
        lessonId,
        9999,
        "Open the first module."
      );

      expect(result).toEqual({
        ok: false,
        status: 404,
        error: "Parent comment not found",
      });
      expect(commentCount()).toBe(0);
    });

    it("a parent on a different lesson", () => {
      const otherLessonId = addLesson("Lesson 2", 2);
      const question = postQuestion(otherLessonId);

      const result = createComment(
        db,
        base.instructor.id,
        lessonId,
        question.id,
        "Open the first module."
      );

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "Parent comment belongs to a different lesson",
      });
      expect(commentCount()).toBe(1);
    });

    it("a Reply to a Reply", () => {
      const question = postQuestion();
      const reply = createComment(
        db,
        base.instructor.id,
        lessonId,
        question.id,
        "Open the first module."
      );
      if (!reply.ok) throw new Error(`Could not post a Reply: ${reply.error}`);

      const result = createComment(
        db,
        base.user.id,
        lessonId,
        reply.comment.id,
        "Thanks!"
      );

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "Replies can only be one level deep",
      });
      expect(commentCount()).toBe(2);
    });
  });
});

function commentCount() {
  return db.select().from(schema.comments).all().length;
}

function postQuestion(onLessonId = lessonId) {
  const result = createComment(
    db,
    base.user.id,
    onLessonId,
    null,
    "How do I start?"
  );
  if (!result.ok) throw new Error(`Could not post a Question: ${result.error}`);
  return result.comment;
}
