import { fileURLToPath } from "node:url";
import {
  KNOCK_CLI,
  pushDefaultPreferences,
  runKnockCli,
  upsertPreferenceCategories,
} from "./knock-push";

// The GitHub Actions in .github/workflows/knock-*.yml run this, and nothing
// else should: `sync` changes Production. A developer uses npm run knock:push,
// which only ever targets Development.

export type KnockCiOptions = {
  /** The repo root, holding knock.json and knock/. */
  root: string;
  /** The Action's environment: KNOCK_SERVICE_TOKEN, GITHUB_REF, GITHUB_SHA. */
  env: NodeJS.ProcessEnv;
  /** The command that runs the Knock CLI. */
  knockCli?: string[];
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

/**
 * On a pull request, asks Knock whether knock/'s layouts and workflows are
 * valid. Knock checks them server-side, so this needs the token. A pull
 * request from a fork doesn't get repo secrets, so it passes with a notice.
 */
export async function knockValidate({
  root,
  env,
  knockCli = KNOCK_CLI,
  log = console.log,
}: Omit<KnockCiOptions, "fetch">): Promise<void> {
  if (!env.KNOCK_SERVICE_TOKEN) {
    log(
      "::notice title=Knock validation skipped::This run has no KNOCK_SERVICE_TOKEN: GitHub doesn't give repo secrets to a pull request from a fork. The offline checks still ran, and the sync on merge to main validates every workflow again before it pushes."
    );
    return;
  }
  // The CLI finds knock/ through knock.json. Validation persists nothing.
  // Both run even when the first fails, so one run shows every problem.
  const failures: string[] = [];
  for (const resource of ["layout", "workflow"]) {
    try {
      runKnockCli({ root, env, knockCli }, [
        resource,
        "validate",
        "--all",
        "--environment=development",
      ]);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.join("\n")}\nKnock's reasons are in the output above.`
    );
  }
}

/**
 * On a merge to main, makes Knock match main: Development gets main's content
 * as a commit, and the promote makes Production match it. The promote is the
 * only step that changes Production's workflows.
 */
export async function knockSync({
  root,
  env,
  knockCli = KNOCK_CLI,
  fetch = globalThis.fetch,
  log = console.log,
}: KnockCiOptions): Promise<void> {
  const sha = env.GITHUB_SHA;
  if (env.GITHUB_REF !== "refs/heads/main" || !sha) {
    throw new Error(
      "knock-ci.ts sync changes Production, so it runs only on main, from the Knock sync Action. To try a branch's knock/ in Development, use npm run knock:push."
    );
  }
  const token = env.KNOCK_SERVICE_TOKEN;
  if (!token) {
    throw new Error(
      "The KNOCK_SERVICE_TOKEN repo secret isn't set, so Knock wasn't touched and Production Knock doesn't match main yet. npm run knock:setup (Production) sets it; then re-run this job."
    );
  }
  const cli = { root, env, knockCli };

  // 1. Settings that go live at once, so a new opt-in category is already off
  //    by default before its workflow reaches Production. The category catalog
  //    is the project's, shared by both environments, so it's filled once.
  await upsertPreferenceCategories({ root, token, fetch, log });
  // A variable push writes every environment's values and takes no
  // --environment. --force only skips its confirmation prompt.
  runKnockCli(cli, ["variable", "push", "--force"]);
  for (const environment of ["development", "production"] as const) {
    await pushDefaultPreferences({ root, environment, token, fetch, log });
  }

  // 2. Main's content into Development, committed.
  runKnockCli(
    cli,
    [
      "push",
      "--environment=development",
      "--commit",
      `--commit-message=Sync with git commit ${sha}`,
    ],
    "It may have pushed and committed some resources to Development before it stopped. Nothing was promoted, so Production's workflows are unchanged. Re-run this job, or merge a fix to main if knock/ is at fault."
  );

  // 3. Production takes every committed Development change. --force only
  //    skips the confirmation prompt, which would stop a CI run.
  runKnockCli(
    cli,
    ["commit", "promote", "--to=production", "--force"],
    "Development holds main's commits. Re-run this job to promote them."
  );
}

// ─── npx tsx scripts/knock-ci.ts validate|sync ───

const COMMANDS = new Map<string, (options: KnockCiOptions) => Promise<void>>([
  ["validate", knockValidate],
  ["sync", knockSync],
]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2] ?? "";
  const run =
    COMMANDS.get(name) ??
    (() =>
      Promise.reject(
        new Error(
          `Usage: tsx scripts/knock-ci.ts validate|sync (got "${name}"). validate checks a pull request's knock/; sync makes Knock match main.`
        )
      ));
  run({
    root: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
