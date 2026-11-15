import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserRole } from "~/db/schema";
import {
  fakeKnockApi,
  fakeUserToken,
  type FakeKnockApi,
} from "~/test/fake-knock-api";
import { connectKnock, type KnockConnection } from "./knock-browser";
import {
  createNotificationPreferences,
  preferenceRowsFor,
} from "./notification-preferences";

const KNOCK_ID = "0b6d3f8e-4a47-4c1e-9f55-47a1c0de0047";
const PREFERENCES = `/v1/users/${KNOCK_ID}/preferences/default`;

// Cadence's defaults, from the rows table in #47 and PRD #37. Every Feed is
// on; email is off where it's opt-in or not offered.
const CADENCE_DEFAULTS = {
  "refund-request-raised": { in_app_feed: true, email: true },
  "refund-request-approved": { in_app_feed: true, email: false },
  "seat-claims": { in_app_feed: true, email: true },
  "new-enrollment": { in_app_feed: true, email: false },
  "new-question": { in_app_feed: true, email: true },
  reply: { in_app_feed: true, email: true },
  "new-lesson": { in_app_feed: true, email: false },
};

describe("a person's preferences in Knock", () => {
  let api: FakeKnockApi;
  let connection: KnockConnection | undefined;
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
    connection?.disconnect();
    connection = undefined;
    vi.unstubAllGlobals();
  });

  function openSettings() {
    connection = connectKnock({
      publicApiKey: "pk_test_settings",
      knockId: KNOCK_ID,
      userToken: firstToken,
      feedChannelId: "2deed2a4-0000-4000-8000-000000000044",
    });
    return createNotificationPreferences(connection);
  }

  const sent = () => api.knockRequests().map((r) => `${r.method} ${r.path}`);

  it("shows Cadence's defaults to someone Knock has never seen, and creates no Knock user", async () => {
    const preferences = openSettings();

    const loaded = await preferences.load();

    expect(loaded).toEqual({ status: "ready", choices: CADENCE_DEFAULTS });
    expect(api.knockRequests()).toEqual([
      expect.objectContaining({
        method: "GET",
        path: PREFERENCES,
        authorization: "Bearer pk_test_settings",
        userToken: firstToken,
      }),
    ]);
  });

  it("shows what the person saved, and Cadence's defaults for anything they haven't", async () => {
    api.savePreferences(KNOCK_ID, {
      "new-question": { channel_types: { email: false } },
      "new-enrollment": { channel_types: { in_app_feed: false, email: true } },
      reply: false,
      "seat-claims": null,
    });
    const preferences = openSettings();

    const loaded = await preferences.load();

    expect(loaded).toEqual({
      status: "ready",
      choices: {
        ...CADENCE_DEFAULTS,
        "new-question": { in_app_feed: true, email: false },
        "new-enrollment": { in_app_feed: false, email: true },
        reply: { in_app_feed: false, email: false },
      },
    });
  });

  it("shows Cadence's defaults to someone Knock knows who has saved nothing", async () => {
    api.savePreferences(KNOCK_ID, null);
    const preferences = openSettings();

    expect(await preferences.load()).toEqual({
      status: "ready",
      choices: CADENCE_DEFAULTS,
    });
  });

  it("is an error, not 'nothing saved yet', when Knock answers some other 404", async () => {
    api.failPreferencesWith(404, { errors: { detail: "404 Not Found" } });
    const preferences = openSettings();

    expect(await preferences.load()).toEqual({ status: "error" });
  });

  it("saving one row merges it into Knock, leaving every other saved choice as it was", async () => {
    api.savePreferences(KNOCK_ID, {
      "new-question": { channel_types: { in_app_feed: true, email: false } },
      reply: { channel_types: { in_app_feed: false, email: true } },
    });
    const preferences = openSettings();
    await preferences.load();

    const saved = await preferences.save("new-enrollment", {
      in_app_feed: true,
      email: true,
    });

    expect(saved).toBe("saved");
    expect(api.knockRequests().at(-1)).toMatchObject({
      method: "PUT",
      path: PREFERENCES,
      userToken: firstToken,
      body: {
        __persistence_strategy__: "merge",
        categories: {
          "new-enrollment": {
            channel_types: { in_app_feed: true, email: true },
          },
        },
      },
    });
    expect(await preferences.load()).toEqual({
      status: "ready",
      choices: {
        ...CADENCE_DEFAULTS,
        "new-question": { in_app_feed: true, email: false },
        reply: { in_app_feed: false, email: true },
        "new-enrollment": { in_app_feed: true, email: true },
      },
    });
  });

  it("the first save from someone Knock has never seen works, and later reads show it", async () => {
    const preferences = openSettings();
    await preferences.load();

    const saved = await preferences.save("refund-request-approved", {
      in_app_feed: true,
      email: true,
    });

    expect(saved).toBe("saved");
    expect(await preferences.load()).toEqual({
      status: "ready",
      choices: {
        ...CADENCE_DEFAULTS,
        "refund-request-approved": { in_app_feed: true, email: true },
      },
    });
    expect(sent()).toEqual([
      `GET ${PREFERENCES}`,
      `PUT ${PREFERENCES}`,
      `GET ${PREFERENCES}`,
    ]);
  });

  it("says a save failed when Knock refuses it", async () => {
    const preferences = openSettings();
    await preferences.load();
    api.failPreferencesWith(403, {
      code: "authorization",
      message: "Not allowed",
      status: 403,
      type: "authorization_error",
    });

    expect(
      await preferences.save("reply", { in_app_feed: false, email: true })
    ).toBe("error");
  });

  describe.each([401, 400] as const)(
    "after Knock rejects the token with %i invalid_user_token",
    (status) => {
      let freshToken: string;

      beforeEach(() => {
        freshToken = fakeUserToken(
          KNOCK_ID,
          Math.floor(Date.now() / 1000) + 7200,
          "fresh"
        );
        api.rejectToken(firstToken, status);
        api.refreshWith(KNOCK_ID, freshToken);
      });

      it("reads the preferences again with a fresh token", async () => {
        api.savePreferences(KNOCK_ID, { reply: false });
        const preferences = openSettings();

        const loaded = await preferences.load();

        expect(api.requests).toContainEqual(
          expect.objectContaining({ method: "POST", path: "/api/knock-token" })
        );
        expect(api.knockRequests().at(-1)).toMatchObject({
          method: "GET",
          path: PREFERENCES,
          userToken: freshToken,
        });
        expect(loaded).toEqual({
          status: "ready",
          choices: {
            ...CADENCE_DEFAULTS,
            reply: { in_app_feed: false, email: false },
          },
        });
      });

      it("saves with a fresh token", async () => {
        const preferences = openSettings();

        const saved = await preferences.save("reply", {
          in_app_feed: false,
          email: true,
        });

        expect(saved).toBe("saved");
        expect(api.knockRequests().at(-1)).toMatchObject({
          method: "PUT",
          userToken: freshToken,
        });
      });
    }
  );

  it("doesn't ask for a fresh token when Knock answers 400 for some other reason", async () => {
    api.failPreferencesWith(400, {
      code: "invalid_params",
      message: "Invalid preference set",
      status: 400,
      type: "invalid_request_error",
    });
    api.refreshWith(KNOCK_ID, fakeUserToken(KNOCK_ID, 0, "unused"));
    const preferences = openSettings();

    const saved = await preferences.save("reply", {
      in_app_feed: false,
      email: true,
    });

    expect(saved).toBe("error");
    expect(api.requests.map((r) => r.path)).not.toContain("/api/knock-token");
  });
});

describe("the rows a person sees", () => {
  const categoriesFor = (role: UserRole, isTeamAdmin = false) =>
    preferenceRowsFor({ role, isTeamAdmin }).map((row) => row.category);

  it("a Platform Admin sees Refund Request raised and Reply", () => {
    expect(categoriesFor(UserRole.Admin)).toEqual([
      "refund-request-raised",
      "reply",
    ]);
  });

  it("an Instructor sees Refund Request approved, New Enrollment, New Question and Reply", () => {
    expect(categoriesFor(UserRole.Instructor)).toEqual([
      "refund-request-approved",
      "new-enrollment",
      "new-question",
      "reply",
    ]);
  });

  it("a Student sees Reply, New lesson and the locked Refunds row", () => {
    expect(categoriesFor(UserRole.Student)).toEqual([
      "reply",
      "new-lesson",
      "refunds",
    ]);
  });

  it("a Team Admin also sees Seat claims", () => {
    expect(categoriesFor(UserRole.Student, true)).toEqual([
      "seat-claims",
      "reply",
      "new-lesson",
      "refunds",
    ]);
  });

  it("someone with more than one role sees all of their rows, each once", () => {
    expect(categoriesFor(UserRole.Instructor, true)).toEqual([
      "refund-request-approved",
      "seat-claims",
      "new-enrollment",
      "new-question",
      "reply",
      "refunds",
    ]);
  });

  it("offers a Feed toggle on every row but Refunds, and email everywhere but New lesson", () => {
    const rows = preferenceRowsFor({
      role: UserRole.Student,
      isTeamAdmin: true,
    });

    expect(
      rows.map((row) =>
        row.locked ? row.readOnly : `${row.label}: ${row.channels.join(" + ")}`
      )
    ).toEqual([
      "Seat claims: in_app_feed + email",
      "Reply: in_app_feed + email",
      "New lesson: in_app_feed",
      "Refunds: always sent by Feed and email",
    ]);
  });
});
