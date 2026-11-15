import { generateKeyPairSync, verify } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import { setCurrentUserId } from "~/lib/session";
import {
  knockClientConfig,
  refreshKnockUserToken,
} from "./knock-user-token.server";

// A throwaway key, shaped like the real KNOCK_SIGNING_KEY: a PKCS#8 PEM,
// Base-64 encoded onto one line.
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const env = {
  KNOCK_PUBLIC_API_KEY: "pk_test_bell",
  KNOCK_SIGNING_KEY: Buffer.from(keys.privateKey).toString("base64"),
  KNOCK_FEED_CHANNEL_ID: "2deed2a4-0000-4000-8000-000000000044",
};

const KNOCK_ID = "6f1c2c7e-5d0a-4c55-9a43-0d7b8f0e2a44";

function readJwt(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    signedWithOurKey: verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      keys.publicKey,
      Buffer.from(signature, "base64url")
    ),
  };
}

describe("knockClientConfig", () => {
  it("signs a 1-hour RS256 token whose sub is the user's Knock id", async () => {
    const config = await knockClientConfig(KNOCK_ID, env);
    if (!config) throw new Error("expected a config");

    const jwt = readJwt(config.userToken);
    expect(jwt.signedWithOurKey).toBe(true);
    expect(jwt.header.alg).toBe("RS256");
    expect(jwt.payload.sub).toBe(KNOCK_ID);
    expect(jwt.payload.exp - jwt.payload.iat).toBe(3600);
  });

  it("passes the Knock id, public key and feed channel id to the bell", async () => {
    expect(await knockClientConfig(KNOCK_ID, env)).toMatchObject({
      knockId: KNOCK_ID,
      publicApiKey: "pk_test_bell",
      feedChannelId: "2deed2a4-0000-4000-8000-000000000044",
    });
  });

  it.each([
    "KNOCK_PUBLIC_API_KEY",
    "KNOCK_SIGNING_KEY",
    "KNOCK_FEED_CHANNEL_ID",
  ])(
    "gives no config without %s, so the app loads with no bell",
    async (name) => {
      expect(
        await knockClientConfig(KNOCK_ID, { ...env, [name]: undefined })
      ).toBeNull();
    }
  );

  it("logs and gives no config when the signing key can't be read", async () => {
    const logged: unknown[][] = [];
    const config = await knockClientConfig(
      KNOCK_ID,
      { ...env, KNOCK_SIGNING_KEY: "not-a-key" },
      { error: (...args: unknown[]) => logged.push(args) }
    );

    expect(config).toBeNull();
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toContain("KNOCK_SIGNING_KEY");
  });
});

describe("refreshKnockUserToken (POST /api/knock-token)", () => {
  let db: ReturnType<typeof createTestDb>;
  let base: ReturnType<typeof seedBaseData>;

  beforeEach(() => {
    db = createTestDb();
    base = seedBaseData(db);
  });

  async function requestAs(userId: number | null) {
    const headers = new Headers();
    if (userId !== null) {
      const setCookie = await setCurrentUserId(
        new Request("http://cadence.test/"),
        userId
      );
      headers.set("Cookie", setCookie.split(";")[0]);
    }
    return new Request("http://cadence.test/api/knock-token", {
      method: "POST",
      headers,
    });
  }

  it("returns a fresh token for whoever is in the session now", async () => {
    const response = await refreshKnockUserToken(
      await requestAs(base.instructor.id),
      db,
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.knockId).toBe(base.instructor.knockId);
    const jwt = readJwt(body.userToken);
    expect(jwt.signedWithOurKey).toBe(true);
    expect(jwt.payload.sub).toBe(base.instructor.knockId);
  });

  it("answers 401 with no user in the session", async () => {
    await expect(
      refreshKnockUserToken(await requestAs(null), db, env)
    ).rejects.toMatchObject({ init: { status: 401 } });
  });

  it("answers 401 when the session's user no longer exists", async () => {
    await expect(
      refreshKnockUserToken(await requestAs(9999), db, env)
    ).rejects.toMatchObject({ init: { status: 401 } });
  });

  it("answers 404 when Knock isn't set up", async () => {
    await expect(
      refreshKnockUserToken(await requestAs(base.user.id), db, {})
    ).rejects.toMatchObject({ init: { status: 404 } });
  });
});
