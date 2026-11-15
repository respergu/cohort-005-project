import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { writeKnockContent } from "./knock-content";

// `npm run knock:push` loads this branch's knock/ into Knock Development, so a
// developer can trigger it with KNOCK_TRIGGERS=on before merging. It only ever
// targets Development, and never passes --force.

/** The Knock CLI, pinned. Run through npx so its ~800 packages stay out of npm install. */
export const KNOCK_CLI = ["npx", "--yes", "@knocklabs/cli@1.6.2"];

export type KnockPushOptions = {
  /** The repo root, holding knock.json and knock/. */
  root: string;
  /** Where KNOCK_SERVICE_TOKEN comes from. */
  env: NodeJS.ProcessEnv;
  /** The command that runs the Knock CLI. */
  knockCli?: string[];
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

export async function knockPush({
  root,
  env,
  knockCli = KNOCK_CLI,
  fetch = globalThis.fetch,
  log = console.log,
}: KnockPushOptions): Promise<void> {
  const token = env.KNOCK_SERVICE_TOKEN;
  if (!token) {
    throw new Error(
      "knock:push needs KNOCK_SERVICE_TOKEN in .env. npm run knock:setup (Development) walks you through creating one."
    );
  }

  for (const path of writeKnockContent(join(root, "knock"))) {
    log(`Regenerated ${relative(root, path)}`);
  }

  await upsertPreferenceCategories({ root, token, fetch, log });

  const [command = "", ...cliArgs] = knockCli;
  const cli = spawnSync(
    command,
    [
      ...cliArgs,
      "push",
      "--environment=development",
      "--commit",
      `--commit-message=${commitMessage(root)}`,
    ],
    { cwd: root, env, stdio: "inherit" }
  );
  if (cli.status !== 0) {
    throw new Error(
      `knock push failed (${cli.error?.message ?? `exit ${cli.status}`}). It may have pushed some resources before it stopped; the default preference set wasn't pushed.`
    );
  }

  // The CLI has no command for an environment's default preference set.
  const response = await fetch(DEFAULTS_URL, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: readFileSync(join(root, "knock/preferences/default.json"), "utf8"),
  });
  if (!response.ok) {
    throw new Error(
      `Knock refused the default preference set: ${response.status} ${await response.text()}`
    );
  }
  log("Pushed the default preference set to Development.");

  await setDevelopmentVariables({ root, token, fetch, log });
}

const VARIABLES_URL = "https://control.knock.app/v1/variables";

/**
 * Sets Development's value of each variable in knock/variables.json, and
 * nothing else. Knock's upsert leaves every attribute and environment a
 * request leaves out unchanged, so Production's value and the default (which
 * Production falls back on) are never touched from a branch. Only the
 * merge-to-main job pushes the whole of knock/variables.json.
 */
async function setDevelopmentVariables({
  root,
  token,
  fetch,
  log,
}: {
  root: string;
  token: string;
  fetch: typeof globalThis.fetch;
  log: (line: string) => void;
}): Promise<void> {
  const variables = z
    .record(
      z.object({
        environment_values: z.object({ development: z.string().min(1) }),
      })
    )
    .parse(readJson(join(root, "knock/variables.json")));
  for (const [key, variable] of Object.entries(variables)) {
    const development = variable.environment_values.development;
    const response = await fetch(
      `${VARIABLES_URL}/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ environment_values: { development } }),
      }
    );
    if (!response.ok) {
      throw new Error(
        `Knock refused Development's value of variable ${key}: ${response.status} ${await response.text()}. A variable that doesn't exist yet is created by the merge-to-main job's variable push.`
      );
    }
    log(`Set Development's ${key} to ${development}.`);
  }
}

/** Development's default preference set, in Knock's Management API. */
const DEFAULTS_URL =
  "https://control.knock.app/v1/environments/development/defaults";

const CATEGORIES_URL = "https://control.knock.app/v1/preference_categories";

/**
 * Adds every category knock/ names to Knock's preference category catalog.
 * Knock refuses a workflow, or a default preference set, whose category isn't
 * in the catalog, and the CLI has no command for it.
 *
 * The catalog belongs to the Knock project, not to an environment, so this
 * also reaches Production's. That's allowed from a branch: adding a name
 * changes no workflow and no preference, and an upsert of a name that's
 * already there changes nothing. It never deletes; archive a category by hand.
 */
export async function upsertPreferenceCategories({
  root,
  token,
  fetch,
  log,
}: {
  root: string;
  token: string;
  fetch: typeof globalThis.fetch;
  log: (line: string) => void;
}): Promise<void> {
  const names = preferenceCategories(root);
  for (const name of names) {
    const response = await fetch(
      `${CATEGORIES_URL}/${encodeURIComponent(name)}`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      throw new Error(
        `Knock refused preference category "${name}": ${response.status} ${await response.text()}. Nothing was pushed.`
      );
    }
  }
  log(`Preference categories in Knock's catalog: ${names.join(", ")}.`);
}

/** Every category knock/ names: the default preference set's and each workflow's. */
export function preferenceCategories(root: string): string[] {
  const knockDir = join(root, "knock");
  const defaults = z
    .object({
      preference_set: z.object({ categories: z.record(z.unknown()) }),
    })
    .parse(readJson(join(knockDir, "preferences/default.json")));
  const names = new Set(Object.keys(defaults.preference_set.categories));
  const workflowsDir = join(knockDir, "workflows");
  for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const workflow = z
      .object({ categories: z.array(z.string()).optional() })
      .parse(readJson(join(workflowsDir, entry.name, "workflow.json")));
    for (const name of workflow.categories ?? []) names.add(name);
  }
  return [...names].sort();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Names what was pushed: Knock's commit log then points back at git. */
function commitMessage(root: string): string {
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  const sha = git(root, "rev-parse", "--short", "HEAD");
  const uncommitted = git(
    root,
    "status",
    "--porcelain",
    "--",
    "knock",
    "knock.json"
  );
  return `knock:push from ${branch} at ${sha}${uncommitted ? ", plus uncommitted changes to knock/" : ""}`;
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// ─── npm run knock:push ───

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  knockPush({
    root: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
