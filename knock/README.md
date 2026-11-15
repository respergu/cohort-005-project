# knock/

Cadence's Knock content, as Knock CLI files: every workflow with its templates, the email layout, the `app_url` variable and the default preference set. The repo is the source of truth, and Production Knock follows main ([ADR 0016](../docs/adr/0016-keep-knock-content-in-the-repo-and-promote-it-on-merge.md)).

## Rules

- **Edit these files, never the Knock dashboard.** The next merge to main pushes main's `knock/` over Development. Production is read-only ("Modify resources in any environment" is off), so only a promote changes it.
- **Try a branch's drafts with `npm run knock:push`.** It needs `KNOCK_SERVICE_TOKEN` in `.env`, and it only ever targets Development. It regenerates the schemas, then pushes and commits everything to Development, because Knock runs only committed workflows when the API triggers them. It sets Development's value of each variable. Only a merge to main sets Production's.
- **A workflow that only exists on a branch can reach Production.** The promote on merge takes every committed change in Development, and main's sync only overwrites what main has. If you pushed a new workflow from a branch that won't merge, archive it in Knock by hand.
- **Production Knock changes on merge, before the new code deploys.** The old code keeps running until the deploy, so a new trigger data key starts out optional. The outbox parks triggers that fail in that gap. Re-send them with `npm run notifications:resend -- <row id>`.
- **A push never deletes.** A workflow removed from the repo has to be archived in Knock by hand.
- **Categories are added, never removed.** A push adds each new category to Knock's preference category catalog. A category removed from the repo has to be archived in Knock by hand.

## What's here

| Path | What | Written by |
|---|---|---|
| `workflows/<key>/` | One workflow per key in `app/lib/notification-workflows.ts` | Hand, except `trigger_data_json_schema` and each `channel_key`: run `npm run knock:generate`. A test fails when they're stale. |
| `layouts/cadence/` | The email layout: HTML and the Text tab | Hand |
| `variables.json` | `app_url`, per environment | Hand |
| `preferences/default.json` | The default preference set, one category per `/settings` row | Hand |
| `channels.json` | The Knock channel key for each channel type | Hand, matching `npm run knock:setup` |

After a push, the Knock CLI rewrites `workflow.json` and `layout.json` in its own form. Keep that form; `knock:generate` compares parsed JSON, so key order doesn't matter.

## What runs, and where

| When | What | Touches Production? |
|---|---|---|
| `npm run knock:push`, from a branch | Category catalog, push and commit to Development, Development's default preference set, Development's variable values | Only the category catalog, which is project-wide. Adding a name changes no workflow or preference. |
| A pull request that touches `knock/` (`.github/workflows/knock-validate.yml`) | Offline checks, then `knock layout validate` and `knock workflow validate`. On a fork's pull request there's no secret, so Knock's checks are skipped with a notice. | No |
| A merge to main (`.github/workflows/knock-sync.yml`) | 1. Category catalog, `knock variable push`, and the default preference set in both environments. 2. Push and commit everything to Development as "Sync with git commit `<sha>`". 3. `knock commit promote --to=production`. | Yes. The promote is the only step that changes Production's workflows. |

After `npm run knock:setup` sets up Production, run the sync once without waiting for a merge: `gh workflow run knock-sync.yml --ref main`.
