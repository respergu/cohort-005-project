import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeKnockApi,
  fakeUserToken,
  type FakeKnockApi,
} from "~/test/fake-knock-api";
import { connectKnock, type KnockConnection } from "./knock-browser";
import {
  createNotificationFeed,
  sanitizeFeedHtml,
  unreadBadgeLabel,
  type NotificationFeed,
} from "./notification-feed";

const KNOCK_ID = "6f1c2c7e-5d0a-4c55-9a43-0d7b8f0e2a44";
const CHANNEL = "2deed2a4-0000-4000-8000-000000000044";

describe("the bell's feed", () => {
  let api: FakeKnockApi;
  let connection: KnockConnection | undefined;
  let notifications: NotificationFeed | undefined;
  let firstToken: string;

  beforeEach(() => {
    api = fakeKnockApi();
    vi.stubGlobal("fetch", api.fetch);
    firstToken = fakeUserToken(
      KNOCK_ID,
      Math.floor(Date.now() / 1000) + 3600,
      "first"
    );
  });

  afterEach(() => {
    notifications?.dispose();
    connection?.disconnect();
    notifications = undefined;
    connection = undefined;
    vi.unstubAllGlobals();
  });

  function openBell() {
    connection = connectKnock({
      publicApiKey: "pk_test_bell",
      knockId: KNOCK_ID,
      userToken: firstToken,
      feedChannelId: CHANNEL,
    });
    notifications = createNotificationFeed(connection, CHANNEL);
    return notifications;
  }

  it("reads the user's feed with the public key and their token", async () => {
    api.setFeed([
      { id: "n1" },
      { id: "n2", read_at: "2026-11-14T11:00:00.000Z" },
    ]);
    const feed = openBell();

    await feed.load();

    expect(api.knockRequests()).toEqual([
      expect.objectContaining({
        method: "GET",
        path: `/v1/users/${KNOCK_ID}/feeds/${CHANNEL}`,
        authorization: "Bearer pk_test_bell",
        userToken: firstToken,
      }),
    ]);
    expect(feed.getSnapshot()).toMatchObject({
      status: "ready",
      unreadCount: 1,
    });
  });

  it("creates no Knock user when it loads for someone Knock has never seen", async () => {
    api.setFeed([]);
    const feed = openBell();

    await feed.load();

    expect(api.knockRequests().map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /v1/users/${KNOCK_ID}/feeds/${CHANNEL}`,
    ]);
    expect(feed.getSnapshot()).toMatchObject({ status: "ready", rows: [] });
  });

  it("turns each item into a row with its sanitized sentence, course and path", async () => {
    api.setFeed([
      {
        id: "n1",
        html: '<p><strong>Ana Buyer</strong> asked for a refund: <a href="https://evil.test">see</a></p>',
        data: {
          buyer_name: "Ana Buyer",
          course_title: "Intro to SQL",
          path: "/admin/refunds",
          reason: "see",
        },
        inserted_at: "2026-11-14T11:58:00.000Z",
      },
    ]);
    const feed = openBell();

    await feed.load();

    expect(feed.getSnapshot().rows).toEqual([
      {
        id: "n1",
        workflow: "refund-request-raised",
        html: "<p><strong>Ana Buyer</strong> asked for a refund: see</p>",
        courseTitle: "Intro to SQL",
        path: "/admin/refunds",
        insertedAt: "2026-11-14T11:58:00.000Z",
        unread: true,
        data: {
          buyer_name: "Ana Buyer",
          course_title: "Intro to SQL",
          path: "/admin/refunds",
          reason: "see",
        },
      },
    ]);
  });

  it.each([
    "//evil.test/admin",
    "https://evil.test",
    "/\\evil.test",
    "admin/refunds",
  ])("gives a row no path to follow when data.path is %s", async (path) => {
    api.setFeed([{ id: "n1", data: { course_title: "Intro to SQL", path } }]);
    const feed = openBell();

    await feed.load();

    expect(feed.getSnapshot().rows[0]?.path).toBeNull();
  });

  const FEED_READ = `GET /v1/users/${KNOCK_ID}/feeds/${CHANNEL}`;
  const sent = () => api.knockRequests().map((r) => `${r.method} ${r.path}`);

  it("opening the popover reads the feed again and marks it seen, without lowering the count", async () => {
    api.setFeed([{ id: "n1" }, { id: "n2" }]);
    const feed = openBell();
    await feed.load();

    await feed.open();

    expect(sent().filter((r) => r === FEED_READ)).toHaveLength(2);
    expect(api.knockRequests()).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: `/v1/channels/${CHANNEL}/messages/bulk/seen`,
        body: expect.objectContaining({ user_ids: [KNOCK_ID] }),
      })
    );
    expect(feed.getSnapshot().unreadCount).toBe(2);

    await feed.load();
    expect(feed.getSnapshot().unreadCount).toBe(2);
  });

  it("reading a row marks it read in Knock and lowers the count", async () => {
    api.setFeed([{ id: "n1" }, { id: "n2" }]);
    const feed = openBell();
    await feed.load();

    await feed.markRead("n1");

    expect(api.knockRequests()).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/v1/messages/batch/read",
        body: { message_ids: ["n1"] },
      })
    );
    expect(feed.getSnapshot().unreadCount).toBe(1);
    expect(feed.getSnapshot().rows.find((r) => r.id === "n1")?.unread).toBe(
      false
    );

    await feed.load();
    expect(feed.getSnapshot().unreadCount).toBe(1);
  });

  it("reading a row that's already read sends nothing", async () => {
    api.setFeed([{ id: "n1", read_at: "2026-11-14T11:00:00.000Z" }]);
    const feed = openBell();
    await feed.load();

    await feed.markRead("n1");

    expect(sent()).toEqual([FEED_READ]);
  });

  it("mark all as read clears the badge", async () => {
    api.setFeed([{ id: "n1" }, { id: "n2" }, { id: "n3" }]);
    const feed = openBell();
    await feed.load();

    await feed.markAllRead();

    expect(sent()).toContain(`POST /v1/channels/${CHANNEL}/messages/bulk/read`);
    expect(feed.getSnapshot().unreadCount).toBe(0);

    await feed.load();
    expect(feed.getSnapshot().unreadCount).toBe(0);
  });

  it("puts back what Knock holds when it refuses a mark", async () => {
    api.setFeed([{ id: "n1" }, { id: "n2" }]);
    const feed = openBell();
    await feed.load();
    api.refuseMarksWith(403);

    await feed.markAllRead();

    expect(feed.getSnapshot().unreadCount).toBe(2);
    expect(feed.getSnapshot().rows.every((r) => r.unread)).toBe(true);
  });

  describe("before the token expires", () => {
    const START = new Date("2026-11-14T12:00:00.000Z");
    const startSeconds = START.getTime() / 1000;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      vi.setSystemTime(START);
      firstToken = fakeUserToken(KNOCK_ID, startSeconds + 3600, "first");
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("gets a fresh token without a reload, and still never identifies the user", async () => {
      const freshToken = fakeUserToken(KNOCK_ID, startSeconds + 7200, "fresh");
      api.setFeed([{ id: "n1" }]);
      api.refreshWith(KNOCK_ID, freshToken);
      const feed = openBell();
      await feed.load();

      await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
      expect(api.requests.map((r) => r.path)).not.toContain("/api/knock-token");

      await vi.advanceTimersByTimeAsync(45 * 1000);
      expect(api.requests.map((r) => r.path)).toContain("/api/knock-token");

      await feed.load();
      expect(api.knockRequests().at(-1)?.userToken).toBe(freshToken);
      expect(api.requests.filter((r) => r.method === "PUT")).toEqual([]);
    });
  });

  describe("after Knock answers 401", () => {
    let freshToken: string;

    beforeEach(() => {
      freshToken = fakeUserToken(
        KNOCK_ID,
        Math.floor(Date.now() / 1000) + 7200,
        "fresh"
      );
    });

    it("gets a fresh token from /api/knock-token and reads the feed with it", async () => {
      api.setFeed([{ id: "n1" }]);
      api.rejectToken(firstToken);
      api.refreshWith(KNOCK_ID, freshToken);
      const feed = openBell();

      await feed.load();

      expect(api.requests).toContainEqual(
        expect.objectContaining({ method: "POST", path: "/api/knock-token" })
      );
      expect(api.knockRequests().at(-1)).toMatchObject({
        method: "GET",
        path: `/v1/users/${KNOCK_ID}/feeds/${CHANNEL}`,
        userToken: freshToken,
      });
      expect(feed.getSnapshot()).toMatchObject({
        status: "ready",
        unreadCount: 1,
      });
    });

    it("won't use a token for someone else, if the session's user changed", async () => {
      api.setFeed([{ id: "n1" }]);
      api.rejectToken(firstToken);
      api.refreshWith("someone-else", freshToken);
      const feed = openBell();

      await feed.load();

      expect(api.knockRequests().map((r) => r.userToken)).not.toContain(
        freshToken
      );
      expect(feed.getSnapshot().status).toBe("error");
    });

    it("sends a read again with a fresh token, lowering the count once", async () => {
      api.setFeed([{ id: "n1" }, { id: "n2" }]);
      const feed = openBell();
      await feed.load();
      api.rejectToken(firstToken);
      api.refreshWith(KNOCK_ID, freshToken);

      await feed.markRead("n1");

      expect(
        api
          .knockRequests()
          .filter((r) => r.path === "/v1/messages/batch/read")
          .at(-1)
      ).toMatchObject({ userToken: freshToken, body: { message_ids: ["n1"] } });
      expect(feed.getSnapshot().unreadCount).toBe(1);

      await feed.load();
      expect(feed.getSnapshot().unreadCount).toBe(1);
    });

    it("shows an error when there's no fresh token to be had", async () => {
      api.setFeed([{ id: "n1" }]);
      api.rejectToken(firstToken);
      const feed = openBell();

      await feed.load();

      expect(feed.getSnapshot().status).toBe("error");
    });
  });
});

describe("unreadBadgeLabel", () => {
  it("is hidden at zero", () => {
    expect(unreadBadgeLabel(0)).toBeNull();
  });

  it("shows the count up to nine", () => {
    expect(unreadBadgeLabel(1)).toBe("1");
    expect(unreadBadgeLabel(9)).toBe("9");
  });

  it("shows 9+ above nine", () => {
    expect(unreadBadgeLabel(10)).toBe("9+");
    expect(unreadBadgeLabel(250)).toBe("9+");
  });
});

describe("sanitizeFeedHtml", () => {
  it("keeps p, strong and em", () => {
    expect(
      sanitizeFeedHtml(
        "<p><strong>Ana Buyer</strong> asked for a refund on <em>Intro to SQL</em>.</p>"
      )
    ).toBe(
      "<p><strong>Ana Buyer</strong> asked for a refund on <em>Intro to SQL</em>.</p>"
    );
  });

  it("strips every attribute from the tags it keeps", () => {
    expect(
      sanitizeFeedHtml(
        `<p class="lead" style="color:red"><strong onclick="steal()">Ana</strong> <em title="a>b">said</em></p>`
      )
    ).toBe("<p><strong>Ana</strong> <em>said</em></p>");
  });

  it("strips links and images from a reason, keeping the link text", () => {
    // A refund reason of `see [my bank](https://evil.test) ![](https://evil.test/t.png)`
    // comes back from Knock's Markdown renderer as a link and an image.
    expect(
      sanitizeFeedHtml(
        `<p>Reason: see <a href="https://evil.test" target="_blank">my bank</a> <img src="https://evil.test/t.png" alt="pixel"></p>`
      )
    ).toBe("<p>Reason: see my bank </p>");
  });

  it("drops every other tag, and the contents of scripts and styles", () => {
    expect(
      sanitizeFeedHtml(
        "<div><h1>Hi</h1><p>Ok<br>then</p><script>alert(1)</script><style>p{}</style><!-- note --></div>"
      )
    ).toBe("Hi<p>Okthen</p>");
  });

  it("escapes a stray < or & so leftover text can't become markup", () => {
    expect(
      sanitizeFeedHtml(
        "<p>1 &lt; 2 &amp; AT&T &#39;ok&#x27;</p><img src=x onerror=alert(1)"
      )
    ).toBe(
      "<p>1 &lt; 2 &amp; AT&amp;T &#39;ok&#x27;</p>&lt;img src=x onerror=alert(1)"
    );
  });
});
