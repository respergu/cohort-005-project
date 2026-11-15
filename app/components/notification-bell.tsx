import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { Popover } from "radix-ui";
import { Bell, CheckCheck } from "lucide-react";
import { cn, formatRelativeTime } from "~/lib/utils";
import { connectKnock, type KnockClientConfig } from "~/lib/knock-browser";
import {
  createNotificationFeed,
  unreadBadgeLabel,
  type FeedSnapshot,
  type NotificationFeed,
  type NotificationRow,
} from "~/lib/notification-feed";
import { notificationIconFor } from "~/components/notification-icons";

// ─── The Notification Feed bell ───
// Sits beside the Cadence wordmark. The red badge counts unread
// Notifications; the popover lists them. Opening it reads the feed again and
// marks everything seen, which leaves the count alone. Clicking a row marks
// it read, closes the popover and opens the row's page. No live updates in
// v1: the feed is read on page load and when the popover opens.

const NOT_LOADED: FeedSnapshot = {
  status: "loading",
  unreadCount: 0,
  rows: [],
};
const notSubscribed = () => () => {};

export function NotificationBell({ config }: { config: KnockClientConfig }) {
  const feed = useNotificationFeed(config);
  const snapshot = useSyncExternalStore(
    feed ? feed.subscribe : notSubscribed,
    () => feed?.getSnapshot() ?? NOT_LOADED,
    () => NOT_LOADED
  );
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const badge = unreadBadgeLabel(snapshot.unreadCount);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) void feed?.open();
  }

  function openRow(row: NotificationRow) {
    void feed?.markRead(row.id);
    setOpen(false);
    if (row.path) navigate(row.path);
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={
            badge
              ? `Notifications, ${snapshot.unreadCount} unread`
              : "Notifications"
          }
          className={cn(
            "relative rounded-md p-1.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            open && "bg-sidebar-accent text-sidebar-accent-foreground"
          )}
        >
          <Bell className="size-4" />
          {badge && (
            <span
              aria-hidden
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] leading-none font-semibold text-white"
            >
              {badge}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={14}
          collisionPadding={12}
          className="z-50 flex max-h-[min(560px,calc(100vh-24px))] w-[380px] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {snapshot.unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void feed?.markAllRead()}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <CheckCheck className="size-3.5" />
                Mark all as read
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            <FeedMessage snapshot={snapshot} />
            {snapshot.rows.length > 0 && (
              <ul className="divide-y">
                {snapshot.rows.map((row) => (
                  <li key={row.id}>
                    <NotificationRowButton row={row} onOpen={openRow} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * One Knock connection and feed for as long as the bell is mounted. The
 * layout's config gets a new token each time its loader runs, but the
 * connection keeps and refreshes its own. Only a new user starts again, and
 * the bell is keyed on the Knock id for that.
 */
function useNotificationFeed(config: KnockClientConfig) {
  const [firstConfig] = useState(config);
  const [feed, setFeed] = useState<NotificationFeed | null>(null);

  useEffect(() => {
    const connection = connectKnock(firstConfig);
    const notifications = createNotificationFeed(
      connection,
      firstConfig.feedChannelId
    );
    setFeed(notifications);
    void notifications.load();
    return () => {
      notifications.dispose();
      connection.disconnect();
    };
  }, [firstConfig]);

  return feed;
}

function FeedMessage({ snapshot }: { snapshot: FeedSnapshot }) {
  const message =
    snapshot.status === "error"
      ? "Your Notifications couldn't be loaded. Try again in a moment."
      : snapshot.rows.length > 0
        ? null
        : snapshot.status === "loading"
          ? "Loading…"
          : "You're all caught up.";
  if (!message) return null;
  return (
    <p className="px-6 py-12 text-center text-sm text-muted-foreground">
      {message}
    </p>
  );
}

function NotificationRowButton({
  row,
  onOpen,
}: {
  row: NotificationRow;
  onOpen: (row: NotificationRow) => void;
}) {
  const { Icon, tone } = notificationIconFor(row.workflow, row.data);
  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      className={cn(
        "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent",
        row.unread && "bg-blue-50/60 dark:bg-blue-950/20"
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          tone
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="line-clamp-2 text-sm [&_p]:m-0 [&_strong]:font-semibold"
          // Cut down to p, strong and em with no attributes by sanitizeFeedHtml.
          dangerouslySetInnerHTML={{ __html: row.html }}
        />
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {row.courseTitle ? `${row.courseTitle} · ` : ""}
          {formatRelativeTime(row.insertedAt)}
        </div>
      </div>
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          row.unread ? "bg-blue-600" : "bg-transparent"
        )}
      />
      {row.unread && <span className="sr-only">Unread</span>}
    </button>
  );
}
