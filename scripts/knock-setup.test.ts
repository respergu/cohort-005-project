import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `npm run knock:setup` is driven the way a person drives it: one answer per
// prompt on stdin. Everything it reaches outside itself (gh, the clipboard and
// the browser opener) is a fake on PATH that records what it was given, so a
// test never reaches GitHub, Knock or a browser.

const SCRIPT = fileURLToPath(new URL("./knock-setup.sh", import.meta.url));

const DEVELOPMENT_STAGES = [
  "Turn on environments",
  "In-app response filter (Development)",
  "Postmark email channel in sandbox mode (Development)",
  "Enhanced security stays off (Development)",
  "Service token",
];

const PRODUCTION_STAGES = [
  "Postmark: the notifications message stream",
  "Postmark email channel (Production)",
  "In-app response filter (Production)",
  "Enhanced security on (Production)",
  "Production read-only",
  "Service token",
];

const FAKES = {
  gh: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG/gh-calls"
case "$1 $2" in
  "auth status") exit 0 ;;
  "secret set") cat > "$FAKE_LOG/gh-secret-value"; printf '%s\\n' "$3" >> "$FAKE_LOG/gh-secrets" ;;
  "secret list") cat "$FAKE_LOG/gh-secrets" 2>/dev/null || true ;;
  *) exit 1 ;;
esac
`,
  pbpaste: `#!/usr/bin/env bash
printf 'read\\n' >> "$FAKE_LOG/clipboard-reads"
cat "$FAKE_LOG/clipboard" 2>/dev/null || true
`,
  pbcopy: `#!/usr/bin/env bash
cat > "$FAKE_LOG/clipboard"
`,
  wslview: `#!/usr/bin/env bash
printf '%s\\n' "$1" >> "$FAKE_LOG/opened"
`,
};

let workdir: string;
let repo: string;
let log: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "knock-setup-"));
  repo = join(workdir, "repo");
  log = join(workdir, "log");
  const bin = join(workdir, "bin");
  for (const dir of [repo, log, bin]) mkdirSync(dir);
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  git("init", "-q");
  git("remote", "add", "origin", "https://github.com/fork-owner/cadence.git");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function runWizard(answers: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(workdir, "bin")}:${process.env.PATH ?? ""}`,
    FAKE_LOG: log,
  };
  delete env.ENV_FILE;
  const result = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    env,
    input: answers.map((answer) => `${answer}\n`).join(""),
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

function logged(name: string) {
  const path = join(log, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function stageTitles(output: string) {
  return [...output.matchAll(/Stage \d+\/(\d+) · (.+)$/gm)].map(
    ([, total, title]) => `${title} of ${total}`
  );
}

const skip = (stages: number) => Array<string>(stages).fill("y");

// Development's service token stage, with every stage before it skipped.
const toServiceToken = [
  "1",
  "",
  ...skip(DEVELOPMENT_STAGES.indexOf("Service token")),
];

// Longer than a macOS terminal line takes, like the signing key in #22.
const TOKEN = `knock_st_${"a1B2".repeat(1200)}`;

function copyToClipboard(text: string) {
  writeFileSync(join(log, "clipboard"), text);
}

describe("npm run knock:setup", () => {
  it("shows only Development's stages when Development is chosen", () => {
    const { status, output } = runWizard([
      "1",
      "",
      ...skip(DEVELOPMENT_STAGES.length),
    ]);

    expect(status).toBe(0);
    expect(stageTitles(output)).toEqual(
      DEVELOPMENT_STAGES.map((t) => `${t} of ${DEVELOPMENT_STAGES.length}`)
    );
  });

  it("shows only Production's stages when Production is chosen", () => {
    const { status, output } = runWizard([
      "2",
      "",
      ...skip(PRODUCTION_STAGES.length),
    ]);

    expect(status).toBe(0);
    expect(stageTitles(output)).toEqual(
      PRODUCTION_STAGES.map((t) => `${t} of ${PRODUCTION_STAGES.length}`)
    );
  });

  it("changes nothing when every stage is already done", () => {
    runWizard(["1", "", ...skip(DEVELOPMENT_STAGES.length)]);

    expect(existsSync(join(repo, ".env"))).toBe(false);
    expect(logged("gh-calls")).not.toMatch(/^secret set/m);
    expect(logged("opened")).toBe("");
  });

  describe("the service token stage", () => {
    it.each([
      "https://github.com/fork-owner/cadence.git",
      "git@github.com:fork-owner/cadence.git",
    ])(
      "reads the token from the clipboard into .env and origin's secrets (origin %s)",
      (originUrl) => {
        git("remote", "set-url", "origin", originUrl);
        copyToClipboard(`${TOKEN}\n`);

        const { status, output } = runWizard([...toServiceToken, "n", "", "y"]);

        expect(status).toBe(0);
        expect(readFileSync(join(repo, ".env"), "utf8")).toBe(
          `KNOCK_SERVICE_TOKEN='${TOKEN}'\n`
        );
        expect(logged("gh-calls")).toMatch(
          /^secret set KNOCK_SERVICE_TOKEN -R fork-owner\/cadence$/m
        );
        expect(logged("gh-secret-value")).toBe(TOKEN);
        expect(output).not.toContain(TOKEN.slice(0, 40));
      }
    );

    it("writes .env readable only by its owner", () => {
      copyToClipboard(TOKEN);

      runWizard([...toServiceToken, "n", "", "y"]);

      expect(statSync(join(repo, ".env")).mode & 0o777).toBe(0o600);
    });

    it("clears the clipboard once it has read the token", () => {
      copyToClipboard(TOKEN);

      runWizard([...toServiceToken, "n", "", "y"]);

      expect(logged("clipboard")).toBe("");
    });

    it("writes nothing when the clipboard doesn't hold a service token", () => {
      copyToClipboard("https://dashboard.knock.app/~/settings/service-tokens");

      const { status, output } = runWizard([...toServiceToken, "n", "", "n"]);

      expect(status).toBe(0);
      expect(existsSync(join(repo, ".env"))).toBe(false);
      expect(logged("gh-calls")).not.toMatch(/^secret set/m);
      expect(output).toMatch(/still to do by hand:\n.*Service token/);
    });

    it("on a re-run, can reuse the token already in .env", () => {
      writeFileSync(join(repo, ".env"), `KNOCK_SERVICE_TOKEN='${TOKEN}'\n`);

      const { status } = runWizard([...toServiceToken, "n", "y", "y"]);

      expect(status).toBe(0);
      expect(logged("clipboard-reads")).toBe("");
      expect(logged("gh-secret-value")).toBe(TOKEN);
      expect(readFileSync(join(repo, ".env"), "utf8")).toBe(
        `KNOCK_SERVICE_TOKEN='${TOKEN}'\n`
      );
    });
  });

  it("puts the in-app channel's real key on the to-do list when it isn't the one knock/ uses", () => {
    const { status, output } = runWizard([
      "1",
      "",
      "y",
      "n",
      "n",
      "in-app-feed",
      "y",
      ...skip(3),
    ]);

    expect(status).toBe(0);
    expect(output).toMatch(
      /still to do by hand:\n.*In-app channel key is in-app-feed, not in-app/
    );
  });

  it("refuses to run when origin is the course repo", () => {
    git(
      "remote",
      "set-url",
      "origin",
      "https://github.com/ai-hero-dev/cohort-005-project.git"
    );
    copyToClipboard(TOKEN);

    const { status, output } = runWizard([...toServiceToken, "n", "", "y"]);

    expect(status).not.toBe(0);
    expect(output).toContain("origin is the course repo");
    expect(logged("gh-calls")).not.toMatch(/^secret set/m);
    expect(existsSync(join(repo, ".env"))).toBe(false);
  });
});
