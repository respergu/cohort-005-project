// PROTOTYPE, throwaway (respergu/cohort-005-project#24). Never merge to main.
// "Send me one": triggers a random catalogue Notification to the DevUI user
// through the real Knock workflow, so arrival behaviour can be judged.
import { data } from "react-router";
import type { Route } from "./+types/api.notification-feed-prototype";
import { getCurrentUserId } from "~/lib/session";
import { getSqlite } from "~/db";
import {
  prototypeNotificationsFor,
  triggerPrototypeNotification,
} from "~/lib/notification-feed.prototype.server";

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) {
    return data(
      { ok: false, error: "Select a user from the DevUI panel" },
      { status: 401 }
    );
  }
  const sqlite = getSqlite();
  const user = sqlite
    .prepare("select id, name from users where id = ?")
    .get(userId) as { id: number; name: string };
  const pool = prototypeNotificationsFor(sqlite, userId);
  if (pool.length === 0) {
    return data({
      ok: false,
      error: "No catalogue Notifications fit this user",
    });
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  try {
    await triggerPrototypeNotification(user, pick);
    return data({ ok: true, kind: pick.data.kind });
  } catch (e) {
    return data({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
