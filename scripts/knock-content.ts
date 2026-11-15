import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { notificationWorkflows } from "../app/lib/notification-workflows";

// `npm run knock:generate` writes the parts of knock/ that come from somewhere
// else, so they can't drift. In each knock/workflows/<key>/workflow.json:
// - trigger_data_json_schema, from the workflow key's zod schema
// - each channel step's channel_key, from knock/channels.json
// Everything else in knock/ is written by hand. `npm run knock:push` runs this
// first, and a test fails when a generated part is out of date.

export type ZodWorkflows = Record<string, z.AnyZodObject>;

type GeneratedFile = { path: string; text: string };

/** What each generated file in knockDir should hold, without writing it. */
export function renderKnockContent(
  knockDir: string,
  workflows: ZodWorkflows = notificationWorkflows
): GeneratedFile[] {
  const channels = readChannels(knockDir);
  const workflowsDir = join(knockDir, "workflows");
  const unknown = existsSync(workflowsDir)
    ? readdirSync(workflowsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !(entry.name in workflows))
        .map((entry) => entry.name)
    : [];
  if (unknown.length > 0) {
    throw new Error(
      `knock/workflows has ${unknown.join(", ")}, which app/lib/notification-workflows.ts has no zod schema for. Each workflow directory is named after its workflow key.`
    );
  }
  return Object.entries(workflows).map(([key, schema]) => {
    const path = join(knockDir, "workflows", key, "workflow.json");
    return { path, text: renderWorkflow(path, schema, channels) };
  });
}

/** Brings every generated file in knockDir up to date. Returns the files it changed. */
export function writeKnockContent(
  knockDir: string,
  workflows: ZodWorkflows = notificationWorkflows
): string[] {
  const changed: string[] = [];
  for (const { path, text } of renderKnockContent(knockDir, workflows)) {
    if (readFileSync(path, "utf8") === text) continue;
    writeFileSync(path, text);
    changed.push(path);
  }
  return changed;
}

// ─── Channel keys ───
// knock/channels.json maps a Knock channel type to the key of the channel
// Cadence sends it through, e.g. { "in_app_feed": "in-app" }. A channel
// step's ref starts with its channel type (in_app_feed_1, email_1), which is
// how the generator knows which key it gets.

type Channels = Record<string, string>;

function readChannels(knockDir: string): Channels {
  const path = join(knockDir, "channels.json");
  return z.record(z.string().min(1)).parse(readJsonFile(path));
}

function renderWorkflow(
  path: string,
  schema: z.AnyZodObject,
  channels: Channels
): string {
  const workflow = readJsonFile(path);
  if (!isObject(workflow) || !Array.isArray(workflow.steps)) {
    throw new Error(`${path} needs a "steps" array.`);
  }
  const rendered = {
    ...workflow,
    steps: withChannelKeys(workflow.steps, channels, path),
    trigger_data_json_schema: triggerDataSchema(schema),
  };
  return `${JSON.stringify(rendered, null, 2)}\n`;
}

function withChannelKeys(
  steps: unknown[],
  channels: Channels,
  path: string
): unknown[] {
  return steps.map((step) => {
    if (!isObject(step)) return step;
    if (step.type === "branch" && Array.isArray(step.branches)) {
      const branches = step.branches.map((branch) =>
        isObject(branch) && Array.isArray(branch.steps)
          ? { ...branch, steps: withChannelKeys(branch.steps, channels, path) }
          : branch
      );
      return { ...step, branches };
    }
    if (step.type !== "channel") return step;
    const ref = typeof step.ref === "string" ? step.ref : "";
    const channelType = Object.keys(channels).find(
      (type) => ref === type || ref.startsWith(`${type}_`)
    );
    if (!channelType) {
      throw new Error(
        `${path}: name channel step "${ref}" after its channel type (${Object.keys(channels).join(" or ")}), e.g. ${Object.keys(channels)[0]}_1, so knock:generate can give it its key from knock/channels.json.`
      );
    }
    return { ...step, channel_key: channels[channelType] };
  });
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) throw new Error(`${path} is missing.`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Trigger data schemas ───
// Each Knock workflow's trigger_data_json_schema is generated from the
// workflow's zod schema in app/lib/notification-workflows.ts, so Cadence and
// Knock agree on every payload. A trigger that fails it gets a 4xx from Knock,
// and the outbox parks the row.

type JsonSchema = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | JsonValue[] | JsonSchema;

/**
 * The JSON Schema Knock checks a workflow's trigger data against.
 *
 * It leaves out `additionalProperties: false`, though the zod schemas are
 * strict. Production Knock gets the new schema on merge, before the new code
 * deploys, so it must still accept a key the old code sends.
 */
export function triggerDataSchema(schema: z.AnyZodObject): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    if (!(value instanceof z.ZodType)) continue;
    if (value instanceof z.ZodOptional) {
      properties[key] = valueSchema(key, value.unwrap());
    } else {
      properties[key] = valueSchema(key, value);
      required.push(key);
    }
  }
  return { type: "object", properties, required };
}

function valueSchema(key: string, value: z.ZodType): JsonSchema {
  if (value instanceof z.ZodString) return stringSchema(key, value);
  if (value instanceof z.ZodNumber) return numberSchema(key, value);
  if (value instanceof z.ZodBoolean) return { type: "boolean" };
  if (value instanceof z.ZodEnum) {
    return { type: "string", enum: [...value.options] };
  }
  if (value instanceof z.ZodLiteral) {
    const literal: unknown = value.value;
    if (typeof literal === "string") return { type: "string", enum: [literal] };
    if (typeof literal === "number") return { type: "number", enum: [literal] };
    if (typeof literal === "boolean") {
      return { type: "boolean", enum: [literal] };
    }
  }
  throw unsupported(key, value.constructor.name);
}

function numberSchema(key: string, value: z.ZodNumber): JsonSchema {
  const schema: JsonSchema = { type: "number" };
  for (const check of value._def.checks) {
    if (check.kind === "int") schema.type = "integer";
    else if (check.kind === "min" && check.inclusive) {
      schema.minimum = check.value;
    } else if (check.kind === "max" && check.inclusive) {
      schema.maximum = check.value;
    } else throw unsupported(key, `number ${check.kind} check`);
  }
  return schema;
}

function stringSchema(key: string, value: z.ZodString): JsonSchema {
  const schema: JsonSchema = { type: "string" };
  for (const check of value._def.checks) {
    if (check.kind === "min") schema.minLength = check.value;
    else if (check.kind === "max") schema.maxLength = check.value;
    else if (check.kind === "startsWith")
      schema.pattern = `^${escapeRegExp(check.value)}`;
    else throw unsupported(key, `string ${check.kind} check`);
  }
  return schema;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unsupported(key: string, what: string): Error {
  return new Error(
    `knock:generate can't write "${key}" (a zod ${what}) as JSON Schema. Teach triggerDataSchema in scripts/knock-content.ts about it.`
  );
}

// ─── npm run knock:generate ───

/** The repo's knock/ directory, which knock.json's knockDir points at. */
export const KNOCK_DIR = fileURLToPath(new URL("../knock", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changed = writeKnockContent(KNOCK_DIR);
  console.log(
    changed.length === 0
      ? "knock/ is up to date."
      : `Updated:\n${changed.map((path) => `  ${relative(process.cwd(), path)}`).join("\n")}`
  );
}
