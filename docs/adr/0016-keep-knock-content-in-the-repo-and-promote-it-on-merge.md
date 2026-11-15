# Keep Knock content in the repo and promote it on merge to main

Every Knock workflow (its in-app and email templates, trigger data schema, Batch and Branch steps, category and `override_preferences`), the email layout, the `app_url` variable and the default preference set live as files in `knock/`. A PR reviews them alongside the code that triggers them. The Knock dashboard is not where they're edited. A branch pushes its drafts to Development, uncommitted. On merge to main, a GitHub Action does three things in order: it pushes the variables and default preference set to both environments, pushes and commits everything to Development, then promotes to Production. We chose this because Knock promotes *every* committed change at once, and because Production must hold a workflow before the code that triggers it ships, or the outbox parks the trigger. When main is the only thing ever committed, Production Knock always matches merged code. Repo files also let any fork load every workflow into its own Knock account, and let the factory's agents change wording in a PR.

## Considered Options

- **Author in the dashboard and `knock pull` into the repo.** PRs show a diff, but there are two places to edit and they drift apart.
- **Dashboard only.** Simplest, but wording isn't reviewed, agents can't change it, and a fork starts with an empty Knock account.
- **A Knock branch per git branch.** Development's main stays clean, but the app's triggers would have to target the branch.
- **Promote as a separate deploy step.** The timing is tighter, but Cadence has no deploy pipeline, so it's a step someone can forget.

## Consequences

- Any edit in the Development dashboard is overwritten by the next push from main. Knock has no lock. Production is made read-only ("Modify resources in any environment" off), so only a promote changes it.
- Production Knock changes when a PR merges, before that code deploys. Until then the old code is still running, so a schema change must keep working for it (new keys optional at first). Rows parked in that gap are re-sent with the script for parked rows.
- Each workflow's trigger data schema is generated from its zod schema in `app/`, not written by hand.
- Channel settings can't be written through the API: sandbox mode, the Postmark payload override and the in-app response filter. Neither can Enhanced security or the read-only switch. A wizard (`npm run knock:setup`) walks a person through them once per environment and once per fork.
- A service token has full access to both environments and can't be scoped. It is a GitHub secret and also sits in each developer's `.env`. Local scripts only ever target Development.
- A push never deletes, so a workflow removed from the repo stays in Knock until someone archives it by hand.
