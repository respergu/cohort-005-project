import { z } from "zod";
import { UserRole } from "~/db/schema";
import { knockRefusal, type KnockConnection } from "~/lib/knock-browser";
import defaultPreferenceSet from "../../knock/preferences/default.json";

// ─── Notification preferences ───
// The Notifications section on /settings: one row per Knock category, with a
// Notification Feed toggle and, where email is offered, an email toggle. Runs
// in the browser, so nothing here may import server code. See "Mutes and
// preferences" in PRD #37 and #27.

/** A Knock channel type a person can mute a row on. */
export type PreferenceChannel = "in_app_feed" | "email";

/** Who a row is for. Rows go by role, plus Team Admin membership. */
export type PreferencePerson = { role: UserRole; isTeamAdmin: boolean };

type Audience = (person: PreferencePerson) => boolean;

const platformAdmin: Audience = ({ role }) => role === UserRole.Admin;
const instructor: Audience = ({ role }) => role === UserRole.Instructor;
const student: Audience = ({ role }) => role === UserRole.Student;
const teamAdmin: Audience = ({ isTeamAdmin }) => isTeamAdmin;
const everyone: Audience = () => true;
// Anyone who can be a buyer: Students, and Team Admins whatever their role.
const buyer: Audience = (person) => student(person) || teamAdmin(person);

const channelChoices = z.object({
  in_app_feed: z.boolean(),
  email: z.boolean(),
});

// One entry per category a person can mute: every row but Refunds, which
// its workflows' override_preferences lock.
const choicesSchema = z.object({
  "refund-request-raised": channelChoices,
  "refund-request-approved": channelChoices,
  "seat-claims": channelChoices,
  "new-enrollment": channelChoices,
  "new-question": channelChoices,
  reply: channelChoices,
  "new-lesson": channelChoices,
});

/** Whether a row is on, per channel. */
export type ChannelChoices = z.infer<typeof channelChoices>;

/** What a person gets, row by row. */
export type PreferenceChoices = z.infer<typeof choicesSchema>;

/** A category a person can mute. */
export type MutableCategory = keyof PreferenceChoices;

/**
 * Cadence's defaults: the default preference set that `npm run knock:push`
 * and CI send to Knock, read from that same file so the two can't drift.
 * Parsing it here fails loudly if it ever lacks a row or a channel.
 */
export const CADENCE_DEFAULTS: PreferenceChoices = choicesFromEntries(
  Object.entries(
    z
      .object({
        preference_set: z.object({
          categories: z.record(
            z.string(),
            z.object({ channel_types: z.record(z.string(), z.boolean()) })
          ),
        }),
      })
      .parse(defaultPreferenceSet).preference_set.categories
  ).map(([category, { channel_types }]) => [category, channel_types])
);

// Keeps only the mutable categories, and checks each has both channels.
function choicesFromEntries(
  entries: Array<[string, unknown]>
): PreferenceChoices {
  return choicesSchema.parse(Object.fromEntries(entries));
}

export type MutableRow = {
  locked: false;
  category: MutableCategory;
  label: string;
  /** When it's sent. */
  description: string;
  /** The toggles it shows: always the Feed, then email where it's offered. */
  channels: PreferenceChannel[];
  /** A word on what the email toggle covers, if it isn't the whole row. */
  emailNote?: string;
};

export type LockedRow = {
  locked: true;
  category: "refunds";
  label: string;
  description: string;
  /** Shown in place of toggles. */
  readOnly: string;
};

export type PreferenceRow = MutableRow | LockedRow;

const FEED_AND_EMAIL: PreferenceChannel[] = ["in_app_feed", "email"];

// In the order /settings shows them. Each category key matches
// knock/preferences/default.json and the workflows' `categories`.
const ROWS: ReadonlyArray<{ audience: Audience; row: PreferenceRow }> = [
  {
    audience: platformAdmin,
    row: {
      locked: false,
      category: "refund-request-raised",
      label: "Refund Request raised",
      description: "A buyer raises a Refund Request.",
      channels: FEED_AND_EMAIL,
    },
  },
  {
    audience: instructor,
    row: {
      locked: false,
      category: "refund-request-approved",
      label: "Refund Request approved",
      description: "A Refund Request on one of your courses is approved.",
      channels: FEED_AND_EMAIL,
    },
  },
  {
    audience: teamAdmin,
    row: {
      locked: false,
      category: "seat-claims",
      label: "Seat claims",
      description: "Someone claims a Seat on your Team Licence.",
      channels: FEED_AND_EMAIL,
      emailNote: "Email only when the last Seat is claimed.",
    },
  },
  {
    audience: instructor,
    row: {
      locked: false,
      category: "new-enrollment",
      label: "New Enrollment",
      description: "A Student enrolls on one of your courses.",
      channels: FEED_AND_EMAIL,
    },
  },
  {
    audience: instructor,
    row: {
      locked: false,
      category: "new-question",
      label: "New Question",
      description: "Someone asks a Question on one of your courses.",
      channels: FEED_AND_EMAIL,
    },
  },
  {
    audience: everyone,
    row: {
      locked: false,
      category: "reply",
      label: "Reply",
      description: "Someone replies to a Comment you posted.",
      channels: FEED_AND_EMAIL,
    },
  },
  {
    audience: student,
    row: {
      locked: false,
      category: "new-lesson",
      label: "New lesson",
      description: "A course you're enrolled on gets a new lesson.",
      channels: ["in_app_feed"],
    },
  },
  {
    audience: buyer,
    row: {
      locked: true,
      category: "refunds",
      label: "Refunds",
      description: "A decision on your Refund Request.",
      readOnly: "Refunds: always sent by Feed and email",
    },
  },
];

/**
 * The rows a person sees, for all of their roles at once. They have one
 * preference set, so a row shows once however many roles it's for.
 */
export function preferenceRowsFor(person: PreferencePerson): PreferenceRow[] {
  return ROWS.filter(({ audience }) => audience(person)).map(({ row }) => row);
}

export type PreferencesResult =
  { status: "ready"; choices: PreferenceChoices } | { status: "error" };

export type NotificationPreferences = {
  /** Reads the person's preferences from Knock, over Cadence's defaults. */
  load(): Promise<PreferencesResult>;
  /**
   * Saves one row, both channels, and nothing else. The first save for a
   * user Knock has never seen creates them in Knock.
   */
  save(category: MutableCategory, choice: ChannelChoices): Promise<SaveResult>;
};

export type SaveResult = "saved" | "error";

/**
 * Reads and saves the signed-in person's preferences straight from the
 * browser, with the public key and the bell's token. It uses the SDK's
 * low-level client: `user.getPreferences()` throws away the body of a 404,
 * so "nothing saved yet" can't be told from any other 404.
 */
export function createNotificationPreferences(
  connection: KnockConnection
): NotificationPreferences {
  const url = `/v1/users/${encodeURIComponent(connection.knockId)}/preferences/default`;

  // The client is looked up on every call: signing in with a fresh token
  // replaces it.
  const request = (req: { method: "GET" | "PUT"; data?: unknown }) =>
    connection.withFreshToken(
      () => connection.knock.client().makeRequest({ ...req, url }),
      (response) => knockRefusal(response.error)
    );

  return {
    async load() {
      return choicesFrom(await request({ method: "GET" }));
    },
    async save(category, choice) {
      const response = await request({
        method: "PUT",
        data: {
          // Without this, Knock replaces the whole set with what's sent.
          __persistence_strategy__: "merge",
          // Both channels, so a merge that replaces a category whole still
          // keeps the row's other channel.
          categories: { [category]: { channel_types: choice } },
        },
      });
      return response.statusCode === "ok" ? "saved" : "error";
    },
  };
}

/** What the SDK's `makeRequest` resolves to. It never throws. */
type KnockResponse = {
  statusCode: "ok" | "error";
  status: number;
  body?: unknown;
  error?: unknown;
};

const knockError = z.object({ code: z.string() });

const savedSet = z.object({
  categories: z.record(z.string(), z.unknown()).nullish(),
});

const savedChannels = z.object({
  channel_types: z
    .object({
      in_app_feed: z.boolean().nullish(),
      email: z.boolean().nullish(),
    })
    .nullish(),
});

// Knock's answer to a read, as choices. A user Knock has never seen gets
// 404 resource_missing, which means nothing saved yet (#35). Any other 404,
// such as an unrouted path, is an error.
function choicesFrom(response: KnockResponse): PreferencesResult {
  if (response.statusCode === "ok") {
    const set = savedSet.safeParse(response.body);
    if (!set.success) return { status: "error" };
    const saved = set.data.categories ?? {};
    return {
      status: "ready",
      choices: choicesFromEntries(
        Object.entries(CADENCE_DEFAULTS).map(([category, fallback]) => [
          category,
          savedChoice(saved[category], fallback),
        ])
      ),
    };
  }
  const error = knockError.safeParse(response.body);
  if (
    response.status === 404 &&
    error.success &&
    error.data.code === "resource_missing"
  ) {
    return { status: "ready", choices: CADENCE_DEFAULTS };
  }
  return { status: "error" };
}

// A category Knock holds can be true or false for every channel, or set
// channel by channel. Anything it doesn't set, including a null that a user
// with nothing saved gets back, falls back to Cadence's default.
function savedChoice(saved: unknown, fallback: ChannelChoices): ChannelChoices {
  if (typeof saved === "boolean") return { in_app_feed: saved, email: saved };
  const parsed = savedChannels.safeParse(saved);
  const channels = (parsed.success && parsed.data.channel_types) || {};
  return {
    in_app_feed: channels.in_app_feed ?? fallback.in_app_feed,
    email: channels.email ?? fallback.email,
  };
}
