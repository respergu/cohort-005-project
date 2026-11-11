# Which notification vendors fit Cadence's in-app needs?

Research for [#7](https://github.com/respergu/cohort-005-project/issues/7), part of the map [#6](https://github.com/respergu/cohort-005-project/issues/6).

**Checked on 2026-11-11.** Pricing pages and free-tier limits change often, so re-check every number marked "pricing" before deciding.

## Answer

**Shortlist, in order:**

1. **Knock.** The free plan covers every v1 capability with no feature gates. It includes keyed batching, per-workflow and per-category preferences, a real-time React feed, unlimited environments, unlimited feed retention and object subscriptions for fan-out. The feed token is a JWT that the server signs locally. Its main gaps are no EU data residency yet and no prebuilt preference UI.
2. **Novu.** It is the only vendor with **EU data residency on the free plan**, and its React package ships a prebuilt `<Inbox />` and preferences UI. It also has an explicit server-render entry point and is open source, so self-hosting is an escape hatch. The free plan is tight: 5 workflows, a 24-hour maximum digest window, 30-day inbox retention and 2 environments. Pro from $30/month lifts most of these limits.
3. **Courier.** Its free plan includes digest and batching, a prebuilt Inbox and preferences UI, lists and audiences for fan-out, and Test and Production environments. It ranks third because every feed token must be minted by calling Courier's API, the free plan keeps logs for only 7 days, and the batching docs are split between "Automations (Legacy)" and Journeys.

**Dropped:**

- **SuprSend** fails the "usable free tier" constraint. Its Free plan has no batching, no digest and no preferences: those rows read "—" for Free and Essentials. Cadence v1 needs both mute preferences and batching. The cheapest plan with them is Business at $250/month. Its React inbox also crashes on import under Cadence's React 19 unless you add an npm `overrides` entry (see [SSR test](#appendix-ssr-smoke-test)).

**Survived the hard constraints but not shortlisted:**

- **MagicBell.** It has a free tier (1,000 deliveries/month, 1 project) and a React inbox, so it passes both hard constraints. However, I found **no native batching or digest** in its docs or its v2 API reference, and batching is a v1 requirement. Its free tier is also a tenth the size of the others and has a single project, so dev and prod can't be separated.

## Method and source trust

- **Pricing:** I downloaded each vendor's pricing page as raw HTML and parsed the comparison tables cell by cell. The text extractors drop the tick and dash icons, so they can't show which plan includes a feature.
- **Features:** I used each vendor's own docs and API reference.
- **React SSR fit:** I used the npm packages themselves. I read their `exports` maps and `"use client"` markers, then ran a server-render smoke test in plain Node with no `window` (see [Appendix](#appendix-ssr-smoke-test)).
- I did not use third-party comparison posts, review sites or other people's research issues as evidence. Anything I couldn't confirm in a primary source is marked **(unverified)**.

## Hard-constraint screen

| Vendor | Free tier (pricing, 2026-11-11) | What moves you to paid | Prebuilt React inbox | Server render in Node (React 19) |
|---|---|---|---|---|
| **Knock** | 10,000 messages/mo; unlimited environments, team members, workflows and stored profiles; feed retention unlimited; logs 30 days ([pricing][k-pricing]) | No hard cap: "If you go over your limit, we'll get in touch with you about making sure you have a billing method in place next month." Starter is $250/mo for 50,000 messages, then $0.005 each ([pricing][k-pricing]) | `@knocklabs/react`: `NotificationFeedPopover`, `NotificationFeed`, `NotificationIconButton` ([docs][k-react]) | ✅ imports; renders the bell button |
| **Novu** | 10,000 workflow runs/mo; **5 workflows**; 2 environments (Dev + Prod); 3 team members; unlimited subscribers; activity log 24 h; inbox feed retention 30 days; digest/delay window max 24 h ([pricing][n-pricing]) | "We never stop or throttle your notifications. Usage above your plan rolls into on-demand pricing". Pro is from $30/mo (30K runs, 20 workflows); Team is from $250/mo ([pricing][n-pricing]) | `@novu/react`: `<Inbox />` with Bell, Notifications and Preferences ([docs][n-inbox]) | ✅ imports; ships a dedicated server stub |
| **Courier** | 10,000 sends/mo; digest & batching included; log retention 7 days ([pricing][c-pricing]) | Business is pay-as-you-go at $0.005/send. "Pricing is based on notifications sent, not team size or channels" ([pricing][c-pricing]) | `@trycourier/courier-react`: `CourierInbox`, `CourierInboxPopupMenu`, `CourierToast`, `CourierPreferences` ([docs][c-react]) | ✅ imports; renders nothing on the server ("render client-side only", [docs][c-react]) |
| **MagicBell** | 1,000 deliveries/mo; 1 project; unlimited team members and users ([pricing][m-pricing]) | Startup is $249/mo for 50,000 deliveries, then $0.0025 each. Whether Builder charges or blocks past 1,000 is **unverified** ([pricing][m-pricing]) | `@magicbell/react`: `FloatingInbox`, `Inbox`, `UserPreferences` ([docs][m-react]) | ✅ imports; renders the inbox button |
| **SuprSend** | 10,000 notifications/mo; 30-day logs; in-app feed with SuprSend branding; lists and broadcasts. **Batching, Digest, Channel Preferences and Category preferences are all "—" on Free** ([pricing][s-pricing]) | Batching, digest and preferences start at Business, $250/mo ([pricing][s-pricing]) | `@suprsend/react`: `SuprSendProvider`, `Inbox` (npm package contents) | ❌ import crashes under React 19 because `react-popper@2.3.0` pulls a nested `react-dom@18`; ✅ after an npm `overrides` fix |

Notes:

- **Knock** also caps "Guide recipients" at 500/mo on Free, but that applies to in-app *guides* (banners and modals), not the notification feed ([pricing][k-pricing]). Usage counts in every environment, including development: "Regardless of plan, usage may be accrued in any Knock environment" ([plans][k-plans]). Sandbox mode, which keeps test messages out of usage, "is supported across all channel types (except for in-app)" ([integrations][k-integrations]). So development traffic to the in-app feed counts against the 10,000.
- **Novu's** "5 workflows" cap matters because each notification type is a workflow. Cadence's catalogue (#8) could exceed five types. The topic billing rule matters too: "triggering to a topic with 100 subscribers counts as 100 runs after fan-out" ([pricing FAQ][n-pricing]).
- **Courier's** pricing page renders three layout variants that disagree. The desktop table puts "EU Data Residency" on Business. The mobile table puts "EU Datacenter" and "Advanced user preferences" on Enterprise only. Both variants include "Digest & batching" on the free Developer plan ([pricing][c-pricing]). Which plan includes EU residency is therefore **unverified**.

## Comparison of survivors

### Summary

| Criterion | Knock | Novu | Courier | MagicBell |
|---|---|---|---|---|
| Node server SDK | `@knocklabs/node` 1.41.1 | `@novu/api` 3.19.1 | `@trycourier/courier` 10.0.0 | `magicbell-js` 1.8.0 |
| Per-type mute preferences | ✅ per workflow, category and channel; **no prebuilt UI** (hook + hosted page) | ✅ per workflow and channel, plus global; prebuilt UI in Inbox | ✅ per topic (On/Off/Required); prebuilt UI | ✅ per category and channel; prebuilt UI |
| Batching ("5 new comments on Lesson X") | ✅ batch key, fixed or sliding window ≤ 90 days, `total_activities` | ✅ digest key, `eventCount`; **window ≤ 24 h on Free** | ✅ batch with category key; digest topics | ❌ none found |
| Real-time inbox | ✅ WebSocket | ✅ WebSocket (`wss://…socket.novu.co`) | ✅ realtime connection via `listenForUpdates()` | ✅ persistent connection (`reconnecting-websocket` dependency) |
| Fan-out to many Students | Object subscriptions (unlimited subscribers); triggers ≤ 1,000 recipients; dashboard-only broadcasts | Topics ≤ 100,000 subscribers; triggers ≤ 100 recipients | Lists, audiences, bulk jobs, broadcasts | Broadcasts ≤ 1,000 recipients or topic subscribers |
| Feed auth | RS256 JWT signed **locally** (`signUserToken`) | HMAC-SHA256 of subscriberId, computed **locally** | JWT minted by **calling Courier** (`POST /auth/issue-token`) | HS256 JWT signed **locally** |
| Environments (Free) | Unlimited | 2 | Production + Test (≤ 20) | 1 project (projects are the environments) |
| No-network tests | None built in → Cadence-side fake | Self-host possible (heavy) → Cadence-side fake | Mock keys: **unverified** → Cadence-side fake | None found → Cadence-side fake |
| Retention | Feed indefinite; logs 30 days | Inbox 30 days (Free) / 90 days (paid); logs 24 h (Free) | Logs 7 days (Free); inbox retention **unverified** | **Unverified** |
| Data residency | US only; EU "by the end of 2026" | US + EU on all plans | EU on a paid plan (Business or Enterprise, **unverified**) | **Unverified** |
| Email/push later | ✅ unlimited channels | ✅ email, SMS, push, chat | ✅ email, SMS, push, chat | ✅ email, push, SMS, Slack, Teams |

The details and citations for each row follow.

### Node server SDK (triggering from route actions)

- **Knock:** `@knocklabs/node`, "generated with Stainless", Node 20 LTS or later. You call `client.workflows.trigger(key, { recipients, data })` ([README][k-node]). One trigger accepts "up to 1000 recipients". An `Idempotency-Key` header dedupes retries for 24 hours, and a `cancellation_key` lets you cancel a run. Passing full recipient objects identifies those users inline ([trigger guide][k-trigger]). Latest npm release is 1.41.1, published 2026-11-10 ([npm][k-npm-node]).
- **Novu:** `@novu/api`. You call `novu.trigger({ to, workflowId, payload })`. EU users set `serverURL: "https://eu.api.novu.co"` ([SDK docs][n-node]). A trigger takes at most 100 recipients. An `Idempotency-Key` header is supported, but "isn't enabled for all organizations"; `transactionId` dedupes at processing time ([trigger API][n-trigger]).
- **Courier:** `@trycourier/courier`, Node 20+, called as `client.send.message({ message: { to, … } })` ([README][c-node]). Its docs show sends to a `list_id`, an `audience_id` or a `list_pattern` ([lists guide][c-lists]). Idempotency support is **unverified**: the README doesn't mention it.
- **MagicBell:** `magicbell-js`, a browser and Node client ([docs][m-docs]). `POST /broadcasts` accepts 1–1,000 recipients ([broadcast][m-broadcast]).

### Per-type preferences (mute)

- **Knock:** Preferences can be set per workflow, per category, per channel type and per channel. "Knock only sends a notification if all preference combinations that exist on the recipient evaluate to `true`." A workflow can be set to "Override recipient preferences" for messages users must always get. Users manage preferences on a hosted page or in a custom UI built on the preferences API ([preferences][k-prefs]). The React package exports a `usePreferences` hook but **no prebuilt preference-centre component** (from reading the `@knocklabs/react` 0.15.1 type exports). Cadence would build its own mute UI.
- **Novu:** Precedence runs from workflow defaults, to subscriber global preferences, to subscriber per-workflow preferences, and "the most specific layer that defines a channel wins". "Critical" workflows can't be muted and are hidden from the preference UI. Subscribers manage preferences in the `<Inbox />` Preferences view ([preferences][n-prefs]).
- **Courier:** Each template maps to one subscription topic, and each topic defaults to On, Off or Required. Courier "enforces the user's preference on every send from that template". The preference centre can be hosted or embedded via the React SDK ([preferences editor][c-prefs]). One pricing variant lists "Advanced user preferences" as Enterprise-only and doesn't define it ([pricing][c-pricing]). Which features that covers is **unverified**.
- **MagicBell:** Preferences are "by channel … and by notification category" ([in-app channel][m-inapp]). The API has `/channels/user_preferences` ([API reference][m-ref]), and `@magicbell/react` ships a `UserPreferences` component that "lets users toggle notification channels per category" ([React docs][m-react]).

### Batching and digests

- **Knock:** The batch function supports fixed or sliding windows, and "A batch can stay open for at most 90 days". A batch key can group further, for example "a batch key of `page_id`", and a lesson ID would work the same way. Templates get `total_activities` and up to 10 `activities` objects. Rendering more than 10 is Enterprise-only ([batch function][k-batch]). Batching is included on Free ([pricing][k-pricing]). How a feed item behaves while a batch is still open is **unverified**: the docs don't say.
- **Novu:** The digest step can be Regular or Scheduled, and you can group by one payload key (the docs use `payload.postId`). "The digest window you configure follows your plan limit": 1 day on Free, 7 on Pro, 30 on Team ([digest][n-digest]). Templates get `steps.<digest-step>.eventCount` and `events` ([personalize content][n-digest-vars]). Steps after a digest "stay paused until the digest finishes", so the in-app item appears once the window closes ([digest][n-digest]).
- **Courier:** Batching works on wait period, max wait, max items, category key and scope, and covers the in-app inbox ([batching][c-batching]). That page belongs to "Automations (Legacy)": "new workflows are built as Journeys" ([automations][c-automations]). Journeys "also offer … batch, and digest nodes" ([journeys][c-journeys]), but I found no Journeys reference with their limits (**unverified**). Digest & batching is included on the free Developer plan ([pricing][c-pricing]).
- **MagicBell:** **No native batching or digest found.** The v2 API reference has 78 endpoints and no mention of "digest" or "batch" ([API reference][m-ref]). Cadence would have to batch on its own side.

### Real-time inbox updates

- **Knock:** The feed is "a real-time feed component" ([feed guide][k-feed]). Clients receive pushes over "a websocket when new messages are sent to an in-app feed channel" ([feeds overview][k-feeds]).
- **Novu:** The Inbox "manages the real-time unread count" ([inbox][n-inbox]). The EU setup uses `socketUrl` `wss://eu.socket.novu.co` ([prepare for production][n-prod]).
- **Courier:** "Call `inbox.listenForUpdates()` after you authenticate. It opens the realtime connection" ([React SDK][c-react]).
- **MagicBell:** "MagicBell maintains a persistent connection to deliver notifications in real-time" ([in-app channel][m-inapp]). `@magicbell/react` 1.14.0 depends on `reconnecting-websocket` (package.json).

### Audience fan-out (new-course and manual announcements)

- **Knock:**
  - **Subscriptions:** Trigger a workflow with an object as recipient, such as a hypothetical `announcements/all-students` object, and "Knock will handle the fan-out … to all subscribed recipients". "There is no limit to the number of recipients you can subscribe to an object", added 100 per call. The actor is excluded automatically ([subscriptions][k-subs]).
  - **Audiences** exist, but "It's not yet possible to trigger a workflow for an audience via the API" ([trigger guide][k-trigger]).
  - **Broadcasts** can target an audience or all users but "are not callable via the API" ([broadcasts][k-broadcasts]). A Platform Admin announcement written in Cadence's UI would use subscriptions, not broadcasts.
- **Novu:** Topics take up to 100,000 subscribers. You pass `actor` to exclude a subscriber, and "a separate workflow event is created for each subscriber" ([topics][n-topics]). Each subscriber is billed as one run ([pricing FAQ][n-pricing]).
- **Courier:** Lists (`list_id`), rule-based audiences (`audience_id`) and `list_pattern` wildcards. "Courier resolves membership at send time and delivers one message per member" ([lists guide][c-lists]).
- **MagicBell:** Broadcasts "target specific recipients, which can be individual users or topics with subscribers", up to 1,000 per request ([broadcast][m-broadcast]).
- **Cost note for all four:** every recipient counts as one billable unit (Knock message, Novu run, Courier send, MagicBell delivery). A new-course announcement to *N* Students uses *N* of the monthly allowance.

### Feed authentication and user identity

- **Knock:**
  - **Token:** With enhanced security mode on, Knock "will reject requests from the client using your public API key that do not include a signed user token". The backend signs an RS256 JWT with a signing key (`sub` required) using `signUserToken` from `@knocklabs/node`, so minting needs no network call ([auth][k-auth]; [README][k-node]).
  - **Environments:** Enhanced security is off by default, and the docs suggest leaving it off in development and turning it on for production ([auth][k-auth]).
  - **Identity:** Users are identified inline on trigger ([trigger guide][k-trigger]). The React provider takes `user={{ id }}` ([feed guide][k-feed]).
- **Novu:**
  - **Token:** The server computes `subscriberHash` = "`HMAC-SHA256(secretKey, subscriberId)`". "If HMAC encryption is active … and `subscriberHash` is not provided, the Inbox will not load", and the setting is per environment ([prepare for production][n-prod]).
  - **Identity:** If a `subscriberId` doesn't exist, "Novu will automatically create a new subscriber with that ID" ([Remix quickstart][n-remix]).
- **Courier:**
  - **Token:** The backend must "Call `POST /auth/issue-token` … with your API key and a scope string" such as `user_id:… inbox:read:messages inbox:write:events`. Every token mint is a network call to Courier. "omitting [`expires_in`] mints a token that never expires".
  - **Identity:** "Nothing has to exist in Courier first, since signing in registers the user." EU workspaces must mint at `api.eu.courier.com` ([auth][c-auth]).
- **MagicBell:**
  - **Token:** An HS256 JWT "signed with your project's Secret Key", carrying `user_email` and/or `user_external_id` plus `api_key`, signed locally ([User JWT][m-jwt]).
  - **Identity:** Users are created on the fly when the inbox first initialises for them ([quick start][m-quickstart]).

For Cadence: users are identified by their Cadence user ID. DevUI user-switching then becomes a matter of minting a new token or hash for the newly selected user. That is cheap with Knock, Novu and MagicBell (local signing) and needs one API call per switch with Courier.

### Dev/test story

- **Knock:**
  - **Environments:** Unlimited. Each has its own API keys and data, and "Data is never copied between environments". Content is promoted from development to production ([environments][k-envs]; [pricing][k-pricing]).
  - **Sandbox:** `settings.sandbox_mode` on a trigger stops delivery to providers ([testing][k-testing]), but sandbox doesn't apply to the in-app channel ([integrations][k-integrations]).
  - **No-network tests:** No local emulator.
- **Novu:**
  - **Environments:** Two on Free (Dev + Prod) ([pricing][n-pricing]).
  - **Self-hosting:** Possible, but it needs API, Worker, WebSocket and Dashboard services plus MongoDB, Redis and S3 storage ([self-hosting][n-selfhost]). That is far too heavy for unit tests, but it is a real escape hatch from the vendor.
- **Courier:**
  - **Environments:** Every workspace starts with "Production and Test", and up to 20 environments are allowed. Templates, topics, integrations, keys and logs are isolated per environment ([environments][c-envs]).
  - **Mock keys:** Not mentioned on that page. A search summary of Courier's docs said they are Enterprise-only (**unverified**).
- **MagicBell:** Projects serve as environments: "Create projects for staging/production environments" ([quick start][m-quickstart]). The free plan has 1 project ([pricing][m-pricing]), so dev and prod can't be separated without paying.
- **For Cadence:** none of these gives a no-network in-app test mode on a free plan. Every option needs a Cadence-side seam like `app/lib/mailer.server.ts`, which uses a `MailTransport` interface with a real `postmarkTransport` and an `outboxTransport` that writes JSON files to `.outbox/` when no token is set. A `NotificationTransport` with a vendor implementation and an outbox/fake fallback keeps `npm run test` offline whichever vendor wins.

### Data retention and residency

- **Knock:**
  - **Retention:** "In-app feed notifications are available indefinitely". Message logs are kept 30 days on Free and Starter and 90 days on Enterprise. "Custom retention policies are not currently supported" ([data retention][k-retention]).
  - **Residency:** EU residency is a roadmap item: "We expect to support EU data residency by the end of 2026" ([plans][k-plans]). As of 2026-11-11 there is **no EU region**.
- **Novu:**
  - **Residency:** "All plans support US and EU regions" ([pricing FAQ][n-pricing]).
  - **Retention:** The inbox feed keeps 30 days on Free and 90 days on Pro and Team. The activity log keeps 24 h on Free ([pricing][n-pricing]). Older notifications disappear from a Free-tier inbox after 30 days.
- **Courier:**
  - **Retention:** Logs are kept 7 days on Developer, 30 days on Business and 1 year on Enterprise ([pricing][c-pricing]). Inbox message retention isn't documented (**unverified**).
  - **Residency:** EU is available, but which plan includes it is **unverified** because the pricing page contradicts itself. Signing in to an EU workspace uses `apiUrls` set for the EU region ([auth][c-auth]).
- **MagicBell:** **Unverified.** I found no documented notification retention period or EU storage region.

### Adding email or push later

- **Knock:** "Unlimited delivery channels" on every plan ([pricing][k-pricing]).
- **Novu:** "All channels: Email, In-app, SMS, Chat, Push" on Free ([pricing][n-pricing]).
- **Courier:** Batching covers "email, SMS, chat, in-app inbox, and push" ([batching][c-batching]). The preference centre can route to `email`, `inbox`, `push` and `sms` ([preferences editor][c-prefs]).
- **MagicBell:** Channels include email, mobile push, Slack, SMS, Teams, web push and in-app ([docs][m-docs]).

None of the four would rule out email or push later. Adding email would mean deciding whether email moves from Postmark to the vendor or stays on Postmark.

## Why this order

1. **Knock first.** It is the only vendor whose **free plan has no feature gates and no workflow cap**. Batching has keys and windows up to 90 days, there are unlimited environments, and feed items never expire. Signing the feed JWT locally fits DevUI user-switching. Object subscriptions fit "announce to all Students" with no recipient limit. The costs:
   - No EU residency yet. This is a real issue if the privacy ticket decides EU Students' data must stay in the EU.
   - No prebuilt preference UI, so Cadence builds the mute screen with `usePreferences`.
   - Development in-app messages count toward the 10,000 allowance.
2. **Novu second.** It has the best out-of-the-box UI (Inbox with built-in Preferences), the most careful SSR packaging and **EU residency on every plan**. It is open source, so self-hosting is a hedge against lock-in. The free plan constrains production use: 5 workflows, a 24-hour digest cap and 30-day inbox history. Expect to need Pro (from $30/month) once the catalogue passes five types. If residency turns out to be a hard requirement, Novu moves to first.
3. **Courier third.** It is capable and its free plan includes batching. However, minting each feed token needs a network call to Courier, free logs last only 7 days, batching docs are split across a legacy product and Journeys, and the pricing page contradicts itself on EU residency.
4. **MagicBell** is not shortlisted because it has no native batching, a 1,000-delivery free plan, and a single project.

## Open risks

- **Residency and privacy:** Knock is US-only today. Cadence serves Students in many countries (it resolves country per request for PPP), and the map's privacy question is still open. If EU residency is required, the order becomes Novu, then Courier on a paid plan, then Knock once its EU region ships.
- **Fan-out volume vs. free allowance:** every vendor bills per recipient. 10,000 units a month is spent quickly if new-course announcements go to all Students (#9) and comment activity is high. Nobody has estimated Cadence's volume yet, and #12 needs that figure.
- **Hydration (unverified):** the smoke test covered only server import and `renderToString`, not client hydration in a browser. Novu renders a hidden stub on the server, and Courier renders nothing. The safest pattern for every vendor is to mount the bell **only after hydration** (a client-only island). The prototype ticket (#13) should confirm this in the real app.
- **Novu's free-tier caps:** 5 workflows and a 24-hour digest window may be too small for the v1 catalogue (#8).
- **Knock in-app usage in development:** sandbox mode doesn't cover in-app, so dev and test traffic to a real Knock environment counts toward usage.
- **Pricing drift:** all limits were read on 2026-11-11. Courier's page already contradicts itself.

## Unverified items

- MagicBell: what happens past 1,000 deliveries on Builder; retention; EU residency.
- Courier: inbox message retention; which plan includes EU residency (Business or Enterprise); what "Advanced user preferences" covers; idempotency support in the Node SDK; Journeys batch-node limits; mock keys and plan.
- Knock: how a feed item behaves while a batch window is open; when the EU region ships.
- All vendors: hydration behaviour in a real React Router 8 browser render.

## Noted but not surveyed

- **Engagespot:** its official pricing page (`engagespot.co/pricing`) returned 404 on 2026-11-11, so its free tier couldn't be confirmed from a primary source.
- **Pingram** (formerly NotificationAPI; `notificationapi.com/pricing` redirects to `pingram.io/pricing`): the pricing page lists free email and SMS allowances but nothing about in-app, inbox, preferences or batching on the free plan ([pricing][pingram-pricing]).

## Appendix: SSR smoke test

**Why:** Cadence is React Router 8.3.0 with `ssr: true` and React 19.2.7 (`package.json`, `react-router.config.ts`). A component that touches `window` when imported would break the whole server bundle, even if it is only rendered on the client.

**What I did:**

- Installed each package with `npm install --ignore-scripts` into a scratch directory, alongside `react@19` and `react-dom@19`.
- Dynamically imported each package in Node 24 (where `typeof window === "undefined"`).
- Called `renderToString` on the provider plus the inbox or bell. No effects run, so no network calls happen.

| Package (version) | Import | `renderToString` | Notes |
|---|---|---|---|
| `@knocklabs/react` 0.15.1 | ✅ | ✅ 1,145 chars (`<button class="rnf-notification-icon-button" …`) | Entry has `"use client"`, which has no effect outside React Server Components. Peer deps allow React 17–19. |
| `@novu/react` 3.19.2 | ✅ | ✅ 185 chars (a visually-hidden detector `div`) | The `exports` map sends `browser` to the real component and `import`/`require` to `dist/*/server/`, where `Inbox`, `Bell`, `Preferences` etc. are no-op stubs. |
| `@magicbell/react` 1.14.0 | ✅ | ✅ 1,749 chars (`<div class="magicbell--floating-ui …`) | `"use client"` on `floating-inbox` etc. |
| `@trycourier/courier-react` 9.3.5 | ✅ | ✅ 0 chars | Renders nothing on the server, consistent with "render client-side only" ([React SDK][c-react]). |
| `@suprsend/react` 1.5.0 | ❌ `Cannot read properties of undefined (reading 'ReactCurrentDispatcher')` | — | Depends on `react-popper@2.3.0`, whose peer range is `react-dom ^16.8 \|\| ^17 \|\| ^18`, so npm installs a nested `react-dom@18.3.1`. |
| `@suprsend/react` 1.5.0 + `"overrides": {"react-popper": {"react-dom": "$react-dom"}}` | ✅ | ✅ 1,038 chars | Works once forced onto the app's React DOM. |

Package versions and publish dates come from the npm registry ([@knocklabs/react][k-npm-react], [@novu/react][n-npm-react], [@magicbell/react][m-npm-react], [@trycourier/courier-react][c-npm-react], [@suprsend/react][s-npm-react], [react-popper][react-popper-npm]).

<!-- Sources -->

[k-pricing]: https://knock.app/pricing
[k-plans]: https://docs.knock.app/manage-your-account/knock-plans
[k-retention]: https://docs.knock.app/manage-your-account/data-retention
[k-react]: https://docs.knock.app/in-app-ui/react/overview
[k-feed]: https://docs.knock.app/in-app-ui/react/feed
[k-feeds]: https://docs.knock.app/in-app-ui/feeds/overview
[k-auth]: https://docs.knock.app/in-app-ui/security-and-authentication
[k-batch]: https://docs.knock.app/designing-workflows/batch-function
[k-prefs]: https://docs.knock.app/preferences/overview
[k-broadcasts]: https://docs.knock.app/concepts/broadcasts
[k-subs]: https://docs.knock.app/concepts/subscriptions
[k-envs]: https://docs.knock.app/concepts/environments
[k-trigger]: https://docs.knock.app/send-notifications/triggering-workflows/api
[k-testing]: https://docs.knock.app/send-notifications/testing-workflows
[k-integrations]: https://docs.knock.app/integrations/overview
[k-node]: https://github.com/knocklabs/knock-node
[k-npm-node]: https://www.npmjs.com/package/@knocklabs/node
[k-npm-react]: https://www.npmjs.com/package/@knocklabs/react
[n-pricing]: https://novu.co/pricing
[n-inbox]: https://docs.novu.co/platform/inbox/overview
[n-prod]: https://docs.novu.co/platform/inbox/prepare-for-production
[n-digest]: https://docs.novu.co/platform/workflow/add-and-configure-steps/configure-action-steps/digest
[n-digest-vars]: https://docs.novu.co/platform/workflow/add-notification-content/personalize-content
[n-prefs]: https://docs.novu.co/platform/concepts/preferences
[n-topics]: https://docs.novu.co/platform/concepts/topics
[n-node]: https://docs.novu.co/platform/sdks/server/typescript
[n-trigger]: https://docs.novu.co/api-reference/events/trigger-event
[n-remix]: https://docs.novu.co/platform/quickstart/remix
[n-selfhost]: https://docs.novu.co/community/self-hosting-novu/overview
[n-npm-react]: https://www.npmjs.com/package/@novu/react
[c-pricing]: https://www.courier.com/pricing
[c-react]: https://www.courier.com/docs/platform/inbox/web/react-sdk/
[c-auth]: https://www.courier.com/docs/in-app/authenticate-users
[c-batching]: https://www.courier.com/docs/platform/automations/batching
[c-automations]: https://www.courier.com/docs/journeys/automations/overview
[c-journeys]: https://www.courier.com/docs/journeys/build
[c-prefs]: https://www.courier.com/docs/recipients/preferences/preferences-editor
[c-lists]: https://www.courier.com/docs/guides/announce-to-a-list
[c-envs]: https://courier.com/docs/platform/workspaces/environments-api-keys
[c-node]: https://github.com/trycourier/courier-node
[c-npm-react]: https://www.npmjs.com/package/@trycourier/courier-react
[m-pricing]: https://www.magicbell.com/pricing
[m-docs]: https://www.magicbell.com/docs
[m-react]: https://www.magicbell.com/docs/libraries/magicbell-react
[m-jwt]: https://www.magicbell.com/docs/api/authentication/user
[m-inapp]: https://www.magicbell.com/docs/channels/in_app
[m-broadcast]: https://www.magicbell.com/docs/primitive/broadcast
[m-ref]: https://www.magicbell.com/docs/api/reference
[m-quickstart]: https://www.magicbell.com/docs/quick-start
[m-npm-react]: https://www.npmjs.com/package/@magicbell/react
[s-pricing]: https://www.suprsend.com/pricing
[s-npm-react]: https://www.npmjs.com/package/@suprsend/react
[react-popper-npm]: https://www.npmjs.com/package/react-popper
[pingram-pricing]: https://www.pingram.io/pricing
