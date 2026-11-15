import { describe, expect, it } from "vitest";
import {
  chooseTransport,
  knockTransport,
  type KnockTrigger,
} from "./notification-transports.server";

// Every test passes its own environment. None reads process.env.

function choose(env: Record<string, string>) {
  const warnings: string[] = [];
  const choice = chooseTransport(env, (message) => warnings.push(message));
  return { choice, warnings };
}

describe("choosing the notification transport", () => {
  it("keeps sending off by default, writing triggers to .outbox/notifications/", () => {
    expect(choose({ NODE_ENV: "development" })).toEqual({
      choice: { kind: "folder", directory: ".outbox/notifications" },
      warnings: [],
    });
  });

  it("keeps sending off when the Knock keys are set but the switch isn't", () => {
    expect(
      choose({ NODE_ENV: "development", KNOCK_API_KEY: "sk_test_123" }).choice
    ).toEqual({ kind: "folder", directory: ".outbox/notifications" });
  });

  it("sends to Knock when KNOCK_TRIGGERS=on", () => {
    expect(
      choose({
        NODE_ENV: "development",
        KNOCK_TRIGGERS: "on",
        KNOCK_API_KEY: "sk_test_123",
      }).choice
    ).toEqual({ kind: "knock", apiKey: "sk_test_123" });
  });

  it("warns outside Production that Notifications are going to Knock and spending the budget", () => {
    const { warnings } = choose({
      NODE_ENV: "development",
      KNOCK_TRIGGERS: "on",
      KNOCK_API_KEY: "sk_test_123",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/going to Knock/);
    expect(warnings[0]).toMatch(/monthly budget/);
  });

  it("refuses to start when the switch is on but KNOCK_API_KEY is missing", () => {
    expect(() =>
      choose({ NODE_ENV: "development", KNOCK_TRIGGERS: "on" })
    ).toThrow(/KNOCK_API_KEY/);
  });

  describe("under NODE_ENV=production", () => {
    it("sends to Knock, without the warning", () => {
      expect(
        choose({
          NODE_ENV: "production",
          KNOCK_TRIGGERS: "on",
          KNOCK_API_KEY: "sk_live_123",
        })
      ).toEqual({
        choice: { kind: "knock", apiKey: "sk_live_123" },
        warnings: [],
      });
    });

    it("refuses to start, rather than use the folder, when KNOCK_TRIGGERS isn't on", () => {
      expect(() =>
        choose({ NODE_ENV: "production", KNOCK_API_KEY: "sk_live_123" })
      ).toThrow(/KNOCK_TRIGGERS=on/);
    });

    it("refuses to start, rather than use the folder, when KNOCK_API_KEY is missing", () => {
      expect(() =>
        choose({ NODE_ENV: "production", KNOCK_TRIGGERS: "on" })
      ).toThrow(/KNOCK_API_KEY/);
    });
  });
});

describe("the Knock transport", () => {
  const trigger: KnockTrigger = {
    workflow: "refund-request-raised",
    recipients: [{ id: "admin-knock-id", name: "Pat", email: "pat@example.com" }],
    actor: { id: "buyer-knock-id", name: "Liam", email: "liam@example.com" },
    data: {
      buyer_name: "Liam",
      course_title: "Test Course",
      reason: "Not for me.",
      path: "/admin/refunds",
    },
    idempotencyKey: "0b6f1f4e-9a43-4b2a-8f3e-2f1c5d7a9e10",
  };

  // Stands in for the network, so nothing reaches Knock.
  function fakeFetch(status: number) {
    const requests: { url: string; headers: Headers; body: unknown }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ workflow_run_id: "run_1" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };
    return { fetch, requests };
  }

  it("triggers the workflow with the row's UUID as the idempotency key", async () => {
    const { fetch, requests } = fakeFetch(200);

    await knockTransport("sk_test_123", { fetch }).send(trigger);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toMatch(/\/v1\/workflows\/refund-request-raised\/trigger$/);
    expect(requests[0].headers.get("Idempotency-Key")).toBe(trigger.idempotencyKey);
    expect(requests[0].body).toEqual({
      recipients: trigger.recipients,
      actor: trigger.actor,
      data: trigger.data,
    });
  });

  it("throws on a failed send without retrying it, leaving retries to the outbox", async () => {
    const { fetch, requests } = fakeFetch(503);

    await expect(
      knockTransport("sk_test_123", { fetch }).send(trigger)
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});
