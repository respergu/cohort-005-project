import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
  log(
    "knock/variables.json isn't pushed from a branch: a variable push writes every environment's values, so only the merge-to-main job does it."
  );
}

/** Development's default preference set, in Knock's Management API. */
const DEFAULTS_URL =
  "https://control.knock.app/v1/environments/development/defaults";

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
