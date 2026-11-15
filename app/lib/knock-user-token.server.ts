import { signUserToken } from "@knocklabs/node";
import { data } from "react-router";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import type { Db } from "~/db/types";
import type { KnockClientConfig } from "~/lib/knock-browser";
import { requireUserId } from "~/lib/access.server";

// ─── Knock user tokens ───
// The browser reads the Notification Feed (and saves preferences) straight
// from Knock, so it needs a token proving which Knock user it is. The server
// signs one for the session user with KNOCK_SIGNING_KEY. See "Users and
// tokens" in PRD #37 and ADR 0015.

/** How long a user token lasts. The bell asks for a fresh one before then. */
export const KNOCK_USER_TOKEN_TTL_SECONDS = 60 * 60;

/** The environment, or a test's stand-in for it. */
export type KnockEnv = Readonly<Record<string, string | undefined>>;

/**
 * The Knock config for one user's browser, or null when Knock isn't set up.
 * A signing key that can't be read is logged and also gives null: the bell
 * is missing, but every page still loads.
 */
export async function knockClientConfig(
  knockId: string,
  env: KnockEnv,
  log: Pick<Console, "error"> = console
): Promise<KnockClientConfig | null> {
  const publicApiKey = env.KNOCK_PUBLIC_API_KEY;
  const signingKey = env.KNOCK_SIGNING_KEY;
  const feedChannelId = env.KNOCK_FEED_CHANNEL_ID;
  if (!publicApiKey || !signingKey || !feedChannelId) return null;

  try {
    const userToken = await signUserToken(knockId, {
      signingKey,
      expiresInSeconds: KNOCK_USER_TOKEN_TTL_SECONDS,
    });
    return { publicApiKey, knockId, userToken, feedChannelId };
  } catch (error) {
    log.error(
      "Couldn't sign a Knock user token with KNOCK_SIGNING_KEY (it must be a Base-64 PKCS#8 PEM), so there's no bell:",
      error
    );
    return null;
  }
}

/**
 * POST /api/knock-token: a fresh token for whoever is in the session now.
 * The bell calls it shortly before its token expires and after Knock answers
 * 401. The body carries the Knock id too, so a tab whose session user changed
 * underneath it can tell the token isn't for the feed it's showing.
 */
export async function refreshKnockUserToken(
  request: Request,
  db: Db,
  env: KnockEnv
): Promise<Response> {
  const userId = await requireUserId(request);
  const user = db
    .select({ knockId: schema.users.knockId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  if (!user) throw data("Select a user from the DevUI panel.", { status: 401 });

  const config = await knockClientConfig(user.knockId, env);
  if (!config) throw data("Notifications aren't set up.", { status: 404 });

  return Response.json(
    { knockId: config.knockId, userToken: config.userToken },
    { headers: { "Cache-Control": "no-store" } }
  );
}
