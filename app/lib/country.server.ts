import { getSession } from "~/lib/session";

// ─── Country Resolution ───
// Layered approach: (1) dev session override, (2) CF-IPCountry header.
// Returns a 2-letter ISO country code or null. Null prices at full price
// (Tier 1): a page never waits on a network call to learn the country.

/**
 * The country picked in the DevUI panel, as a 2-letter ISO code, or null. The
 * only reader of the session's dev override, so the panel and pricing agree.
 */
export async function getDevCountry(request: Request): Promise<string | null> {
  const session = await getSession(request);
  const devCountry = session.get("devCountry");
  if (typeof devCountry === "string" && devCountry.length === 2) {
    return devCountry.toUpperCase();
  }
  return null;
}

export async function resolveCountry(request: Request): Promise<string | null> {
  // 1. Dev session override
  const devCountry = await getDevCountry(request);
  if (devCountry) return devCountry;

  // 2. Cloudflare CF-IPCountry header
  const cfCountry = request.headers.get("CF-IPCountry");
  if (cfCountry && cfCountry.length === 2 && cfCountry !== "XX") {
    return cfCountry.toUpperCase();
  }

  return null;
}
