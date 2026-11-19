import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { QuestionType } from "~/db/schema";
import { bestQuizAttempt, submitQuizAttempt } from "./quiz-attempts.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

type QuizQuestion = { id: number; rightOptionId: number; wrongOptionId: number };

/** A Quiz on the Lesson, with one right and one wrong option per question. */
function addQuiz(lessonId: number, passingScore: number, questionCount: number) {
  const quiz = db
    .insert(schema.quizzes)
    .values({ lessonId, title: "Check your understanding", passingScore })
    .returning()
    .get();

  const questions: QuizQuestion[] = [];
  for (let position = 1; position <= questionCount; position++) {
    const question = db
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz.id,
        questionText: `Question ${position}`,
        questionType: QuestionType.MultipleChoice,
        position,
      })
      .returning()
      .get();
    const [right, wrong] = [true, false].map((isCorrect) =>
      db
        .insert(schema.quizOptions)
        .values({
          questionId: question.id,
          optionText: isCorrect ? "Right" : "Wrong",
          isCorrect,
        })
        .returning()
        .get()
    );
    questions.push({
      id: question.id,
      rightOptionId: right.id,
      wrongOptionId: wrong.id,
    });
  }

  return { quizId: quiz.id, questions };
}

/** Answers every question: the first `rightCount` right, the rest wrong. */
function answer(questions: QuizQuestion[], rightCount: number) {
  return Object.fromEntries(
    questions.map((q, i) => [
      q.id,
      i < rightCount ? q.rightOptionId : q.wrongOptionId,
    ])
  );
}

describe("grading a Quiz Attempt", () => {
  it("passes a Student who reaches the Quiz's own pass mark", () => {
    const { quizId, questions } = addQuiz(lessonIds[0], 0.6, 5);

    const submitted = submitQuizAttempt(
      db,
      base.user.id,
      lessonIds[0],
      quizId,
      answer(questions, 3),
      NOW
    );

    expect(submitted).toMatchObject({
      ok: true,
      result: { score: 0.6, passed: true, totalCorrect: 3, totalQuestions: 5 },
    });
  });

  it("fails a Student who falls short of the pass mark", () => {
    const { quizId, questions } = addQuiz(lessonIds[0], 0.8, 5);

    const submitted = submitQuizAttempt(
      db,
      base.user.id,
      lessonIds[0],
      quizId,
      answer(questions, 3),
      NOW
    );

    expect(submitted).toMatchObject({
      ok: true,
      result: { score: 0.6, passed: false, grade: "D" },
    });
  });
});

describe("scoping a Quiz Attempt to its Lesson", () => {
  it("does not find a Quiz that belongs to another Lesson", () => {
    const { quizId, questions } = addQuiz(lessonIds[1], 0.7, 2);

    const submitted = submitQuizAttempt(
      db,
      base.user.id,
      lessonIds[0],
      quizId,
      answer(questions, 0),
      NOW
    );

    expect(submitted).toEqual({
      ok: false,
      status: 404,
      error: "Quiz not found.",
    });
  });

  it("treats an option that isn't one of the question's own as no answer", () => {
    const { quizId, questions } = addQuiz(lessonIds[0], 0.5, 2);
    const [first, second] = questions;

    const submitted = submitQuizAttempt(
      db,
      base.user.id,
      lessonIds[0],
      quizId,
      { [first.id]: second.rightOptionId, [second.id]: 99_999 },
      NOW
    );

    expect(submitted).toMatchObject({
      ok: true,
      result: {
        totalCorrect: 0,
        questionResults: [
          { questionId: first.id, correct: false, selectedOptionId: null },
          { questionId: second.id, correct: false, selectedOptionId: null },
        ],
      },
    });
  });
});

describe("revealing answers", () => {
  it("shows the right option only for questions the Student answered", () => {
    const { quizId, questions } = addQuiz(lessonIds[0], 0.5, 2);
    const [answered, skipped] = questions;

    const submitted = submitQuizAttempt(
      db,
      base.user.id,
      lessonIds[0],
      quizId,
      { [answered.id]: answered.wrongOptionId },
      NOW
    );

    expect(submitted).toMatchObject({
      ok: true,
      result: {
        questionResults: [
          {
            questionId: answered.id,
            selectedOptionId: answered.wrongOptionId,
            correctOptionId: answered.rightOptionId,
          },
          {
            questionId: skipped.id,
            selectedOptionId: null,
            correctOptionId: null,
          },
        ],
      },
    });
  });
});

describe("a Student's best Quiz Attempt", () => {
  it("is their highest-scoring attempt", () => {
    const { quizId, questions } = addQuiz(lessonIds[0], 0.75, 4);

    for (const rightCount of [1, 4, 2]) {
      submitQuizAttempt(
        db,
        base.user.id,
        lessonIds[0],
        quizId,
        answer(questions, rightCount),
        NOW
      );
    }

    expect(bestQuizAttempt(db, base.user.id, quizId)).toEqual({
      score: 1,
      passed: true,
    });
  });

  it("ignores another Student's attempts", () => {
    const { quizId, questions } = addQuiz(lessonIds[0], 0.75, 4);
    submitQuizAttempt(
      db,
      base.user.id,
      lessonIds[0],
      quizId,
      answer(questions, 4),
      NOW
    );

    expect(bestQuizAttempt(db, base.instructor.id, quizId)).toBeNull();
  });
});
