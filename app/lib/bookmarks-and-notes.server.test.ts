import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  MAX_NOTE_LENGTH,
  saveNote,
  toggleBookmark,
} from "./bookmarks-and-notes.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 7, 9, 30, 0);
const LATEST = new Date(2026, 9, 8, 18, 0, 0);

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

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

describe("bookmarking a Lesson", () => {
  it("bookmarks a Lesson that has no Bookmark", () => {
    expect(toggleBookmark(db, base.user.id, lessonIds[0], NOW)).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
  });

  it("removes the Bookmark when toggled again", () => {
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);

    expect(toggleBookmark(db, base.user.id, lessonIds[0], LATER)).toBe(false);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(false);
  });

  it("never leaves a Student with two Bookmarks on one Lesson", () => {
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    toggleBookmark(db, base.user.id, lessonIds[0], LATER);
    toggleBookmark(db, base.user.id, lessonIds[0], LATEST);

    expect(listBookmarks(db, base.user.id)).toHaveLength(1);
  });

  it("is held to one per Student per Lesson by the database", () => {
    const row = {
      userId: base.user.id,
      lessonId: lessonIds[0],
      createdAt: NOW.toISOString(),
    };
    db.insert(schema.bookmarks).values(row).run();

    expect(() => db.insert(schema.bookmarks).values(row).run()).toThrow(
      /UNIQUE/
    );
  });
});

describe("saving a Note", () => {
  it("creates a Note with the body trimmed", () => {
    saveNote(db, base.user.id, lessonIds[0], "  Re-watch from 4:30.  ", NOW);

    expect(getNote(db, base.user.id, lessonIds[0])).toEqual({
      body: "Re-watch from 4:30.",
      updatedAt: NOW.toISOString(),
    });
  });

  it("replaces the body and moves the last edited time on when saved again", () => {
    saveNote(db, base.user.id, lessonIds[0], "First thoughts", NOW);
    const result = saveNote(
      db,
      base.user.id,
      lessonIds[0],
      "Second thoughts",
      LATER
    );

    expect(getNote(db, base.user.id, lessonIds[0])).toEqual({
      body: "Second thoughts",
      updatedAt: LATER.toISOString(),
    });
    expect(result).toMatchObject({
      ok: true,
      note: { createdAt: NOW.toISOString() },
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it(`refuses a Note over ${MAX_NOTE_LENGTH} characters and keeps the old one`, () => {
    saveNote(db, base.user.id, lessonIds[0], "Keep me", NOW);

    expect(
      saveNote(
        db,
        base.user.id,
        lessonIds[0],
        "a".repeat(MAX_NOTE_LENGTH + 1),
        LATER
      )
    ).toEqual({
      ok: false,
      error: "Notes can be at most 2,000 characters. Yours is 2,001.",
    });
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe("Keep me");
  });

  it(`accepts a Note of exactly ${MAX_NOTE_LENGTH} characters`, () => {
    const body = "a".repeat(MAX_NOTE_LENGTH);

    expect(saveNote(db, base.user.id, lessonIds[0], body, NOW).ok).toBe(true);
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe(body);
  });

  it("removes the Note when saved empty", () => {
    saveNote(db, base.user.id, lessonIds[0], "Something", NOW);
    saveNote(db, base.user.id, lessonIds[0], "   ", LATER);

    expect(getNote(db, base.user.id, lessonIds[0])).toBeNull();
  });

  it("is held to one per Student per Lesson by the database", () => {
    const row = {
      userId: base.user.id,
      lessonId: lessonIds[0],
      body: "x",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    db.insert(schema.notes).values(row).run();

    expect(() => db.insert(schema.notes).values(row).run()).toThrow(/UNIQUE/);
  });
});

describe("the Saved lists", () => {
  const lessonAndCourse = (lessonId: number, lessonTitle: string) => ({
    lessonId,
    lessonTitle,
    courseTitle: "Test Course",
    courseSlug: "test-course",
  });

  it("list only the Student's own Bookmarks, newest first", () => {
    const other = addStudent("Other");
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    toggleBookmark(db, base.user.id, lessonIds[1], LATER);
    toggleBookmark(db, other.id, lessonIds[0], LATEST);

    expect(listBookmarks(db, base.user.id)).toMatchObject([
      lessonAndCourse(lessonIds[1], "Lesson 2"),
      lessonAndCourse(lessonIds[0], "Lesson 1"),
    ]);
  });

  it("list only the Student's own Notes, last edited first", () => {
    const other = addStudent("Other");
    saveNote(db, base.user.id, lessonIds[0], "On lesson 1", NOW);
    saveNote(db, base.user.id, lessonIds[1], "On lesson 2", LATER);
    saveNote(db, base.user.id, lessonIds[0], "On lesson 1, edited", LATEST);
    saveNote(db, other.id, lessonIds[1], "Someone else's", LATEST);

    expect(listNotes(db, base.user.id)).toMatchObject([
      {
        ...lessonAndCourse(lessonIds[0], "Lesson 1"),
        body: "On lesson 1, edited",
      },
      { ...lessonAndCourse(lessonIds[1], "Lesson 2"), body: "On lesson 2" },
    ]);
  });
});

describe("approving a Refund", () => {
  it("keeps the Student's Bookmarks and Notes", async () => {
    const notifications = fakeNotifications();
    const platformAdmin = db
      .insert(schema.users)
      .values({
        name: "Pat Admin",
        email: "pat@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: new Date(2026, 9, 5).toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    saveNote(db, base.user.id, lessonIds[0], "Mine to keep", NOW);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "It was not what I expected.",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(approved.ok).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe("Mine to keep");
  });
});
