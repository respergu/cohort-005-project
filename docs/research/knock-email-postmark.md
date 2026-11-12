# How does Knock send email through Postmark, and does the Free plan brand it?

Research for [#29](https://github.com/respergu/cohort-005-project/issues/29), part of the map [#17](https://github.com/respergu/cohort-005-project/issues/17).

**Checked on 2026-11-12.** Knock's pricing and plan features change often, so re-check the branding and billing rows before deciding.

## Answer

- **Set-up.** Knock sends through a **Postmark channel** that is configured separately for each environment. It takes the Postmark **server** API token and a From address, plus an optional From name. Knock sets no `MessageStream`, so Postmark puts the email on its default `outbound` transactional stream, the same stream Cadence's receipts use today. Cadence's sender becomes From email `hello@cadence.dev` with From name `Cadence`.
- **Development needs no Postmark set-up.** Turn on Knock's **sandbox mode** for the Postmark channel in Development. Knock renders each email in its dashboard but never calls Postmark, needs no credentials, and doesn't count sandboxed messages as usage. Knock also has a built-in test email channel that really sends, but only to members of the Knock account and only 100 emails a month.
- **Yes, the Free plan brands email.** Knock's docs describe "Powered by Knock" branding in email notifications. Removing Knock branding is a Starter feature ($250/month). The docs don't say where the mark sits or what it looks like.
- **Cadence's Notification emails get no unsubscribe header or link by default.** Knock adds unsubscribe headers only to workflows marked *commercial*. Clicking that link flips one global `commercial_subscribed` flag; it isn't per category × channel. Postmark adds nothing on transactional streams. For category × channel opt-outs, put Knock's hosted preference center link (`{{vars.manage_preferences_url}}`) in the email layout footer.
- **One trigger drives both the feed item and the email.** A workflow holds an in-app feed step and an email step. Each step has its own template, but both read the same trigger payload as `{{ data.* }}`. Knock wraps the email template in a shared layout.
- **Billing is confirmed.** A step that preferences skip creates no message and costs nothing. Bounced or failed messages aren't billable. The feed item and the email count as two messages. Usage accrues in every environment, including Development, and the in-app channel has no sandbox mode.

## Method and source trust

- I used only Knock's docs (the live pages, their `.md` versions, and Knock's own `llms-full.txt` export and OpenAPI specs), Knock's pricing page parsed as raw HTML, and Postmark's developer and support docs.
- I called no Knock or Postmark API and changed no settings.
- **(inferred)** marks a conclusion I drew from the sources that they don't state outright. **(unverified)** marks something I couldn't confirm from any primary source.

## 1. Set-up: the Postmark channel in Knock

### Channel fields

Create the channel under **Channels and sources**, then configure it per environment ([Knock Postmark][k-postmark]):

| Group | Field | Notes |
|---|---|---|
| Settings | **API key** (required) | "The API key for your Postmark server." |
| Settings | **From email address** (required, string or Liquid) | "The default sender email address" |
| Settings | **Incoming webhook** | Receives delivery status updates from Postmark |
| Advanced | Sandbox mode; Knock open and link tracking; Postmark open and link tracking; CSS inlining (on by default) | |
| Overrides | **From name**, To, Cc, Bcc, Reply-to, **Payload overrides** | Payload overrides are "a JSON object to merge into the API payload that is sent to the downstream provider" |
| Conditions | Per-environment channel conditions | "If the conditions are not met, the step will be skipped." |

### Server token

- Postmark's send-email endpoint requires the `X-Postmark-Server-Token` header ("This request requires server level privileges") ([Postmark Email API][pm-email]).
- Postmark separates server tokens, "used for requests that require server level privileges", from account tokens ([Postmark API overview][pm-overview]).
- **(inferred)** Knock's "API key for your Postmark server" is therefore the Server API token, the same kind of value as Cadence's `POSTMARK_SERVER_TOKEN`.
- Knock says provider credentials "do not support dynamic values" ([Knock email settings][k-email-settings]).

### Message stream

- "Knock does not target a specific `MessageStream` when sending your transactional email notifications to Postmark. This means that Postmark defaults your notifications to the `"outbound"` transactional stream." ([Knock Postmark][k-postmark])
- Postmark confirms the default: "If not provided, message will default to the "outbound" transactional stream." ([Postmark Email API][pm-email])
- To use another stream, set a payload override such as `{"MessageStream": "broadcasts"}`. It can go on the channel configuration or on the workflow's email step ([Knock Postmark][k-postmark]).

### From address

- Postmark's `From` field: "Registered and confirmed Sender Signature is required." ([Postmark Email API][pm-email])
- Knock's webhook prerequisites also list "A verified sender signature or domain in Postmark" ([Knock Postmark][k-postmark]).
- **(inferred)** `hello@cadence.dev` already meets this, because `app/lib/mailer.server.ts` sends from it today. Set the From email address to `hello@cadence.dev` and the From name override to `Cadence`.

### What Knock adds to each Postmark send

Knock always sends `Metadata.sender: knock.app`, `Metadata.knock_message_id`, `Metadata.knock_recipient_id`, and `Tag` set to the workflow key ([Knock Postmark][k-postmark]). **(inferred)** These tags tell Knock's emails apart from Cadence's receipts in Postmark's activity view, since both share the `outbound` stream.

### Delivery status

- Optional, but recommended. In Knock, turn on **Incoming webhook**. In Postmark, add Knock's webhook URL to the stream with the **Delivery**, **Bounce** and **Spam complaint** events. Postmark Delivery maps to Knock `delivered` and Bounce maps to `bounced`. A spam complaint adds a `message.complaint` event but leaves the delivery status unchanged ([Knock Postmark][k-postmark]).
- Without webhooks, "Knock periodically polls the provider's API to check delivery status" ([Knock delivering notifications][k-delivering]).

### Shared stream, shared suppressions

- Postmark manages suppressions per message stream ("manage view, create, and delete suppressions in your Message Stream", [Postmark Suppressions API][pm-suppressions]).
- Sending to a suppressed address fails with error 406, "Inactive recipient" ([Postmark API overview][pm-overview]).
- **(inferred)** Notification emails and receipts both use `outbound`. An address that hard-bounces or files a spam complaint on either kind of email therefore stops receiving both. A second transactional stream, set with a payload override, would keep them apart.

### Channels exist in every environment; workflows are versioned

- "A created channel exists across all environments in your Knock account and uses the same ID for each environment." You configure each channel per environment ([Knock channels][k-channels]).
- Channel settings "are never versioned" and take effect when saved ([Knock channels][k-channels]).

### Development: three options

1. **Sandbox mode on the Postmark channel (recommended).**
   - "Because sandbox mode never calls your provider, you can save an environment's configuration in sandbox mode without provider credentials." ([Knock integrations overview][k-integrations])
   - "Sandboxed messages are rendered for preview in the Knock dashboard, but do not count toward usage." ([Knock plans][k-plans])
   - Sandboxed messages get the `not_sent` status ([Knock message statuses][k-statuses]).
   - **(inferred)** This is the closest match to the mailer's current `.outbox/` fallback.
2. **Knock's built-in test email channel.**
   - It is "enabled and ready to use across all environments with no additional configuration required." It is limited to "100 emails per month" and to "email addresses associated with the members of your Knock account only". Other addresses fail with `knock_recipient_not_allowed`, and the From address is read-only ([Knock test channel][k-test-channel]).
   - **(inferred)** It is a separate channel from Postmark, and a channel step must name one channel (or a channel group) ([Knock channel step][k-channel-step]). Using it in Development therefore means repointing the email step before the workflow is promoted. Use it for a quick look at the "Powered by Knock" mark, not as the long-term Development set-up.
3. **A separate Postmark server for Development.**
   - Give the Development environment its own token. A Postmark **Sandbox server** "will never send messages to a recipient": messages "appear as Delivered" but "do count towards your monthly sending volume", and a server's type can't be changed after creation ([Postmark server sandbox mode][pm-sandbox]).
   - Alternatively, Knock channel conditions can limit a real send to your own domain, but "Any message that satisfies a channel condition may contribute to usage." ([Knock plans][k-plans])

## 2. Branding on the Free plan

### What the sources say

- **Knock's docs confirm the mark appears in email.** A Knock FAQ is titled *"Why am I seeing multiple "Powered by Knock" branding references in my email messages?"*. Its answer: "it's because you're double wrapping your email template in HTML", because the template "is wrapped by the email layout, which already includes `<html>` and `<body>` tags" ([Knock testing and debugging][k-debug]).
- **The pricing page gates removal to Starter.** The Starter card says "Everything in Free, plus... Remove Knock branding". In the comparison table the row reads "Remove Knock branding: No / Yes / Yes" for Free / Starter / Enterprise, and it sits in the **In-app feeds** section ([Knock pricing][k-pricing]).
- **The Management API has an account-level flag.** `account_features.knock_branding_required` is described as "Whether Knock branding is required to be displayed." The docs' example account, which has `message_sent_limit: 10000`, shows `knock_branding_required: true` ([Knock mAPI auth verify][k-mapi-verify]). These are illustrative example values.
- **The hosted preference center has its own flag.** `knock_branding_required` there means "Whether Knock branding is required in the preference center." ([Knock API reference: preference center][k-api-prefcenter])
- **Your own branding is not gated.** Account branding (logo, icon, colours under **Settings > Branding**) is available to templates and layouts as `vars.branding.*` ([Knock branding][k-branding]). Per-tenant branding is Enterprise only ([Knock plans][k-plans]).

### What I conclude

- **(inferred)** On Free, Knock's emails carry a "Powered by Knock" mark, and so do Knock's pre-built feed components and probably the hosted preference center. Starter removes it.
- **(inferred)** The FAQ says double-wrapping duplicates the mark. That suggests Knock adds it to the rendered HTML document itself, not as editable layout content. If so, editing the layout or choosing "No layout" won't remove it.
- **(unverified)** Where the mark sits, what it looks like, whether the plaintext part carries it, and whether "No layout" removes it. A test send to a team member through the built-in test channel would show it.

## 3. Unsubscribe links, `List-Unsubscribe`, and preferences

### Knock's commercial unsubscribe

- Toggle **Commercial** on a workflow or broadcast. Knock then "Adds required unsubscribe headers to all emails sent through that workflow or broadcast" and "Provides an unsubscribe URL variable" ([Knock commercial unsubscribe][k-commercial]).
- Knock's features page calls it "a one-click unsubscribe header and link to marketing email to support CAN-SPAM compliance" ([Knock features][k-features]).
- **(unverified)** The exact header names (`List-Unsubscribe`, `List-Unsubscribe-Post`) are never spelled out.
- The link variable is `{{vars.commercial_unsubscribe_url}}`. The visual layout editor also offers a "1-click unsubscribe" footer link. Knock shows the link "only for commercial messages" by wrapping it in `{% if vars.commercial_unsubscribe_url %}` ([Knock commercial unsubscribe][k-commercial]).
- A click sets `commercial_subscribed: false` on the recipient's `default` preference set. Recipients "will continue to receive transactional messages based on their other preferences." Knock shows a confirmation page whose text you can customise, or redirects to a URL you set ([Knock commercial unsubscribe][k-commercial]).
- **(inferred)** Workflows not marked commercial, which covers all of Cadence's Notifications, get no unsubscribe header or link from Knock.
- **(inferred)** `commercial_subscribed` is one key, not per category or channel. Marking Notification workflows commercial would make one click opt a user out of every commercial workflow, which doesn't fit Cadence's category × channel model.

### Category × channel preferences

- A `PreferenceSet` is built from `categories`, `channels`, `channel_types` and `workflows`. A category can nest per-channel-type booleans, for example `"collaboration": {"channel_types": {"email": true, "in_app_feed": true}}`. "A message will not send if the user has opted out of receiving it." ([Knock preferences overview][k-prefs])
- Categories are set on a workflow under **Manage workflow** ([Knock workflows][k-workflows]).

### Hosted preference center

- Knock hosts the page at `p.knock.app/p/<token>` through "a signed URL". Users don't log in, and "The link never expires." ([Knock hosted preference center][k-hosted-prefs])
- Each row maps to a category, workflow or channel, and can show "a toggle per channel type". The commercial-messages row is mandatory. The configuration is per environment.
- Link to it from a template or the email layout with `{{vars.manage_preferences_url}}`, or generate a link with `POST /v1/users/{user_id}/preference_center/signed_url` ([Knock hosted preference center][k-hosted-prefs]).
- **(inferred)** The hosted preference center isn't in Knock's list of Enterprise-only features ([Knock plans][k-plans]), so it should be available on Free.

### Postmark on transactional streams

- Unsubscribe handling defaults to `none` on transactional streams. Broadcast streams default to `Postmark` handling ([Postmark Message Streams API][pm-streams]).
- On broadcast streams, Postmark itself adds a link plus "the one-click List-Unsubscribe-Post and List-Unsubscribe headers". For transactional streams, "If you add Unsubscribe headers to transactional messages, Postmark will include them in your send", sent through the API's `Headers` array ([Postmark List-Unsubscribe article][pm-list-unsub]).
- **(unverified)** Cadence could add its own `List-Unsubscribe` header pointing at the preference center through a Knock payload override that sets Postmark's `Headers`. Knock documents that payload overrides merge into Postmark's payload and accept Liquid. Whether a `Headers` override would replace headers Knock sets itself is not documented.

## 4. Email layouts, templates, and one trigger for both channels

### Steps and templates

- "Workflows are represented as a set of steps". Each channel step holds its own template, and templates "cannot currently be shared across workflows, or even across other channel steps within the same workflow." ([Knock workflows][k-workflows])
- Every template gets `data`: "The complete data passed to the workflow trigger". Templates also get `recipient`, `actor`, `vars`, `tenant` and `workflow` ([Knock template variables][k-variables]).
- **(inferred)** So one trigger with one payload fills both the in-app feed item and the email. Cadence writes two templates against the same `data` fields.
- Partials are "reusable pieces of content you can use across any of your channel templates" ([Knock partials][k-partials]).

### Layouts

- The layout is "the shared "frame" of your email". At send time "Knock injects the template into the `{{content}}` variable of its layout" ([Knock email layouts][k-layouts]).
- Every account has a default layout. You can set its footer links in the visual editor, and its logo and colours come from **Settings > Branding**. It has a plaintext version under the "Text" tab.
- Custom layouts are HTML and CSS written in a code editor, and must include `{{content}}`.
- Each email step picks a layout, or "No layout". Layouts must be committed before they apply ([Knock email layouts][k-layouts]).

## 5. Billing: what counts against 10,000 messages a month

- **What a message is.** "A single message delivered to a single user on a single channel." A workflow that results in "an in-app message and an email ... counts as two messages sent." ([Knock pricing][k-pricing])
- **Suppressed by preferences: not billed.** "If the same trigger resulted in zero messages being sent (say because of a given user's messaging preferences,) you wouldn't be charged." ([Knock pricing][k-pricing]) Also: "If a channel step is not executed, there is no associated message. A channel step may be skipped due to user preferences, missing data, or other workflow logic." ([Knock plans][k-plans])
- **Bounced or failed: not billed.** "Messages that bounce or fail to send due to other errors are not included in your billable usage." ([Knock pricing][k-pricing])
  - Knock learns of a bounce from the Postmark webhook or by polling ([Knock delivering notifications][k-delivering]).
  - **(inferred)** Turning on the Incoming webhook with the Bounce event is the surest way to keep bounces out of the count.
- **Postmark 406 rejections: (unverified).** Knock doesn't document how it records Postmark's 406 "Inactive recipient" rejection. Under the "fail to send" rule above it should not be billed.
- **Development counts.** "Regardless of plan, usage may be accrued in any Knock environment." The in-app channel "doesn't support sandbox mode", so feed items created in Development count. Use channel conditions to limit them ([Knock plans][k-plans]).
- **Postmark bills separately.** Every email Knock sends is also a Postmark send, so it counts toward Cadence's Postmark volume. A Postmark Sandbox server's sends count toward that volume too ([Postmark server sandbox mode][pm-sandbox]).

## Not confirmed from a primary source

- Where "Powered by Knock" appears in an email, what it looks like, and whether the plaintext part, a custom layout or "No layout" changes that.
- Whether the in-app "Remove Knock branding" row and the email mark are the same entitlement. The pricing table lists the row under In-app feeds, and the Starter card lists it without naming a channel.
- The exact header names Knock adds to commercial emails, and whether they pass through the Postmark integration unchanged.
- Whether a Knock payload override can add Postmark `Headers`, such as `List-Unsubscribe`, without clobbering Knock's own headers.
- How Knock records Postmark's 406 "Inactive recipient" rejection, and so whether it's billed.
- That Knock's "API key" field means the Postmark Server API token. This is strongly implied but never stated.

## Sources

- [Knock: Postmark integration][k-postmark]
- [Knock: built-in test email channel][k-test-channel]
- [Knock: integrations overview (sandbox mode, channel conditions)][k-integrations]
- [Knock: plans and usage][k-plans]
- [Knock: pricing][k-pricing]
- [Knock: testing and debugging templates ("Powered by Knock" FAQ)][k-debug]
- [Knock: Management API, auth verify (`knock_branding_required`)][k-mapi-verify]
- [Knock: API reference, preference center][k-api-prefcenter]
- [Knock: branding][k-branding]
- [Knock: commercial unsubscribe][k-commercial]
- [Knock: features][k-features]
- [Knock: preferences overview][k-prefs]
- [Knock: hosted preference center][k-hosted-prefs]
- [Knock: workflows][k-workflows]
- [Knock: channels][k-channels]
- [Knock: channel step][k-channel-step]
- [Knock: template variables][k-variables]
- [Knock: partials][k-partials]
- [Knock: email layouts][k-layouts]
- [Knock: email settings][k-email-settings]
- [Knock: message statuses][k-statuses]
- [Knock: delivering notifications][k-delivering]
- [Postmark: API overview][pm-overview]
- [Postmark: Email API][pm-email]
- [Postmark: Message Streams API][pm-streams]
- [Postmark: how to include a List-Unsubscribe header][pm-list-unsub]
- [Postmark: server sandbox mode][pm-sandbox]
- [Postmark: Suppressions API][pm-suppressions]

[k-postmark]: https://docs.knock.app/integrations/email/postmark
[k-test-channel]: https://docs.knock.app/integrations/email/knock-test
[k-integrations]: https://docs.knock.app/integrations/overview#sandbox-mode
[k-plans]: https://docs.knock.app/manage-your-account/knock-plans
[k-pricing]: https://knock.app/pricing
[k-debug]: https://docs.knock.app/template-editor/testing-and-debugging#faq-duplicate-powered-by-knock-branding
[k-mapi-verify]: https://docs.knock.app/mapi-reference/auth/verify
[k-api-prefcenter]: https://docs.knock.app/api-reference/users/preference_center
[k-branding]: https://docs.knock.app/template-editor/branding
[k-commercial]: https://docs.knock.app/preferences/commercial-unsubscribe
[k-features]: https://docs.knock.app/getting-started/knocks-features
[k-prefs]: https://docs.knock.app/preferences/overview
[k-hosted-prefs]: https://docs.knock.app/preferences/hosted-preference-center
[k-workflows]: https://docs.knock.app/concepts/workflows
[k-channels]: https://docs.knock.app/concepts/channels
[k-channel-step]: https://docs.knock.app/designing-workflows/channel-step
[k-variables]: https://docs.knock.app/template-editor/variables
[k-partials]: https://docs.knock.app/template-editor/partials
[k-layouts]: https://docs.knock.app/integrations/email/layouts
[k-email-settings]: https://docs.knock.app/integrations/email/settings
[k-statuses]: https://docs.knock.app/send-notifications/message-statuses
[k-delivering]: https://docs.knock.app/send-notifications/delivering-notifications#delivery-status-tracking
[pm-overview]: https://postmarkapp.com/developer/api/overview
[pm-email]: https://postmarkapp.com/developer/api/email-api
[pm-streams]: https://postmarkapp.com/developer/api/message-streams-api
[pm-list-unsub]: https://postmarkapp.com/support/article/1299-how-to-include-a-list-unsubscribe-header
[pm-sandbox]: https://postmarkapp.com/developer/user-guide/sandbox-mode/server-sandbox-mode
[pm-suppressions]: https://postmarkapp.com/developer/api/suppressions-api
