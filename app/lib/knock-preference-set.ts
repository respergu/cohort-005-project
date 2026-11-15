import { z } from "zod";

// The shape of knock/preferences/default.json, which is already the body Knock
// takes for an environment's default preference set. Imports only zod, so the
// tsx scripts can import it as well as the app.

export const defaultPreferenceSetSchema = z.object({
  preference_set: z.object({
    categories: z.record(
      z.string(),
      z.object({ channel_types: z.record(z.string(), z.boolean()) })
    ),
  }),
});
