import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOCK_DIR } from "./knock-content";
import { knockPush } from "./knock-push";

// knockPush runs against a throwaway copy of the repo. Its two ways out are
// faked: the Knock CLI is a script that records what it was given, and fetch
// records each request. No test reaches Knock.

const FAKE_KNOCK = `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_LOG/args"
printf '%s' "$KNOCK_SERVICE_TOKEN" > "$FAKE_LOG/token"
cp knock/workflows/refund-request-raised/workflow.json "$FAKE_LOG/workflow.json"
exit "\${FAKE_EXIT:-0}"
`;

let workdir: string;
let root: string;
let log: string;
let fakeKnock: string;
let requests: { url: string; init: RequestInit | undefined }[];
let knockResponse: Response;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "knock-push-"));
  root = join(workdir, "repo");
  log = join(workdir, "log");
  mkdirSync(log);
  cpSync(KNOCK_DIR, join(root, "knock"), { recursive: true });
  writeFileSync(join(root, "knock.json"), '{ "knockDir": "knock" }\n');
  fakeKnock = join(workdir, "knock");
  writeFileSync(fakeKnock, FAKE_KNOCK);
  chmodSync(fakeKnock, 0o755);
  requests = [];
  knockResponse = new Response("{}", { status: 200 });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const fakeFetch: typeof fetch = async (input, init) => {
  requests.push({ url: String(input), init });
  return knockResponse;
};

function push(env: NodeJS.ProcessEnv) {
  return knockPush({
    root,
    env: { PATH: process.env.PATH, FAKE_LOG: log, ...env },
    knockCli: [fakeKnock],
    fetch: fakeFetch,
    log: () => {},
  });
}

function logged(name: string) {
  const path = join(log, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

describe("npm run knock:push", () => {
  it("refuses to run without KNOCK_SERVICE_TOKEN, and reaches nothing", async () => {
    await expect(push({})).rejects.toThrow(/KNOCK_SERVICE_TOKEN/);

    expect({ cli: logged("args"), requests }).toEqual({
      cli: undefined,
      requests: [],
    });
  });

  describe("with a service token", () => {
    const env = { KNOCK_SERVICE_TOKEN: "knock_st_fake" };

    beforeEach(() => {
      git("init", "-q", "-b", "ticket-99-wording");
      git("add", ".");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-q",
        "-m",
        "knock/"
      );
    });

    it("pushes and commits everything to Development, naming the branch and commit", async () => {
      await push(env);

      expect(logged("args")?.split("\n")).toEqual([
        "push",
        "--environment=development",
        "--commit",
        `--commit-message=knock:push from ticket-99-wording at ${git("rev-parse", "--short", "HEAD")}`,
        "",
      ]);
    });

    it("hands the CLI the token through its environment, never its arguments", async () => {
      await push(env);

      expect({
        token: logged("token"),
        inArgs: logged("args")?.includes("knock_st_fake"),
      }).toEqual({
        token: "knock_st_fake",
        inArgs: false,
      });
    });

    it("regenerates knock/ before the CLI reads it", async () => {
      const workflowJson =
        "knock/workflows/refund-request-raised/workflow.json";
      writeFileSync(
        join(root, workflowJson),
        '{ "name": "Refund Request raised", "steps": [] }\n'
      );

      await push(env);

      expect(logged("workflow.json")).toContain('"trigger_data_json_schema"');
    });

    it("replaces Development's default preference set with knock/preferences/default.json", async () => {
      await push(env);

      expect(
        requests.map(({ url, init }) => ({
          url,
          method: init?.method,
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        }))
      ).toEqual([
        {
          url: "https://control.knock.app/v1/environments/development/defaults",
          method: "PUT",
          authorization: "Bearer knock_st_fake",
          body: JSON.parse(
            readFileSync(join(root, "knock/preferences/default.json"), "utf8")
          ),
        },
      ]);
    });

    it("stops before the preference set when the CLI fails", async () => {
      await expect(push({ ...env, FAKE_EXIT: "1" })).rejects.toThrow(
        /knock push/
      );

      expect(requests).toEqual([]);
    });

    it("fails when Knock rejects the preference set, with Knock's reason", async () => {
      knockResponse = new Response('{"message":"invalid preference_set"}', {
        status: 422,
      });

      await expect(push(env)).rejects.toThrow(/422.*invalid preference_set/);
    });

    it("says so in the commit message when knock/ has changes git hasn't committed", async () => {
      writeFileSync(
        join(
          root,
          "knock/workflows/refund-request-raised/in_app_feed_1/markdown_body.md"
        ),
        "Draft\n"
      );

      await push(env);

      expect(logged("args")).toContain(
        `--commit-message=knock:push from ticket-99-wording at ${git("rev-parse", "--short", "HEAD")}, plus uncommitted changes to knock/`
      );
    });
  });
});

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
