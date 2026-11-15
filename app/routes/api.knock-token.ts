import type { Route } from "./+types/api.knock-token";
import { db } from "~/db";
import { refreshKnockUserToken } from "~/lib/knock-user-token.server";

// POST /api/knock-token: a fresh Knock user token for whoever is in the
// session now. The bell calls it before its token expires and after a 401.
export function action({ request }: Route.ActionArgs) {
  return refreshKnockUserToken(request, db, process.env);
}
