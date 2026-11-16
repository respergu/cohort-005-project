import { Link } from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/saved";
import { db } from "~/db";
import { requireUserId } from "~/lib/access.server";
import { listBookmarks, listNotes } from "~/lib/bookmarks-and-notes.server";
import { Card, CardContent } from "~/components/ui/card";
import { Bookmark, NotebookPen } from "lucide-react";
import { formatRelativeTime } from "~/lib/utils";

export function meta() {
  return [
    { title: "Saved — Cadence" },
    { name: "description", content: "Your bookmarks and notes" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const studentId = await requireUserId(request);

  return {
    bookmarks: listBookmarks(db, studentId),
    notes: listNotes(db, studentId),
  };
}

export default function Saved({ loaderData }: Route.ComponentProps) {
  const { bookmarks, notes } = loaderData;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Saved</h1>
        <p className="text-sm text-muted-foreground">
          The lessons you flagged, and what you wrote about them.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <Bookmark className="size-4 text-muted-foreground" />
            Bookmarks
          </h2>

          {bookmarks.length === 0 ? (
            <EmptyList>No bookmarks yet.</EmptyList>
          ) : (
            <div className="space-y-2">
              {bookmarks.map((bookmark) => (
                <Card key={bookmark.id}>
                  <CardContent className="py-3">
                    <Link
                      to={`/courses/${bookmark.courseSlug}/lessons/${bookmark.lessonId}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {bookmark.lessonTitle}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {bookmark.courseTitle} · {bookmark.moduleTitle}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <NotebookPen className="size-4 text-muted-foreground" />
            Notes
          </h2>

          {notes.length === 0 ? (
            <EmptyList>No notes yet.</EmptyList>
          ) : (
            <div className="space-y-2">
              {notes.map((note) => (
                <Card key={note.id}>
                  <CardContent className="space-y-1 py-3">
                    <Link
                      to={`/courses/${note.courseSlug}/lessons/${note.lessonId}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {note.lessonTitle}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {note.courseTitle}
                    </p>
                    <p className="whitespace-pre-wrap text-sm">{note.body}</p>
                    <p
                      suppressHydrationWarning
                      className="text-xs text-muted-foreground"
                    >
                      Edited {formatRelativeTime(note.updatedAt)}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function EmptyList({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  );
}
