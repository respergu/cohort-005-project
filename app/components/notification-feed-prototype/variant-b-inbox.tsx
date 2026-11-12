// PROTOTYPE, throwaway (respergu/cohort-005-project#24).
//
// Variant B: "Inbox page"
// - Placement: a "Notifications" item at the top of the sidebar nav, leading
//   to a full /notifications page
// - Badge: grey pill = UNREAD count. It only goes down when things are read
//   (inbox-zero), so visiting the page doesn't clear it
// - Rows: dense, one line, actor avatar, bold while unread, course chip;
//   hover actions to toggle read and archive
// - Filters: All / Unread / Archived. Archive is "done", like email
// - Click: marks read, navigates
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import {
  Archive,
  ArchiveRestore,
  CheckCheck,
  Inbox,
  Mail,
  MailOpen,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { UserAvatar } from "~/components/user-avatar";
import {
  FeedProblem,
  KindIcon,
  RowText,
  kindStyle,
  timeAgo,
  useNotificationFeed,
  type FeedRow,
} from "./feed";

export const name = "Inbox page";

export function VariantBNavItem() {
  const feed = useNotificationFeed();
  return (
    <NavLink
      to="/notifications"
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )
      }
    >
      <Inbox className="size-4" />
      <span className="flex-1">Notifications</span>
      {feed.unreadCount > 0 && (
        <span className="rounded-full bg-sidebar-foreground/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-sidebar-foreground">
          {feed.unreadCount}
        </span>
      )}
    </NavLink>
  );
}

type Filter = "all" | "unread" | "archived";

export function VariantBInboxPage() {
  const feed = useNotificationFeed();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [archived, setArchived] = useState<FeedRow[] | null>(null);

  // Being on the page counts as having seen everything (badge is unread, so
  // it stays)
  useEffect(() => {
    if (feed.ready && feed.unseenCount > 0) feed.markAllSeen();
  }, [feed.ready, feed.unseenCount]);

  useEffect(() => {
    if (filter !== "archived") return;
    setArchived(null);
    feed.listArchived().then(setArchived);
  }, [filter]);

  const rows =
    filter === "archived"
      ? (archived ?? [])
      : filter === "unread"
        ? feed.rows.filter((r) => !r.read)
        : feed.rows;

  function openRow(row: FeedRow) {
    if (!row.read) feed.markRead([row.id]);
    navigate(row.url);
  }

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {feed.unreadCount
              ? `${feed.unreadCount} unread`
              : "Everything's read."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border p-0.5 text-sm">
            {(["all", "unread", "archived"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded px-3 py-1 capitalize transition-colors",
                  filter === f
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <button
            disabled={!feed.unreadCount}
            onClick={() => feed.markAllRead()}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-40"
          >
            <CheckCheck className="size-4" />
            Mark all as read
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <FeedProblem />
        {filter === "archived" && archived === null && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        )}
        {feed.ready &&
          rows.length === 0 &&
          (filter !== "archived" || archived) && (
            <div className="px-6 py-16 text-center text-sm text-muted-foreground">
              {filter === "unread"
                ? "No unread Notifications."
                : filter === "archived"
                  ? "Nothing archived."
                  : "No Notifications yet."}
            </div>
          )}
        <ul className="divide-y">
          {rows.map((row) => (
            <li
              key={row.id}
              className={cn(
                "group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/60",
                !row.read && "bg-background",
                row.read && "bg-muted/30"
              )}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  row.read ? "bg-transparent" : "bg-blue-600"
                )}
              />
              {row.actorName ? (
                <UserAvatar
                  name={row.actorName}
                  avatarUrl={null}
                  className="size-7"
                />
              ) : (
                <KindIcon kind={row.kind} className="size-7" />
              )}
              <button
                onClick={() => openRow(row)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <RowText
                  html={row.html}
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    row.read
                      ? "text-muted-foreground [&_strong]:font-medium"
                      : ""
                  )}
                />
                {row.course && (
                  <span className="hidden max-w-48 shrink-0 truncate rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground md:inline">
                    {kindStyle[row.kind]?.label ?? ""} · {row.course.title}
                  </span>
                )}
              </button>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground group-hover:hidden">
                {timeAgo(row.insertedAt)}
              </span>
              <span className="hidden w-16 shrink-0 justify-end gap-1 group-hover:flex">
                {filter === "archived" ? (
                  <IconButton
                    title="Move back to inbox"
                    onClick={() => {
                      feed.unarchive([row.id]);
                      setArchived(
                        (a) => a?.filter((r) => r.id !== row.id) ?? null
                      );
                    }}
                  >
                    <ArchiveRestore className="size-4" />
                  </IconButton>
                ) : (
                  <>
                    <IconButton
                      title={row.read ? "Mark as unread" : "Mark as read"}
                      onClick={() =>
                        row.read
                          ? feed.markUnread([row.id])
                          : feed.markRead([row.id])
                      }
                    >
                      {row.read ? (
                        <Mail className="size-4" />
                      ) : (
                        <MailOpen className="size-4" />
                      )}
                    </IconButton>
                    <IconButton
                      title="Archive"
                      onClick={() => feed.archive([row.id])}
                    >
                      <Archive className="size-4" />
                    </IconButton>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
    >
      {children}
    </button>
  );
}
