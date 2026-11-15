import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { knockSync, knockValidate } from "./knock-ci";
import { KNOCK_DIR } from "./knock-content";

// The GitHub Actions run against a throwaway copy of the repo. Their two ways
// out are faked: the Knock CLI is a script, and fetch is a function. Both
// write one line per call to the same file, so a test sees every call in the
// order it happened. No test reaches Knock.

const FAKE_KNOCK = `#!/usr/bin/env bash
echo "knock $*" >> "$FAKE_LOG/calls"
if [[ -n "\${FAKE_FAIL:-}" && "$*" == "$FAKE_FAIL"* ]]; then exit 1; fi
exit 0
`;

const SHA = "3f2a9c1d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b";

let workdir: string;
let root: string;
let log: string;
let fakeKnock: string;
let knockResponses: Record<string, Response>;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "knock-ci-"));
  root = join(workdir, "repo");
  log = join(workdir, "log");
  mkdirSync(log);
  cpSync(KNOCK_DIR, join(root, "knock"), { recursive: true });
  writeFileSync(join(root, "knock.json"), '{ "knockDir": "knock" }\n');
  fakeKnock = join(workdir, "knock");
  writeFileSync(fakeKnock, FAKE_KNOCK);
  chmodSync(fakeKnock, 0o755);
  knockResponses = {};
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  appendFileSync(join(log, "calls"), `${init?.method} ${url}\n`);
  return knockResponses[url] ?? new Response("{}", { status: 200 });
};

function calls(): string[] {
  const path = join(log, "calls");
  return existsSync(path)
    ? readFileSync(path, "utf8").trimEnd().split("\n")
    : [];
}

const mainEnv = {
  KNOCK_SERVICE_TOKEN: "knock_st_fake",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: SHA,
};

function sync(env: NodeJS.ProcessEnv) {
  return knockSync({
    root,
    env: { PATH: process.env.PATH, FAKE_LOG: log, ...env },
    knockCli: [fakeKnock],
    fetch: fakeFetch,
    log: () => {},
  });
}

describe("the merge-to-main Action (knock-ci.ts sync)", () => {
  it("fails without KNOCK_SERVICE_TOKEN, saying how to set it, and reaches nothing", async () => {
    await expect(
      sync({ ...mainEnv, KNOCK_SERVICE_TOKEN: "" })
    ).rejects.toThrow(/KNOCK_SERVICE_TOKEN.*npm run knock:setup/);

    expect(calls()).toEqual([]);
  });

  it.each([
    ["a branch's Action", { GITHUB_REF: "refs/heads/ticket-99-wording" }],
    ["a laptop", { GITHUB_REF: undefined, GITHUB_SHA: undefined }],
  ])(
    "refuses to run from %s, because it changes Production, and reaches nothing",
    async (_where, overrides) => {
      await expect(sync({ ...mainEnv, ...overrides })).rejects.toThrow(
        /only on main.*npm run knock:push/
      );

      expect(calls()).toEqual([]);
    }
  );

  it("fills the category catalog, pushes variables and default preferences to both environments, then pushes and commits to Development, then promotes", async () => {
    // Only the worked example's workflow, so the categories expected below
    // don't change each time a workflow is added to knock/.
    const workflowsDir = join(root, "knock/workflows");
    for (const key of readdirSync(workflowsDir)) {
      if (key === "refund-request-raised") continue;
      rmSync(join(workflowsDir, key), { recursive: true });
    }
    writeFileSync(
      join(root, "knock/preferences/default.json"),
      JSON.stringify({
        preference_set: {
          categories: {
            "refund-request-raised": {
              channel_types: { in_app_feed: true, email: true },
            },
            refunds: { channel_types: { in_app_feed: true, email: true } },
          },
        },
      })
    );

    await sync(mainEnv);

    expect(calls()).toEqual([
      "PUT https://control.knock.app/v1/preference_categories/refund-request-raised",
      "PUT https://control.knock.app/v1/preference_categories/refunds",
      "knock variable push --force",
      "PUT https://control.knock.app/v1/environments/development/defaults",
      "PUT https://control.knock.app/v1/environments/production/defaults",
      `knock push --environment=development --commit --commit-message=Sync with git commit ${SHA}`,
      "knock commit promote --to=production --force",
    ]);
  });

  it("touches no workflow when Knock refuses Production's default preference set, so no workflow goes live ahead of its defaults", async () => {
    knockResponses[
      "https://control.knock.app/v1/environments/production/defaults"
    ] = new Response('{"message":"invalid preference_set"}', { status: 422 });

    await expect(sync(mainEnv)).rejects.toThrow(
      /production.*422.*invalid preference_set/
    );

    expect(calls().filter((call) => /^knock (push|commit)/.test(call))).toEqual(
      []
    );
  });

  it("never promotes when the push to Development fails, and says Production's workflows are unchanged", async () => {
    await expect(sync({ ...mainEnv, FAKE_FAIL: "push" })).rejects.toThrow(
      /knock push failed.*Nothing was promoted/
    );

    expect(calls().filter((call) => call.includes("promote"))).toEqual([]);
  });
});

describe("the pull request Action (knock-ci.ts validate)", () => {
  function validate(env: NodeJS.ProcessEnv) {
    const lines: string[] = [];
    const run = knockValidate({
      root,
      env: { PATH: process.env.PATH, FAKE_LOG: log, ...env },
      knockCli: [fakeKnock],
      log: (line) => lines.push(line),
    });
    return { run, lines };
  }

  it("passes with a notice saying why, when a fork's pull request has no KNOCK_SERVICE_TOKEN", async () => {
    const { run, lines } = validate({ KNOCK_SERVICE_TOKEN: "" });

    await expect(run).resolves.toBeUndefined();
    expect({ calls: calls(), lines }).toEqual({
      calls: [],
      lines: [
        expect.stringMatching(
          /^::notice title=Knock validation skipped::.*KNOCK_SERVICE_TOKEN.*fork/
        ),
      ],
    });
  });

  describe("with the secret", () => {
    const env = { KNOCK_SERVICE_TOKEN: "knock_st_fake" };

    it("has Knock validate every layout and workflow against Development, changing nothing", async () => {
      await validate(env).run;

      expect(calls()).toEqual([
        "knock layout validate --all --environment=development",
        "knock workflow validate --all --environment=development",
      ]);
    });

    it("fails the check when Knock finds an invalid layout, and still validates the workflows, so one run shows every problem", async () => {
      const { run } = validate({ ...env, FAKE_FAIL: "layout validate" });

      await expect(run).rejects.toThrow(/knock layout validate failed/);
      expect(calls()).toContain(
        "knock workflow validate --all --environment=development"
      );
    });
  });
});

describe("npx tsx scripts/knock-ci.ts, as the Actions run it", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));

  function run(...args: string[]) {
    return spawnSync(
      join(repo, "node_modules/.bin/tsx"),
      ["scripts/knock-ci.ts", ...args],
      {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env.PATH, KNOCK_SERVICE_TOKEN: "" },
      }
    );
  }

  it("passes a fork's pull request with the notice", () => {
    const result = run("validate");

    expect({ status: result.status, stdout: result.stdout }).toEqual({
      status: 0,
      stdout: expect.stringContaining("::notice title=Knock validation skipped::"),
    });
  });

  it("fails on a command it doesn't know, naming the two it does", () => {
    const result = run("promote");

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: expect.stringMatching(/validate.*sync/),
    });
  });
});
