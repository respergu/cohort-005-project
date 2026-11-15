import Knock from "@knocklabs/client";
import { z } from "zod";

// ─── Knock in the browser ───
// The bell and the /settings Notifications section talk to Knock straight
// from the browser, with the public key and a user token the server signed.
// The layout loader puts a KnockClientConfig in its data for whoever is
// signed in, or null when nobody is or Knock isn't set up.

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

/** How Knock refused a call: the HTTP status, and the `code` in its body if it sent one. */
export type KnockRefusal = { status: number; code: string | undefined };

export type KnockConnection = {
  knock: Knock;
  knockId: string;
  /**
   * Runs a Knock call. If Knock won't take the token, gets a fresh one from
   * POST /api/knock-token, signs in with it and runs the call once more.
   * `refusalOf` reads how Knock refused the call from its result, if it did.
   */
  withFreshToken<T>(
    call: () => Promise<T>,
    refusalOf: (result: T) => KnockRefusal | undefined
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
    async withFreshToken(call, refusalOf) {
      const result = await call();
      if (!isRejectedToken(refusalOf(result)) || !(await refreshToken())) {
        return result;
      }
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

// Knock answers 401 to an expired token. #22 saw it answer 400
// invalid_user_token to one it couldn't verify, so an expired token may come
// back as a 400 too. Any other 400 is about the request, not the token.
function isRejectedToken(refusal: KnockRefusal | undefined): boolean {
  if (!refusal) return false;
  return (
    refusal.status === 401 ||
    (refusal.status === 400 && refusal.code === "invalid_user_token")
  );
}

const failedRequest = z.object({
  response: z.object({ status: z.number(), data: z.unknown() }),
});
const errorBody = z.object({ code: z.string() });

/** How Knock refused a @knocklabs/client call, from the error it hands back. */
export function knockRefusal(value: unknown): KnockRefusal | undefined {
  const parsed = failedRequest.safeParse(value);
  if (!parsed.success) return undefined;
  const body = errorBody.safeParse(parsed.data.response.data);
  return {
    status: parsed.data.response.status,
    code: body.success ? body.data.code : undefined,
  };
}
