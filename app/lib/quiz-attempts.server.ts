import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, inArray } from "drizzle-orm";
import * as schema from "~/db/schema";
import {
  quizAnswers,
  quizAttempts,
  quizOptions,
  quizQuestions,
  quizzes,
} from "~/db/schema";

// ─── Quiz Attempts ───
// A Student submits answers to a Lesson's Quiz; this grades them against the
// Quiz's own pass mark. The Quiz must belong to the Lesson asked about, and an
// answer only counts if it is one of its question's own options. Content
// access is the caller's job — the lesson route checks it before calling in.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;

/** questionId → the optionId the Student chose. */
export type QuizAnswers = Record<number, number>;

export type QuestionResult = {
  questionId: number;
  correct: boolean;
  selectedOptionId: number | null;
  correctOptionId: number | null;
};

export type QuizResult = {
  score: number;
  passed: boolean;
  grade: string;
  totalCorrect: number;
  totalQuestions: number;
  questionResults: QuestionResult[];
};

export type SubmitQuizAttemptResult =
  | { ok: true; result: QuizResult }
  | { ok: false; status: 404; error: string };

function gradeFor(score: number): string {
  if (score >= 0.9) return "A";
  if (score >= 0.8) return "B";
  if (score >= 0.7) return "C";
  if (score >= 0.6) return "D";
  return "F";
}

export function submitQuizAttempt(
  db: Db,
  studentId: number,
  lessonId: number,
  quizId: number,
  answers: QuizAnswers,
  now: Date
): SubmitQuizAttemptResult {
  // Scoped to the Lesson, so a Quiz elsewhere can't be graded (and its answers
  // revealed) by posting its id to this Lesson.
  const quiz = db
    .select()
    .from(quizzes)
    .where(and(eq(quizzes.id, quizId), eq(quizzes.lessonId, lessonId)))
    .get();
  if (!quiz) return { ok: false, status: 404, error: "Quiz not found." };

  const questions = db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .orderBy(quizQuestions.position)
    .all();

  const options =
    questions.length > 0
      ? db
          .select()
          .from(quizOptions)
          .where(
            inArray(
              quizOptions.questionId,
              questions.map((q) => q.id)
            )
          )
          .all()
      : [];

  const questionResults = questions.map((question): QuestionResult => {
    const ownOptions = options.filter((o) => o.questionId === question.id);
    // Only one of this question's own options counts as an answer to it.
    const selectedOptionId =
      ownOptions.find((o) => o.id === answers[question.id])?.id ?? null;
    // The right option is revealed only once the Student has answered.
    const correctOptionId =
      selectedOptionId === null
        ? null
        : (ownOptions.find((o) => o.isCorrect)?.id ?? null);
    return {
      questionId: question.id,
      correct: selectedOptionId !== null && selectedOptionId === correctOptionId,
      selectedOptionId,
      correctOptionId,
    };
  });

  const totalCorrect = questionResults.filter((r) => r.correct).length;
  const totalQuestions = questions.length;
  const score = totalQuestions > 0 ? totalCorrect / totalQuestions : 0;
  const passed = score >= quiz.passingScore;

  db.transaction((tx) => {
    const attempt = tx
      .insert(quizAttempts)
      .values({
        userId: studentId,
        quizId,
        score,
        passed,
        attemptedAt: now.toISOString(),
      })
      .returning()
      .get();

    for (const { questionId, selectedOptionId } of questionResults) {
      if (selectedOptionId === null) continue;
      tx.insert(quizAnswers)
        .values({ attemptId: attempt.id, questionId, selectedOptionId })
        .run();
    }
  });

  return {
    ok: true,
    result: {
      score,
      passed,
      grade: gradeFor(score),
      totalCorrect,
      totalQuestions,
      questionResults,
    },
  };
}

/** The Student's highest-scoring attempt at the Quiz, if they've made one. */
export function bestQuizAttempt(
  db: Db,
  studentId: number,
  quizId: number
): { score: number; passed: boolean } | null {
  return (
    db
      .select({ score: quizAttempts.score, passed: quizAttempts.passed })
      .from(quizAttempts)
      .where(
        and(eq(quizAttempts.userId, studentId), eq(quizAttempts.quizId, quizId))
      )
      .orderBy(desc(quizAttempts.score))
      .limit(1)
      .get() ?? null
  );
}
