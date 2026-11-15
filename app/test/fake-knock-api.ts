import type { FeedItem } from "@knocklabs/client";

// ─── A fake Knock API for the browser side ───
// Stands in for `fetch`, so the real @knocklabs/client talks to it the way it
// talks to api.knock.app. It also answers the app's own POST /api/knock-token.
// It keeps the feed's state and each user's preference set, so a re-fetch
// shows what Knock would hold after a mark or a save, not what the client
// guessed. Install it with
// `vi.stubGlobal("fetch", api.fetch)` before connecting.

export type RecordedRequest = {
  method: string;
  path: string;
  /** The X-Knock-User-Token header, if any. */
  userToken: string | null;
  /** The Authorization header, if any. */
  authorization: string | null;
  body: unknown;
};

type FeedEntry = Pick<
  FeedItem,
  "id" | "inserted_at" | "read_at" | "seen_at"
> & {
  workflow: string;
  html: string;
  data: Record<string, unknown> | null;
};

/** A user token the SDK can decode. Knock would check the signature; this fake doesn't. */
export function fakeUserToken(sub: string, expiresAtSeconds: number, tag = "") {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    sub,
    iat: expiresAtSeconds - 3600,
    exp: expiresAtSeconds,
    tag,
  })}.signature`;
}

/** A user's saved categories, as Knock stores them. Null: the user exists but saved nothing. */
type SavedCategories = Record<string, unknown> | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageIds(body: unknown): Set<string> {
  if (
    typeof body !== "object" ||
    body === null ||
    !("message_ids" in body) ||
    !Array.isArray(body.message_ids)
  ) {
    return new Set();
  }
  return new Set(
    body.message_ids.filter((id): id is string => typeof id === "string")
  );
}

export function fakeKnockApi() {
  const requests: RecordedRequest[] = [];
  const rejectedTokens = new Map<string, number>();
  let markRefusal: number | null = null;
  let entries: FeedEntry[] = [];
  // Keyed by Knock id. A user missing here is one Knock has never seen.
  const preferenceSets = new Map<string, SavedCategories>();
  let preferenceFailure: { status: number; body: unknown } | null = null;
  let refreshResponse: { status: number; body: unknown } = {
    status: 401,
    body: "Select a user from the DevUI panel.",
  };

  const now = () => new Date().toISOString();

  function toFeedItem(entry: FeedEntry): FeedItem {
    return {
      __cursor: entry.id,
      id: entry.id,
      actors: [],
      blocks: [
        { name: "body", type: "markdown", content: "", rendered: entry.html },
        { name: "action_url", type: "text", content: "", rendered: "" },
      ],
      inserted_at: entry.inserted_at,
      updated_at: entry.inserted_at,
      read_at: entry.read_at,
      seen_at: entry.seen_at,
      clicked_at: null,
      interacted_at: null,
      link_clicked_at: null,
      archived_at: null,
      total_actors: 0,
      data: entry.data,
      source: { key: entry.workflow, version_id: "v1", categories: [] },
      tenant: null,
    };
  }

  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function fetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://cadence.test"
    );
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    const userToken = headers.get("X-Knock-User-Token");
    const body: unknown =
      typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      method,
      path: url.pathname,
      userToken,
      authorization: headers.get("Authorization"),
      body,
    });

    if (url.pathname === "/api/knock-token" && method === "POST") {
      return json(refreshResponse.status, refreshResponse.body);
    }
    const rejectedWith = userToken ? rejectedTokens.get(userToken) : undefined;
    if (rejectedWith !== undefined) {
      return json(rejectedWith, {
        code: "invalid_user_token",
        message: "The user token has expired",
        status: rejectedWith,
        type: "authentication_error",
      });
    }

    const preferences = url.pathname.match(
      /^\/v1\/users\/([^/]+)\/preferences\/default$/
    );
    if (preferences && preferenceFailure) {
      return json(preferenceFailure.status, preferenceFailure.body);
    }
    if (preferences && method === "GET") {
      const knockId = preferences[1];
      if (!preferenceSets.has(knockId)) {
        return json(404, {
          code: "resource_missing",
          message: "The resource you requested does not exist",
          status: 404,
          type: "api_error",
        });
      }
      return json(200, preferenceSet(preferenceSets.get(knockId) ?? null));
    }
    if (preferences && method === "PUT") {
      const knockId = preferences[1];
      const written =
        isRecord(body) && isRecord(body.categories) ? body.categories : {};
      // A merge write keeps the categories it doesn't name. Knock doesn't say
      // whether it merges inside a category too, so this fake doesn't: each
      // category sent replaces the saved one. Anything else replaces the set.
      const merge = isRecord(body) && body.__persistence_strategy__ === "merge";
      const saved = merge ? (preferenceSets.get(knockId) ?? {}) : {};
      const next = { ...saved, ...written };
      preferenceSets.set(knockId, next);
      return json(200, preferenceSet(next));
    }

    if (
      method === "GET" &&
      /^\/v1\/users\/[^/]+\/feeds\/[^/]+$/.test(url.pathname)
    ) {
      return json(200, {
        entries: entries.map(toFeedItem),
        meta: {
          total_count: entries.length,
          unread_count: entries.filter((e) => !e.read_at).length,
          unseen_count: entries.filter((e) => !e.seen_at).length,
        },
        page_info: { before: null, after: null, page_size: 50 },
      });
    }

    const isMark =
      method === "POST" &&
      /^\/v1\/(messages\/batch|channels\/[^/]+\/messages\/bulk)\//.test(
        url.pathname
      );
    if (isMark && markRefusal !== null) {
      return json(markRefusal, {
        code: "authorization",
        message: "Refused",
        status: markRefusal,
        type: "api_error",
      });
    }

    const batch = url.pathname.match(/^\/v1\/messages\/batch\/(read|seen)$/);
    if (method === "POST" && batch) {
      const ids = messageIds(body);
      entries = entries.map((e) =>
        ids.has(e.id) ? mark(e, batch[1] === "read" ? "read" : "seen") : e
      );
      return json(200, []);
    }

    const bulk = url.pathname.match(
      /^\/v1\/channels\/[^/]+\/messages\/bulk\/(read|seen)$/
    );
    if (method === "POST" && bulk) {
      entries = entries.map((e) =>
        mark(e, bulk[1] === "read" ? "read" : "seen")
      );
      return json(200, { id: "bulk-1", status: "completed" });
    }

    if (method === "PUT" && /^\/v1\/users\/[^/]+$/.test(url.pathname)) {
      return json(200, { id: url.pathname.split("/").pop() });
    }

    return json(404, { errors: { detail: "404 Not Found" } });
  }

  function preferenceSet(categories: SavedCategories) {
    return {
      __typename: "PreferenceSet",
      id: "default",
      categories,
      workflows: null,
      channel_types: null,
      channels: null,
      commercial_subscribed: null,
    };
  }

  function mark(entry: FeedEntry, status: "read" | "seen"): FeedEntry {
    return status === "read"
      ? {
          ...entry,
          read_at: entry.read_at ?? now(),
          seen_at: entry.seen_at ?? now(),
        }
      : { ...entry, seen_at: entry.seen_at ?? now() };
  }

  return {
    fetch,
    requests,
    /** Puts Notifications in the feed, newest first. */
    setFeed(next: Array<Partial<FeedEntry> & Pick<FeedEntry, "id">>) {
      entries = next.map((e) => ({
        workflow: "refund-request-raised",
        html: "<p>A Notification</p>",
        data: null,
        inserted_at: "2026-11-14T12:00:00.000Z",
        read_at: null,
        seen_at: null,
        ...e,
      }));
    },
    /**
     * Knock answers `invalid_user_token` to any request carrying this token:
     * 401 by default, or the 400 #22 saw for a token it couldn't verify.
     */
    rejectToken(token: string, status: 400 | 401 = 401) {
      rejectedTokens.set(token, status);
    },
    /**
     * The user's saved preference categories, as if they'd saved them
     * before. Null: Knock knows the user, but they've saved nothing.
     */
    savePreferences(knockId: string, categories: SavedCategories) {
      preferenceSets.set(knockId, categories);
    },
    /** Knock answers every preference read and save with this. */
    failPreferencesWith(status: number, body: unknown) {
      preferenceFailure = { status, body };
    },
    /** Knock answers every read, seen or bulk mark with this status. */
    refuseMarksWith(status: number) {
      markRefusal = status;
    },
    /** What POST /api/knock-token answers. By default, 401. */
    refreshWith(knockId: string, userToken: string) {
      refreshResponse = { status: 200, body: { knockId, userToken } };
    },
    /** Requests that went to Knock, not to the app. */
    knockRequests() {
      return requests.filter((r) => r.path.startsWith("/v1/"));
    },
  };
}

export type FakeKnockApi = ReturnType<typeof fakeKnockApi>;
