// PROTOTYPE, throwaway (respergu/cohort-005-project#24).
//
// Variant C: "Activity drawer"
// - Placement: bell in the sidebar's user block (next to Settings), opening a
//   full-height drawer from the right over the page
// - Badge: a dot only, no number, while anything is UNSEEN. Opening the drawer
//   marks everything seen
// - Arrival: a toast when a new Notification lands while Cadence is open
// - Rows: rich cards grouped by course, with the quoted excerpt (refund
//   reason, Question, Reply) and a primary action button per kind
// - Click: the action marks read and navigates; X archives (dismiss)
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Dialog } from "radix-ui";
import { Bell, BellDot, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "~/lib/utils";
import { UserAvatar } from "~/components/user-avatar";
import {
  FeedProblem,
  KindIcon,
  RowText,
  timeAgo,
  useNotificationFeed,
  type FeedRow,
} from "./feed";

export const name = "Activity drawer";

const toneButton: Record<string, string> = {
  warning: "bg-amber-600 text-white hover:bg-amber-700",
  negative: "bg-foreground text-background hover:opacity-90",
  positive: "bg-emerald-600 text-white hover:bg-emerald-700",
};

export function VariantCUserBell() {
  const feed = useNotificationFeed();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(
    () =>
      feed.onNewRows((rows) => {
        for (const row of rows.slice(0, 3)) {
          toast(<RowText html={row.html} />, {
            description: row.course?.title,
            action: {
              label: row.cta,
              onClick: () => {
                feed.markRead([row.id]);
                navigate(row.url);
              },
            },
          });
        }
      }),
    [feed.onNewRows, navigate]
  );

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) feed.markAllSeen();
  }

  function act(row: FeedRow) {
    feed.markRead([row.id]);
    setOpen(false);
    navigate(row.url);
  }

  const groups = groupByCourse(feed.rows);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <button
          title="Notifications"
          aria-label={`Notifications${feed.unseenCount ? ", new activity" : ""}`}
          className="relative rounded-md p-1 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {feed.unseenCount > 0 ? (
            <>
              <BellDot className="size-4 text-sidebar-foreground" />
              <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-red-600 ring-2 ring-sidebar" />
            </>
          ) : (
            <Bell className="size-4" />
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/20 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[440px] flex-col border-l bg-background shadow-2xl data-[state=open]:animate-in data-[state=open]:slide-in-from-right">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold">
                Activity
              </Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">
                {feed.unreadCount
                  ? `${feed.unreadCount} need a look`
                  : "Nothing waiting on you"}
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 space-y-6 overflow-y-auto bg-muted/30 p-5">
            <FeedProblem />
            {feed.ready && !feed.error && feed.rows.length === 0 && (
              <div className="py-16 text-center text-sm text-muted-foreground">
                No activity yet.
              </div>
            )}
            {groups.map((group) => (
              <section key={group.key}>
                <div className="mb-2 flex items-center gap-2">
                  {group.course?.coverImageUrl ? (
                    <img
                      src={group.course.coverImageUrl}
                      alt=""
                      className="size-6 rounded object-cover"
                    />
                  ) : null}
                  <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.course?.title ?? "Other"}
                  </h3>
                </div>
                <div className="space-y-2">
                  {group.rows.map((row) => (
                    <article
                      key={row.id}
                      className={cn(
                        "relative rounded-lg border bg-background p-4 shadow-sm",
                        !row.read && "border-l-4 border-l-blue-600"
                      )}
                    >
                      <button
                        title="Dismiss"
                        aria-label="Dismiss"
                        onClick={() => feed.archive([row.id])}
                        className="absolute right-2 top-2 rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                      <div className="flex gap-3 pr-5">
                        {row.actorName ? (
                          <UserAvatar name={row.actorName} avatarUrl={null} />
                        ) : (
                          <KindIcon kind={row.kind} />
                        )}
                        <div className="min-w-0 flex-1">
                          <RowText html={row.html} />
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {timeAgo(row.insertedAt)}
                          </div>
                        </div>
                      </div>
                      {row.excerpt && (
                        <blockquote className="mt-3 border-l-2 pl-3 text-sm italic text-muted-foreground">
                          {row.excerpt}
                        </blockquote>
                      )}
                      <div className="mt-3 flex justify-end">
                        <button
                          onClick={() => act(row)}
                          className={cn(
                            "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                            row.read
                              ? "border text-muted-foreground hover:bg-accent hover:text-foreground"
                              : (toneButton[row.tone ?? ""] ??
                                  "bg-primary text-primary-foreground hover:opacity-90")
                          )}
                        >
                          {row.cta}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function groupByCourse(rows: FeedRow[]) {
  const groups = new Map<
    string,
    { key: string; course?: FeedRow["course"]; rows: FeedRow[] }
  >();
  for (const row of rows) {
    const key = row.course?.slug ?? "other";
    if (!groups.has(key))
      groups.set(key, { key, course: row.course, rows: [] });
    groups.get(key)!.rows.push(row);
  }
  return [...groups.values()];
}
