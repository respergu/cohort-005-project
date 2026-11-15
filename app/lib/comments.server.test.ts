import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { listOutboxRows } from "./notification-outbox.server";
import { createComment, editComment } from "./comments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 10, 14, 12);

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
      "  How do I start?  ",
      NOW
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
      "Open the first module.",
      NOW
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
      const result = createComment(
        db,
        base.user.id,
        lessonId,
        null,
        "   \n ",
        NOW
      );

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
        "a".repeat(5001),
        NOW
      );

      expect(result).toEqual({
        ok: false,
        status: 400,
        error: "Comment must be 5000 characters or fewer",
      });
      expect(commentCount()).toBe(0);
    });

    it("an unknown lesson", () => {
      const result = createComment(db, base.user.id, 9999, null, "Hello?", NOW);

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
        "Open the first module.",
        NOW
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
        "Open the first module.",
        NOW
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
        "Open the first module.",
        NOW
      );
      if (!reply.ok) throw new Error(`Could not post a Reply: ${reply.error}`);

      const result = createComment(
        db,
        base.user.id,
        lessonId,
        reply.comment.id,
        "Thanks!",
        NOW
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

describe("the New Question Notification", () => {
  describe("posted from the lesson page", () => {
    it("is queued for the course's Instructor when a Student asks a Question", () => {
      const result = postOnLessonPage(base.user.id, null, "How do I start?");

      const [row] = listOutboxRows(db);
      expect(row.workflow).toBe("new-question");
      expect(row.recipients).toEqual([
        {
          id: base.instructor.knockId,
          name: "Test Instructor",
          email: "instructor@example.com",
        },
      ]);
      expect(result).toMatchObject({ ok: true, outboxRowIds: [row.id] });
    });

    it("names the asker as the actor, by Knock id, name and email only", () => {
      postOnLessonPage(base.user.id, null, "How do I start?");

      const [row] = listOutboxRows(db);
      expect(row.actor).toEqual({
        id: base.user.knockId,
        name: "Test User",
        email: "test@example.com",
      });
    });

    it("tells the Instructor who asked what, on which lesson, batches by course and opens the Questions page", () => {
      postOnLessonPage(base.user.id, null, "How do I start?");

      const [row] = listOutboxRows(db);
      expect(row.data).toEqual({
        course_title: "Test Course",
        course_id: base.course.id,
        lesson_title: "Lesson 1",
        asker_name: "Test User",
        question_excerpt: "How do I start?",
        path: "/instructor/questions",
      });
    });

    it("quotes the Question on one line, cut to 200 characters, so Knock's batch merge never cuts it", () => {
      postOnLessonPage(
        base.user.id,
        null,
        `Where do I start?\n\n- the   videos\n- the notes ${"x".repeat(300)}`
      );

      const [row] = listOutboxRows(db);
      const quote = row.data.question_excerpt;
      expect(quote).toBe(
        `Where do I start? - the videos - the notes ${"x".repeat(156)}…`
      );
      expect(String(quote)).toHaveLength(200);
    });

    it("is not queued for the Instructor's own top-level Comment", () => {
      const result = postOnLessonPage(
        base.instructor.id,
        null,
        "Welcome to the course!"
      );

      expect(listOutboxRows(db)).toEqual([]);
      expect(result).toMatchObject({ ok: true, outboxRowIds: [] });
    });

    it("is queued when a Platform Admin asks one, since only the Instructor's own Comments aren't Questions", () => {
      const admin = addUser("Pat Admin", schema.UserRole.Admin);

      postOnLessonPage(admin.id, null, "Is the first module required?");

      const [row] = listOutboxRows(db);
      expect(row.workflow).toBe("new-question");
      expect(row.recipients.map((recipient) => recipient.id)).toEqual([
        base.instructor.knockId,
      ]);
      expect(row.actor?.id).toBe(admin.knockId);
    });

    it("is not queued for a Reply", () => {
      const classmate = addStudent("Casey Classmate");
      const question = postQuestion();
      clearOutbox();

      postOnLessonPage(classmate.id, question.id, "Start with module one.");

      expect(workflowsQueued()).not.toContain("new-question");
    });
  });

  describe("posted from the Questions page", () => {
    it("is not queued for the Instructor's answer, which is a Reply", () => {
      const question = postQuestion();
      clearOutbox();

      answerFromQuestionsPage(base.instructor.id, question, "Open module one.");

      expect(workflowsQueued()).not.toContain("new-question");
    });
  });
});

describe("the Reply Notification", () => {
  beforeEach(() => {
    enrol(base.user.id);
  });

  describe("posted from the lesson page", () => {
    it("is queued for the Question's author when a classmate replies", () => {
      const classmate = addStudent("Casey Classmate");
      const question = postQuestion();
      clearOutbox();

      const result = postOnLessonPage(
        classmate.id,
        question.id,
        "Start with module one."
      );

      const [row] = listOutboxRows(db);
      expect(row.workflow).toBe("reply");
      expect(row.recipients).toEqual([
        { id: base.user.knockId, name: "Test User", email: "test@example.com" },
      ]);
      expect(result).toMatchObject({ ok: true, outboxRowIds: [row.id] });
    });

    it("names the replier as the actor, by Knock id, name and email only", () => {
      const classmate = addStudent("Casey Classmate");
      const question = postQuestion();
      clearOutbox();

      postOnLessonPage(classmate.id, question.id, "Start with module one.");

      const [row] = listOutboxRows(db);
      expect(row.actor).toEqual({
        id: classmate.knockId,
        name: "Casey Classmate",
        email: "casey@example.com",
      });
    });

    it("tells the author who replied what, on which lesson, and opens the lesson, without the replier's email", () => {
      const classmate = addStudent("Casey Classmate");
      const question = postQuestion();
      clearOutbox();

      postOnLessonPage(classmate.id, question.id, "Start with\nmodule one.");

      const [row] = listOutboxRows(db);
      expect(row.data).toEqual({
        course_title: "Test Course",
        lesson_title: "Lesson 1",
        replier_name: "Casey Classmate",
        reply_excerpt: "Start with module one.",
        path: `/courses/test-course/lessons/${lessonId}`,
      });
    });

    it("is not queued when the author replies to their own Question", () => {
      const question = postQuestion();
      clearOutbox();

      const result = postOnLessonPage(
        base.user.id,
        question.id,
        "Never mind, I found it."
      );

      expect(listOutboxRows(db)).toEqual([]);
      expect(result).toMatchObject({ ok: true, outboxRowIds: [] });
    });

    it("is not queued when the Question has been deleted", () => {
      const classmate = addStudent("Casey Classmate");
      const question = postQuestion();
      deleteComment(question.id);
      clearOutbox();

      postOnLessonPage(classmate.id, question.id, "Start with module one.");

      expect(listOutboxRows(db)).toEqual([]);
    });

    it("is not queued when the author no longer has an Enrollment on the course", () => {
      const classmate = addStudent("Casey Classmate");
      const question = postQuestion();
      lapse(base.user.id);
      clearOutbox();

      postOnLessonPage(classmate.id, question.id, "Start with module one.");

      expect(listOutboxRows(db)).toEqual([]);
    });
  });

  describe("posted from the Questions page", () => {
    it("is queued for the Question's author when the Instructor answers", () => {
      const question = postQuestion();
      clearOutbox();

      const result = answerFromQuestionsPage(
        base.instructor.id,
        question,
        "Open module one."
      );

      const [row] = listOutboxRows(db);
      expect(row.workflow).toBe("reply");
      expect(row.recipients.map((recipient) => recipient.id)).toEqual([
        base.user.knockId,
      ]);
      expect(row.actor?.id).toBe(base.instructor.knockId);
      expect(row.data).toMatchObject({
        replier_name: "Test Instructor",
        path: `/courses/test-course/lessons/${lessonId}`,
      });
      expect(result).toMatchObject({ ok: true, outboxRowIds: [row.id] });
    });

    it("is queued for the Question's author when a Platform Admin answers", () => {
      const admin = addUser("Pat Admin", schema.UserRole.Admin);
      const question = postQuestion();
      clearOutbox();

      answerFromQuestionsPage(admin.id, question, "Open module one.");

      const [row] = listOutboxRows(db);
      expect(row.workflow).toBe("reply");
      expect(row.recipients.map((recipient) => recipient.id)).toEqual([
        base.user.knockId,
      ]);
    });

    it("is not queued when a Platform Admin answers their own Question", () => {
      const admin = addUser("Pat Admin", schema.UserRole.Admin);
      enrol(admin.id);
      const question = postQuestionAs(admin.id);
      clearOutbox();

      answerFromQuestionsPage(admin.id, question, "Answering myself.");

      expect(listOutboxRows(db)).toEqual([]);
    });

    it("is not queued when the Question has been deleted", () => {
      const question = postQuestion();
      deleteComment(question.id);
      clearOutbox();

      answerFromQuestionsPage(base.instructor.id, question, "Open module one.");

      expect(listOutboxRows(db)).toEqual([]);
    });

    it("is not queued when the author no longer has an Enrollment on the course", () => {
      const question = postQuestion();
      lapse(base.user.id);
      clearOutbox();

      answerFromQuestionsPage(base.instructor.id, question, "Open module one.");

      expect(listOutboxRows(db)).toEqual([]);
    });
  });

  it("is not queued for an Enrollment on a different course", () => {
    const otherCourse = db
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
    const question = postQuestion();
    lapse(base.user.id);
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: otherCourse.id })
      .run();
    clearOutbox();

    answerFromQuestionsPage(base.instructor.id, question, "Open module one.");

    expect(listOutboxRows(db)).toEqual([]);
  });
});

describe("editing a Comment", () => {
  beforeEach(() => {
    enrol(base.user.id);
  });

  it("queues no Notification for an edited Question", () => {
    const question = postQuestion();
    clearOutbox();

    const result = editComment(
      db,
      question.id,
      base.user.id,
      "How do I start the course?",
      NOW
    );

    expect(result).toMatchObject({
      ok: true,
      comment: { body: "How do I start the course?" },
    });
    expect(listOutboxRows(db)).toEqual([]);
  });

  it("queues no Notification for an edited Reply", () => {
    const question = postQuestion();
    const reply = answerFromQuestionsPage(
      base.instructor.id,
      question,
      "Open module one."
    );
    if (!reply.ok) throw new Error(`Could not post a Reply: ${reply.error}`);
    clearOutbox();

    editComment(
      db,
      reply.comment.id,
      base.instructor.id,
      "Open module 1.",
      NOW
    );

    expect(listOutboxRows(db)).toEqual([]);
  });

  it("refuses someone else's Comment", () => {
    const question = postQuestion();

    const result = editComment(
      db,
      question.id,
      base.instructor.id,
      "Hijacked",
      NOW
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "You can only edit your own comments",
    });
  });
});

/** What the lesson page's create-comment action posts. */
function postOnLessonPage(
  userId: number,
  parentId: number | null,
  body: string
) {
  return createComment(db, userId, lessonId, parentId, body, NOW);
}

/**
 * What the Questions page's reply action posts: a Reply on the Question's own
 * lesson, by the course's Instructor or a Platform Admin.
 */
function answerFromQuestionsPage(
  userId: number,
  question: { id: number; lessonId: number },
  body: string
) {
  return createComment(db, userId, question.lessonId, question.id, body, NOW);
}

function addUser(name: string, role: schema.UserRole) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.split(" ")[0].toLowerCase()}@example.com`,
      role,
    })
    .returning()
    .get();
}

function addStudent(name: string) {
  return addUser(name, schema.UserRole.Student);
}

function enrol(userId: number) {
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

/** A Lapse: approving a Refund Request deletes the Enrollment (ADR 0002). */
function lapse(userId: number) {
  db.delete(schema.enrollments)
    .where(eq(schema.enrollments.userId, userId))
    .run();
}

/** A soft delete, as the lesson page's delete-comment action does. */
function deleteComment(commentId: number) {
  db.update(schema.comments)
    .set({ deletedAt: NOW.toISOString() })
    .where(eq(schema.comments.id, commentId))
    .run();
}

function clearOutbox() {
  db.delete(schema.notificationOutbox).run();
}

function workflowsQueued() {
  return listOutboxRows(db).map((row) => row.workflow);
}

function commentCount() {
  return db.select().from(schema.comments).all().length;
}

function postQuestion(onLessonId = lessonId) {
  return postQuestionAs(base.user.id, onLessonId);
}

function postQuestionAs(userId: number, onLessonId = lessonId) {
  const result = createComment(
    db,
    userId,
    onLessonId,
    null,
    "How do I start?",
    NOW
  );
  if (!result.ok) throw new Error(`Could not post a Question: ${result.error}`);
  return result.comment;
}
