// PROTOTYPE, throwaway (respergu/cohort-005-project#24). Never merge to main.
//
// One headless Notification Feed for the whole layout, read straight from
// Knock in the browser with the public key + the user token the server signed.
// Polls instead of opening Knock's websocket: live delivery is a separate
// question from how the Feed looks.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CirclePlay,
  MessageCircleQuestionMark,
  MessageSquareReply,
  Receipt,
  ReceiptText,
  Ticket,
  TicketCheck,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";

export type FeedClientConfig = {
  apiBase: string;
  publicKey: string;
  channelId: string;
  knockUserId: string;
  userToken: string;
};

type KnockBlock = {
  name: string;
  type: string;
  content: string;
  rendered: string;
};

export type KnockFeedItem = {
  id: string;
  inserted_at: string;
  seen_at: string | null;
  read_at: string | null;
  archived_at: string | null;
  actors: { id: string; name?: string | null; avatar?: string | null }[];
  blocks: KnockBlock[];
  data: {
    kind?: string;
    body?: string;
    url?: string;
    excerpt?: string;
    cta?: string;
    tone?: "positive" | "negative" | "warning";
    course?: { title: string; slug: string; coverImageUrl: string | null };
  } | null;
};

type FeedMeta = {
  unread_count: number;
  unseen_count: number;
  total_count: number;
};

// What a variant renders from. Text comes from the Knock template (block
// "body"); kind/course/excerpt come from the trigger data.
export type FeedRow = {
  id: string;
  kind: string;
  html: string;
  url: string;
  excerpt?: string;
  cta: string;
  tone?: "positive" | "negative" | "warning";
  course?: { title: string; slug: string; coverImageUrl: string | null };
  actorName?: string;
  insertedAt: string;
  seen: boolean;
  read: boolean;
  archived: boolean;
};

export function toRow(item: KnockFeedItem): FeedRow {
  const block = (name: string) => item.blocks.find((b) => b.name === name);
  return {
    id: item.id,
    kind: item.data?.kind ?? "unknown",
    html: block("body")?.rendered ?? item.data?.body ?? "",
    url: block("action_url")?.rendered || item.data?.url || "#",
    excerpt: item.data?.excerpt,
    cta: item.data?.cta ?? "Open",
    tone: item.data?.tone,
    course: item.data?.course,
    actorName: item.actors[0]?.name ?? undefined,
    insertedAt: item.inserted_at,
    seen: !!item.seen_at,
    read: !!item.read_at,
    archived: !!item.archived_at,
  };
}

type Status = "seen" | "read" | "unread" | "archived" | "unarchived";

function useKnockApi(config: FeedClientConfig | null) {
  return useMemo(() => {
    if (!config) return null;
    const headers = {
      Authorization: `Bearer ${config.publicKey}`,
      "X-Knock-User-Token": config.userToken,
      "Content-Type": "application/json",
    };
    const base = config.apiBase;
    return {
      async list(archived: "exclude" | "only" = "exclude") {
        const res = await fetch(
          `${base}/users/${encodeURIComponent(config.knockUserId)}/feeds/${config.channelId}?page_size=50&archived=${archived}`,
          { headers }
        );
        if (!res.ok)
          throw new Error(`Knock feed ${res.status}: ${await res.text()}`);
        return (await res.json()) as {
          entries: KnockFeedItem[];
          meta: FeedMeta;
        };
      },
      async batch(ids: string[], status: Status) {
        const res = await fetch(`${base}/messages/batch/${status}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ message_ids: ids }),
        });
        if (!res.ok)
          throw new Error(
            `Knock batch ${status} ${res.status}: ${await res.text()}`
          );
      },
      async bulk(status: "seen" | "read" | "archived") {
        const res = await fetch(
          `${base}/channels/${config.channelId}/messages/bulk/${status}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              user_ids: [config.knockUserId],
              engagement_status:
                status === "seen"
                  ? "unseen"
                  : status === "read"
                    ? "unread"
                    : undefined,
              archived: "exclude",
            }),
          }
        );
        if (!res.ok)
          throw new Error(
            `Knock bulk ${status} ${res.status}: ${await res.text()}`
          );
      },
    };
  }, [config?.knockUserId, config?.userToken]);
}

type FeedState = {
  ready: boolean;
  error: string | null;
  rows: FeedRow[];
  unreadCount: number;
  unseenCount: number;
  refresh: () => Promise<void>;
  refreshSoon: () => void;
  markSeen: (ids: string[]) => void;
  markRead: (ids: string[]) => void;
  markUnread: (ids: string[]) => void;
  archive: (ids: string[]) => void;
  unarchive: (ids: string[]) => void;
  markAllSeen: () => void;
  markAllRead: () => void;
  listArchived: () => Promise<FeedRow[]>;
  onNewRows: (fn: (rows: FeedRow[]) => void) => () => void;
};

const FeedContext = createContext<FeedState | null>(null);

export function useNotificationFeed() {
  const ctx = useContext(FeedContext);
  if (!ctx)
    throw new Error("useNotificationFeed outside NotificationFeedProvider");
  return ctx;
}

const POLL_MS = 15_000;

export function NotificationFeedProvider({
  config,
  children,
}: {
  config: FeedClientConfig | null;
  children: React.ReactNode;
}) {
  const api = useKnockApi(config);
  const [items, setItems] = useState<KnockFeedItem[]>([]);
  const [meta, setMeta] = useState<FeedMeta>({
    unread_count: 0,
    unseen_count: 0,
    total_count: 0,
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const knownIds = useRef<Set<string> | null>(null);
  const listeners = useRef(new Set<(rows: FeedRow[]) => void>());

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const body = await api.list();
      const fresh = knownIds.current
        ? body.entries.filter((e) => !knownIds.current!.has(e.id) && !e.seen_at)
        : [];
      knownIds.current = new Set(body.entries.map((e) => e.id));
      setItems(body.entries);
      setMeta(body.meta);
      setError(null);
      setReady(true);
      if (fresh.length) listeners.current.forEach((fn) => fn(fresh.map(toRow)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReady(true);
    }
  }, [api]);

  // New user (DevUI switch): start over
  useEffect(() => {
    knownIds.current = null;
    setItems([]);
    setReady(false);
    void refresh();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(tick, POLL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", tick);
    };
  }, [refresh]);

  // Knock processes triggers and bulk updates asynchronously
  const refreshSoon = useCallback(() => {
    [1500, 4000, 8000].forEach((ms) =>
      window.setTimeout(() => void refresh(), ms)
    );
  }, [refresh]);

  const patch = useCallback(
    (ids: string[] | "all", fields: Partial<KnockFeedItem>) => {
      setItems((prev) => {
        const next = prev.map((i) =>
          ids === "all" || ids.includes(i.id) ? { ...i, ...fields } : i
        );
        setMeta((m) => ({
          ...m,
          unread_count: next.filter((i) => !i.read_at && !i.archived_at).length,
          unseen_count: next.filter((i) => !i.seen_at && !i.archived_at).length,
        }));
        return next.filter((i) => !i.archived_at);
      });
    },
    []
  );

  const run = useCallback((p: Promise<void> | undefined) => {
    p?.catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const now = () => new Date().toISOString();

  const value = useMemo<FeedState>(
    () => ({
      ready,
      error,
      rows: items.map(toRow),
      unreadCount: meta.unread_count,
      unseenCount: meta.unseen_count,
      refresh,
      refreshSoon,
      markSeen: (ids) => {
        if (!ids.length) return;
        patch(ids, { seen_at: now() });
        run(api?.batch(ids, "seen"));
      },
      markRead: (ids) => {
        if (!ids.length) return;
        patch(ids, { read_at: now(), seen_at: now() });
        run(api?.batch(ids, "read"));
      },
      markUnread: (ids) => {
        patch(ids, { read_at: null });
        run(api?.batch(ids, "unread"));
      },
      archive: (ids) => {
        patch(ids, { archived_at: now() });
        run(api?.batch(ids, "archived"));
      },
      unarchive: (ids) => {
        run(api?.batch(ids, "unarchived").then(() => refreshSoon()));
      },
      markAllSeen: () => {
        if (!meta.unseen_count) return;
        patch("all", { seen_at: now() });
        run(api?.bulk("seen"));
      },
      markAllRead: () => {
        patch("all", { read_at: now(), seen_at: now() });
        run(api?.bulk("read"));
      },
      listArchived: async () => {
        if (!api) return [];
        const body = await api.list("only");
        return body.entries.map(toRow);
      },
      onNewRows: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
    }),
    [ready, error, items, meta, refresh, refreshSoon, patch, run, api]
  );

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

// --- shared presentation bits --------------------------------------------

export const kindStyle: Record<
  string,
  { icon: LucideIcon; className: string; label: string }
> = {
  "refund-request-raised": {
    icon: Receipt,
    label: "Refund Request",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  },
  "refund-request-decided": {
    icon: Receipt,
    label: "Refund Request",
    className:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
  "refund-approved-instructor": {
    icon: ReceiptText,
    label: "Refund",
    className:
      "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  },
  "seat-claimed": {
    icon: Ticket,
    label: "Seats",
    className: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  },
  "last-seat-claimed": {
    icon: TicketCheck,
    label: "Seats",
    className:
      "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  },
  "new-enrollment": {
    icon: UserPlus,
    label: "Enrollments",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  "new-question": {
    icon: MessageCircleQuestionMark,
    label: "Question",
    className:
      "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  },
  reply: {
    icon: MessageSquareReply,
    label: "Reply",
    className:
      "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  },
  "new-lesson": {
    icon: CirclePlay,
    label: "New lessons",
    className:
      "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  },
};

export function KindIcon({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}) {
  const style = kindStyle[kind] ?? kindStyle["refund-request-decided"];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full",
        style.className,
        className
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

// Knock renders the markdown body to <p>…</p>; keep it inline
export function RowText({
  html,
  className,
}: {
  html: string;
  className?: string;
}) {
  return (
    <div
      className={cn("text-sm [&_p]:m-0 [&_strong]:font-semibold", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const rtf =
  typeof Intl !== "undefined"
    ? new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" })
    : null;

export function timeAgo(iso: string) {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  if (!rtf) return new Date(iso).toLocaleString();
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

export function CountBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-none text-white",
        className
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

export function FeedProblem() {
  const { error, ready } = useNotificationFeed();
  if (!ready)
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  if (error)
    return (
      <div className="p-4 text-xs text-red-600 break-words">
        Feed error (prototype): {error}
      </div>
    );
  return null;
}
