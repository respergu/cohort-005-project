import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  KNOCK_DIR,
  renderKnockContent,
  triggerDataSchema,
  writeKnockContent,
} from "./knock-content";

describe("knock/", () => {
  it("holds every generated part as knock:generate writes it", () => {
    for (const { path, text } of renderKnockContent(KNOCK_DIR)) {
      expect(
        readFileSync(path, "utf8"),
        `${path} is out of date. Run npm run knock:generate.`
      ).toBe(text);
    }
  });

  // Knock doesn't escape Liquid output, so a buyer's name or reason would
  // otherwise reach an email or the bell as raw HTML. Plain-text files (.txt,
  // such as the layout's Text tab) are left out: text can't run markup, and
  // escape would print an apostrophe as &#39;.
  it("sends every text variable in every template through | escape", () => {
    const unescaped = templateFiles().flatMap(({ file, text }) =>
      liquidOutputs(text)
        .filter(
          ({ variable, filters }) =>
            !filters.includes("escape") && !TRUSTED_OUTPUTS.has(variable)
        )
        .map(({ output }) => `${file}: ${output}`)
    );

    expect(unescaped).toEqual([]);
  });

  describe("the default preference set", () => {
    const defaults = z
      .object({
        preference_set: z.object({
          categories: z.record(
            z.object({ channel_types: z.record(z.boolean()) })
          ),
        }),
      })
      .parse(
        JSON.parse(
          readFileSync(join(KNOCK_DIR, "preferences/default.json"), "utf8")
        )
      ).preference_set.categories;

    it("covers every category a workflow uses", () => {
      const uncovered = workflowCategories().filter(
        (category) => !(category in defaults)
      );

      expect(uncovered).toEqual([]);
    });

    it("sets the feed and email for every category, because Knock treats an unset channel as on", () => {
      const notExplicit = Object.entries(defaults)
        .filter(
          ([, { channel_types }]) =>
            Object.keys(channel_types).sort().join() !== "email,in_app_feed"
        )
        .map(([category]) => category);

      expect(notExplicit).toEqual([]);
    });

    it("leaves email off for the opt-in rows: Refund Request approved and New Enrollment", () => {
      expect({
        "refund-request-approved":
          defaults["refund-request-approved"]?.channel_types.email,
        "new-enrollment": defaults["new-enrollment"]?.channel_types.email,
      }).toEqual({ "refund-request-approved": false, "new-enrollment": false });
    });
  });
});

/** Outputs that are never user text: the layout's slot, our own origin, and counts. */
const TRUSTED_OUTPUTS = new Set([
  "content",
  "vars.app_url",
  "total_activities",
  "total_actors",
]);

/** Every Liquid template in knock/: HTML and Markdown files, and the strings in each resource's JSON. */
function templateFiles(): { file: string; text: string }[] {
  return listFiles(KNOCK_DIR)
    .filter((path) => /\/(workflows|layouts|partials)\//.test(path))
    .flatMap((path) => {
      const file = relative(KNOCK_DIR, path);
      const text = readFileSync(path, "utf8");
      if (extname(path) === ".json")
        return jsonStrings(JSON.parse(text)).map((s) => ({ file, text: s }));
      if (extname(path) === ".txt") return [];
      return [{ file, text }];
    });
}

function liquidOutputs(text: string) {
  return [...text.matchAll(/\{\{-?(.*?)-?\}\}/gs)].map(
    ([output, expression = ""]) => {
      const [variable = "", ...filters] = expression
        .split("|")
        .map((part) => part.trim());
      return {
        output,
        variable,
        filters: filters.map((filter) => filter.split(":")[0]?.trim()),
      };
    }
  );
}

function workflowCategories(): string[] {
  const workflow = z.object({ categories: z.array(z.string()).default([]) });
  return readdirSync(join(KNOCK_DIR, "workflows")).flatMap(
    (key) =>
      workflow.parse(
        JSON.parse(
          readFileSync(
            join(KNOCK_DIR, "workflows", key, "workflow.json"),
            "utf8"
          )
        )
      ).categories
  );
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function jsonStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(jsonStrings);
  return [];
}

let knockDir: string;

beforeEach(() => {
  knockDir = mkdtempSync(join(tmpdir(), "knock-content-"));
});

afterEach(() => {
  rmSync(knockDir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown) {
  const file = join(knockDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(knockDir, path), "utf8"));
}

const workflows = {
  "lesson-liked": z.object({ course_title: z.string().min(1) }).strict(),
};

describe("writeKnockContent", () => {
  beforeEach(() => {
    writeJson("channels.json", { in_app_feed: "feed-key", email: "mail-key" });
  });

  it("writes the zod schema and the channel keys into the workflow, keeping what was written by hand", () => {
    writeJson("workflows/lesson-liked/workflow.json", {
      name: "Lesson liked",
      categories: ["lesson-liked"],
      steps: [
        {
          ref: "in_app_feed_1",
          type: "channel",
          channel_key: "old",
          template: { markdown_body: "Liked" },
        },
        {
          ref: "email_1",
          type: "channel",
          channel_key: "old",
          template: { subject: "Liked" },
        },
      ],
    });

    writeKnockContent(knockDir, workflows);

    expect(readJson("workflows/lesson-liked/workflow.json")).toEqual({
      name: "Lesson liked",
      categories: ["lesson-liked"],
      steps: [
        {
          ref: "in_app_feed_1",
          type: "channel",
          channel_key: "feed-key",
          template: { markdown_body: "Liked" },
        },
        {
          ref: "email_1",
          type: "channel",
          channel_key: "mail-key",
          template: { subject: "Liked" },
        },
      ],
      trigger_data_json_schema: {
        type: "object",
        properties: { course_title: { type: "string", minLength: 1 } },
        required: ["course_title"],
      },
    });
  });

  it("leaves a workflow.json in the form the Knock CLI writes back, when its generated parts are already up to date", () => {
    // After a push, the CLI rewrites workflow.json in its own key order and
    // adds read-only fields. Rewriting it again would dirty the tree on every push.
    const asTheCliWritesIt =
      JSON.stringify(
        {
          name: "Lesson liked",
          steps: [
            {
              type: "channel",
              template: { markdown_body: "Liked" },
              ref: "in_app_feed_1",
              channel_type: "in_app_feed",
              channel_key: "feed-key",
            },
          ],
          categories: ["lesson-liked"],
          trigger_data_json_schema: {
            properties: { course_title: { minLength: 1, type: "string" } },
            required: ["course_title"],
            type: "object",
          },
          __readonly: { key: "lesson-liked", active: true, valid: true },
          $schema: "https://schemas.knock.app/cli/workflow.json",
        },
        null,
        2
      ) + "\n";
    const path = join(knockDir, "workflows/lesson-liked/workflow.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, asTheCliWritesIt);

    expect(writeKnockContent(knockDir, workflows)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(asTheCliWritesIt);
  });

  it("refuses a workflow in knock/ that has no zod schema, so a misspelt key can't slip through", () => {
    writeJson("workflows/lesson-liked/workflow.json", {
      name: "Lesson liked",
      steps: [],
    });
    writeJson("workflows/lesson-likd/workflow.json", {
      name: "Typo",
      steps: [],
    });

    expect(() => writeKnockContent(knockDir, workflows)).toThrow(/lesson-likd/);
  });

  it("gives channel steps inside a Branch step their keys too", () => {
    writeJson("workflows/lesson-liked/workflow.json", {
      name: "Lesson liked",
      steps: [
        {
          ref: "branch_1",
          type: "branch",
          branches: [
            {
              name: "Default",
              conditions: null,
              steps: [
                { ref: "in_app_feed_2", type: "channel", channel_key: "old" },
              ],
            },
          ],
        },
      ],
    });

    writeKnockContent(knockDir, workflows);

    expect(readJson("workflows/lesson-liked/workflow.json")).toMatchObject({
      steps: [
        {
          branches: [
            { steps: [{ ref: "in_app_feed_2", channel_key: "feed-key" }] },
          ],
        },
      ],
    });
  });
});

describe("triggerDataSchema", () => {
  it("lists every key, requires the ones that aren't optional, and keeps string checks", () => {
    const schema = z
      .object({
        course_title: z.string().min(1),
        path: z.string().startsWith("/"),
      })
      .strict();

    expect(triggerDataSchema(schema)).toEqual({
      type: "object",
      properties: {
        course_title: { type: "string", minLength: 1 },
        path: { type: "string", pattern: "^/" },
      },
      required: ["course_title", "path"],
    });
  });

  it("lists an optional key without requiring it", () => {
    const schema = z.object({
      course_title: z.string(),
      note: z.string().max(500).optional(),
    });

    expect(triggerDataSchema(schema)).toEqual({
      type: "object",
      properties: {
        course_title: { type: "string" },
        note: { type: "string", maxLength: 500 },
      },
      required: ["course_title"],
    });
  });

  it("writes enums, literals, booleans and numbers", () => {
    const schema = z.object({
      decision: z.enum(["approved", "declined"]),
      last_seat: z.literal(true).optional(),
      keeps_enrollment: z.boolean(),
      seats_left: z.number().int().min(0),
      amount: z.number().max(10_000),
    });

    expect(triggerDataSchema(schema)).toEqual({
      type: "object",
      properties: {
        decision: { type: "string", enum: ["approved", "declined"] },
        last_seat: { type: "boolean", enum: [true] },
        keeps_enrollment: { type: "boolean" },
        seats_left: { type: "integer", minimum: 0 },
        amount: { type: "number", maximum: 10_000 },
      },
      required: ["decision", "keeps_enrollment", "seats_left", "amount"],
    });
  });

  it("refuses a zod type it can't write, naming the key", () => {
    const schema = z.object({ email: z.string().email() });

    expect(() => triggerDataSchema(schema)).toThrow(/"email"/);
  });
});
