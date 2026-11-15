import Knock from "@knocklabs/client";
import { z } from "zod";

// ─── Knock in the browser ───
// The bell (and, from #47, the /settings Notifications section) talks to
// Knock straight from the browser, with the public key and a user token the
// server signed. The layout loader puts a KnockClientConfig in its data for
// whoever is signed in, or null when nobody is or Knock isn't set up.

/** What the browser needs to talk to Knock as the signed-in user. */
export type KnockClientConfig = {
  publicApiKey: string;
  /** The user's `users.knock_id`, which is their Knock user id and the token's `sub`. */
  knockId: string;
  /** A 1-hour RS256 token signed with KNOCK_SIGNING_KEY. */
  userToken: string;
  /** The `in-app` channel's id, which the bell reads its feed from. */
  feedChannelId: string;
};

export type KnockConnection = {
  knock: Knock;
  knockId: string;
  /**
   * Runs a Knock call. If Knock answers 401, gets a fresh token from
   * POST /api/knock-token, signs in with it and runs the call once more.
   * `statusOf` reads the HTTP status from the call's result, if it failed.
   */
  withFreshToken<T>(
    call: () => Promise<T>,
    statusOf: (result: T) => number | undefined
  ): Promise<T>;
  /** Stops the token refresh timer and drops the feed. */
  disconnect(): void;
};

/**
 * Signs in to Knock in the browser as the config's user. It never identifies
 * them: Knock's default would PUT /v1/users/{id} on every page load and so
 * create everyone in Knock. Users first reach Knock through a trigger or a
 * preference save (ADR 0015).
 */
export function connectKnock(config: KnockClientConfig): KnockConnection {
  const knock = new Knock(config.publicApiKey);
  const signIn = (userToken: string) =>
    knock.authenticate({ id: config.knockId }, userToken, {
      identificationStrategy: "skip",
      // 30s before the token expires, the SDK asks for a fresh one and signs
      // in with it. Returning nothing leaves the old one in place.
      onUserTokenExpiring: async () =>
        (await requestKnockUserToken(config.knockId)) ?? undefined,
    });
  signIn(config.userToken);

  // One refresh at a time, however many calls got a 401 together.
  let refreshing: Promise<boolean> | null = null;
  function refreshToken(): Promise<boolean> {
    refreshing ??= requestKnockUserToken(config.knockId)
      .then((userToken) => {
        if (userToken) signIn(userToken);
        return userToken !== null;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  return {
    knock,
    knockId: config.knockId,
    async withFreshToken(call, statusOf) {
      const result = await call();
      if (statusOf(result) !== 401 || !(await refreshToken())) return result;
      return call();
    },
    disconnect: () => knock.logout(),
  };
}

const freshToken = z.object({ knockId: z.string(), userToken: z.string() });

/**
 * A fresh token for whoever is in the session now, from POST
 * /api/knock-token. Null if there's none, or if it's for someone other than
 * `knockId` because the session's user changed in another tab.
 */
export async function requestKnockUserToken(
  knockId: string
): Promise<string | null> {
  try {
    const response = await fetch("/api/knock-token", {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const parsed = freshToken.safeParse(await response.json());
    if (!parsed.success || parsed.data.knockId !== knockId) return null;
    return parsed.data.userToken;
  } catch {
    return null;
  }
}

const failedRequest = z.object({ response: z.object({ status: z.number() }) });

/** The HTTP status of a failed @knocklabs/client call, from the error it hands back. */
export function knockErrorStatus(value: unknown): number | undefined {
  const parsed = failedRequest.safeParse(value);
  return parsed.success ? parsed.data.response.status : undefined;
}
