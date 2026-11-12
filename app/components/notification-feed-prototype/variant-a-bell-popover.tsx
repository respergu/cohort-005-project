// PROTOTYPE, throwaway (respergu/cohort-005-project#24).
//
// Variant A: "Bell popover". THE WINNER: picked on #24, with the badge
// switched from unseen to unread.
// - Placement: bell beside the Cadence wordmark in the sidebar header
// - Badge: red number = UNREAD count. Opening the popover marks everything
//   seen in Knock but leaves the count alone; only reading a Notification
//   (click, or "Mark all as read") brings it down
// - Rows: compact, icon by kind, two-line text, course + time; unread rows
//   are tinted with a blue dot until clicked
// - Click: marks read, closes, navigates. No full page, no archive
import { useState } from "react";
import { useNavigate } from "react-router";
import { Popover } from "radix-ui";
import { Bell, CheckCheck } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  CountBadge,
  FeedProblem,
  KindIcon,
  RowText,
  timeAgo,
  useNotificationFeed,
  type FeedRow,
} from "./feed";

export const name = "Bell popover";

export function VariantAHeaderBell() {
  const feed = useNotificationFeed();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) feed.markAllSeen();
  }

  function openRow(row: FeedRow) {
    if (!row.read) feed.markRead([row.id]);
    setOpen(false);
    navigate(row.url);
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          aria-label={`Notifications${feed.unreadCount ? `, ${feed.unreadCount} unread` : ""}`}
          className={cn(
            "relative rounded-md p-1.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            open && "bg-sidebar-accent text-sidebar-accent-foreground"
          )}
        >
          <Bell className="size-4" />
          <CountBadge
            count={feed.unreadCount}
            className="absolute -right-1 -top-1"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={14}
          className="z-50 flex max-h-[min(560px,calc(100vh-24px))] w-[380px] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="text-sm font-semibold">Notifications</div>
            {feed.unreadCount > 0 && (
              <button
                onClick={() => feed.markAllRead()}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <CheckCheck className="size-3.5" />
                Mark all as read
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            <FeedProblem />
            {feed.ready && !feed.error && feed.rows.length === 0 && (
              <div className="px-6 py-12 text-center text-sm text-muted-foreground">
                You're all caught up.
              </div>
            )}
            <ul className="divide-y">
              {feed.rows.map((row) => (
                <li key={row.id}>
                  <button
                    onClick={() => openRow(row)}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent",
                      !row.read && "bg-blue-50/60 dark:bg-blue-950/20"
                    )}
                  >
                    <KindIcon kind={row.kind} />
                    <div className="min-w-0 flex-1">
                      <RowText html={row.html} className="line-clamp-2" />
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {row.course ? `${row.course.title} · ` : ""}
                        {timeAgo(row.insertedAt)}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "mt-1.5 size-2 shrink-0 rounded-full",
                        row.read ? "bg-transparent" : "bg-blue-600"
                      )}
                    />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
