import type { FeedItem, FeedStoreState } from "@knocklabs/client";
import { z } from "zod";
import { knockRefusal, type KnockConnection } from "~/lib/knock-browser";

// ─── The Notification Feed ───
// What the bell shows, worked out from Knock's feed items. Runs in the
// browser, so nothing here may import server code.

/** The red badge on the bell: hidden at zero, "9+" above nine. */
export function unreadBadgeLabel(unreadCount: number): string | null {
  if (unreadCount <= 0) return null;
  return unreadCount > 9 ? "9+" : String(unreadCount);
}

const KEPT_TAGS = new Set(["p", "strong", "em"]);

// Elements whose contents are never prose, so they go with their tags.
const DROPPED_WITH_CONTENTS = new Set([
  "script",
  "style",
  "template",
  "textarea",
  "title",
  "iframe",
  "noscript",
  "svg",
  "math",
]);

// A comment, a doctype or processing instruction, or a start or end tag.
// Quoted attribute values may hold ">".
const MARKUP =
  /<!--[\s\S]*?-->|<[!?][^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/**
 * Cuts Knock's rendered feed HTML down to `p`, `strong` and `em` with no
 * attributes. Everything else is text, with any `<`, `>` or stray `&`
 * escaped, so the result can't hold any other markup. That strips links and
 * images typed into user text, such as a refund reason, which Knock's
 * Markdown renderer would otherwise turn into real ones.
 */
export function sanitizeFeedHtml(html: string): string {
  const markup = new RegExp(MARKUP.source, "g");
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = markup.exec(html))) {
    out += escapeText(html.slice(cursor, match.index));
    cursor = markup.lastIndex;
    const [, slash, rawName] = match;
    if (rawName === undefined) continue; // a comment or doctype
    const name = rawName.toLowerCase();
    if (KEPT_TAGS.has(name)) {
      out += `<${slash}${name}>`;
    } else if (!slash && DROPPED_WITH_CONTENTS.has(name)) {
      const end = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(cursor));
      cursor = end ? cursor + end.index + end[0].length : html.length;
      markup.lastIndex = cursor;
    }
  }
  return out + escapeText(html.slice(cursor));
}

// Keeps entity references (`&amp;`, `&#39;`), which the browser decodes to
// plain text, and escapes everything that could start markup.
function escapeText(text: string): string {
  return text
    .replace(/&(?!#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]*;)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type FeedStatus = "loading" | "ready" | "error";

/** One row in the bell's popover. */
export type NotificationRow = {
  id: string;
  /** The Knock workflow key (`source.key`), which picks the icon. */
  workflow: string;
  /** The template's sentence, sanitized. */
  html: string;
  /** `data.course_title`, for the "{course} · {time ago}" line. */
  courseTitle: string | null;
  /** `data.path`, the in-app page a click opens. Null if it isn't one. */
  path: string | null;
  insertedAt: string;
  unread: boolean;
  /** The trigger data, for icons that depend on it. */
  data: Readonly<Record<string, unknown>>;
};

export type FeedSnapshot = {
  status: FeedStatus;
  unreadCount: number;
  rows: NotificationRow[];
};

export type NotificationFeed = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): FeedSnapshot;
  /** Reads the feed from Knock. */
  load(): Promise<void>;
  /**
   * When the popover opens: reads the feed again, then marks it all seen.
   * Seen doesn't lower the badge. Only reading does.
   */
  open(): Promise<void>;
  /** A row was clicked: marks that Notification read, which lowers the badge. */
  markRead(id: string): Promise<void>;
  /** "Mark all as read": clears the badge. */
  markAllRead(): Promise<void>;
  dispose(): void;
};

export function createNotificationFeed(
  connection: KnockConnection,
  feedChannelId: string
): NotificationFeed {
  const feed = connection.knock.feeds.initialize(feedChannelId, {
    page_size: 50,
    archived: "exclude",
  });
  const listeners = new Set<() => void>();
  let status: FeedStatus = "loading";
  const notify = () => listeners.forEach((listener) => listener());
  const unsubscribeStore = feed.store.subscribe(notify);

  let cached: {
    state: FeedStoreState;
    status: FeedStatus;
    snapshot: FeedSnapshot;
  } | null = null;

  async function load() {
    const result = await connection.withFreshToken(
      () => feed.fetch(),
      (res) => (res?.status === "error" ? knockRefusal(res.data) : undefined)
    );
    if (result) {
      status = result.status === "ok" ? "ready" : "error";
      notify();
    }
  }

  // The SDK shows a mark at once, before Knock answers. If Knock refuses it,
  // even after a fresh token, read the feed again to show what Knock holds.
  async function mark(send: () => Promise<unknown>) {
    let refused: boolean;
    try {
      const result = await connection.withFreshToken(send, knockRefusal);
      refused = knockRefusal(result) !== undefined;
    } catch {
      refused = true; // the SDK throws on a 5xx
    }
    if (refused) await load();
  }

  // Always the store's copy, so a retried mark sees it's already counted.
  const findItem = (id: string) =>
    feed.getState().items.find((i) => i.id === id);

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      const state = feed.getState();
      if (cached && cached.state === state && cached.status === status) {
        return cached.snapshot;
      }
      const snapshot = {
        status,
        unreadCount: state.metadata.unread_count,
        rows: state.items.map(toNotificationRow),
      };
      cached = { state, status, snapshot };
      return snapshot;
    },
    load,
    async open() {
      await load();
      if (status === "ready" && feed.getState().metadata.unseen_count > 0) {
        await mark(() => feed.markAllAsSeen());
      }
    },
    async markRead(id) {
      if (findItem(id)?.read_at !== null) return;
      await mark(async () => {
        const item = findItem(id);
        return item && feed.markAsRead(item);
      });
    },
    async markAllRead() {
      await mark(() => feed.markAllAsRead());
    },
    dispose() {
      unsubscribeStore();
      listeners.clear();
      feed.dispose();
    },
  };
}

// Knock hands back the trigger data as it was sent. Read it as untyped.
const itemData = z.record(z.string(), z.unknown());

function toNotificationRow(item: FeedItem): NotificationRow {
  const body = item.blocks.find((block) => block.name === "body");
  const parsed = itemData.safeParse(item.data);
  const data = parsed.success ? parsed.data : {};
  return {
    id: item.id,
    workflow: item.source.key,
    html: body && "rendered" in body ? sanitizeFeedHtml(body.rendered) : "",
    courseTitle:
      typeof data.course_title === "string" && data.course_title
        ? data.course_title
        : null,
    path: inAppPath(data.path),
    insertedAt: item.inserted_at,
    unread: item.read_at === null,
    data,
  };
}

// A path on this site, such as "/admin/refunds". Never "//host" or "/\host",
// which browsers read as another site.
function inAppPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\/(?![/\\])/.test(value) ? value : null;
}
