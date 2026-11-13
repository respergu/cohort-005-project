# Can a user with no Knock record yet read and save preferences with their token?

Research for [Can a user with no Knock record yet read and save preferences with their token?](https://github.com/respergu/cohort-005-project/issues/35), part of the map [Wayfinder: In-app notifications for Cadence](https://github.com/respergu/cohort-005-project/issues/17).

**Checked on 2026-11-13** against Knock's Development environment, docs.knock.app, `@knocklabs/client` 0.23.1 and `@knocklabs/react-core` 0.17.1.

## Answer

- **Cadence doesn't have to identify a user before saving their preferences.** A merge write (`PUT /v1/users/{id}/preferences/default` with `__persistence_strategy__: "merge"`) for a user id Knock has never seen returns `200` with the saved set. It also creates the Knock user, with only an `id`. The public key plus a signed user token behaves this way, and so does the secret key.
- **The first read fails instead.** `GET /v1/users/{id}/preferences/default` and `GET /v1/users/{id}/preferences` for an unknown user return `404 resource_missing`. A read doesn't create the user, and `@knocklabs/client`'s `getPreferences()` throws on the 404. So the `/settings` Notifications section must treat that 404 as "nothing saved yet" and show Cadence's own defaults. The person's first save then creates their Knock user.
- **Unknown users don't break the bell.** For an unknown user, a feed read returns `200` with an empty feed and zero counts. Bulk mark-all-read returns `200` with a completed `BulkOperation` of 0 rows. Neither call creates the user.
- **If Cadence would rather never see the 404,** the smallest identify is a server-side `PUT /v1/users/{knockId}` with `{ "name", "email" }` and the secret key. It returns `200` and the User. The browser can make the same call with the public key, the token and an empty body `{}`. `@knocklabs/client`'s `authenticate({ id })` does exactly that by default every time it runs.
- **Enhanced security wasn't probed.** It's off in Development. The docs say it adds one rule: a public-key request without a valid signed user token is rejected. Cadence always sends the token, so **(inferred)** the results above should hold in Production. If tokens ever set `explicit_grants`, they need `preferences/read`, `preferences/write`, `user/feed_read` and `user/feed_write`, plus `user/write` if the browser identifies.

## Method and source trust

- **Docs:** docs.knock.app pages (their `.md` versions) and Knock's API reference.
- **SDK source:** Knock's own JavaScript SDK, read from the npm tarballs of `@knocklabs/client` 0.23.1 and `@knocklabs/react-core` 0.17.1. The same code is published at [knocklabs/javascript][gh-js].
- **Probe:** Knock's **Development** environment (`_test_` keys) on 2026-11-13.
  - Five fresh random UUIDs served as user ids, so no real or seeded user was touched.
  - Each request was signed the way the browser will sign it: an RS256 JWT with `sub`, `iat` and `exp` (+1 hour), signed with Node's `crypto` and sent as `Authorization: Bearer <public key>` plus `X-Knock-User-Token: <jwt>`.
  - Whether each user existed was checked with the secret key through `GET /v1/users/{id}`.
  - **No workflow was triggered and no environment or channel setting was changed.** Afterwards every throwaway user was deleted with the secret key, and each one then returned `404`.
- **(inferred)** marks a conclusion I drew from the sources that they don't state outright. **(unverified)** marks something I couldn't confirm.

## 1. What Knock's docs say

### A public key may call the preference, identify and feed endpoints

With a public key, Knock's [security and authentication][k-security] page allows, among others:

| Endpoint | Method |
|---|---|
| `/v1/users/:id` | `GET`, `PUT` (identify) |
| `/v1/users/:id/preferences` | `GET` |
| `/v1/users/:id/preferences/:id` | `GET`, `PUT` |
| `/v1/users/:id/feeds/:channel_id` | `GET` |
| `/v1/channels/:channel_id/messages/bulk/:action` | `POST` |

### Preference read

- The [custom preference center][k-custom-pc] page says: "If the user hasn't set any preferences of their own, `getPreferences()` returns the environment default set you created in the step above (merged with any tenant default), so you always have values to render."
- The API reference for [Get user preference set][k-get-prefs] lists only a `200` response. Neither page covers a user that doesn't exist in Knock.

### Preference write

- [Update user preference set][k-set-prefs]: "Updates a complete preference set for a user. By default, this is a destructive operation and will replace any existing preferences with the preferences given. Use `'__persistence_strategy__': 'merge'` to merge with existing preferences instead."
- That page doesn't say whether it creates a missing user. By contrast, [Set channel data][k-channel-data] says so outright: "If no user exists in the current environment for the given `user_id`, Knock will create the user entry as part of this request."

### Identifying

- [Identify user][k-identify] (`PUT /v1/users/{user_id}`): "Create or update a user with the provided identification data." The id goes in the path, and the body may be any properties.
- On [Users][k-users], `id` is the only required attribute. `email` is "required for email channels". Knock's stated reason to identify is about sending: "User data must be synchronized to Knock to send the user a notification or to reference that user in a notification."
- [Identifying recipients][k-identifying] names three ways: direct (`PUT /v1/users/{user_id}`), inline, and bulk. "All identification methods in Knock use an upsert approach."
  - Inline: "Knock guarantees that recipients are identified before executing any other action. This enables lazy recipient creation."
  - Client-side: "When mounted, the provider will identify the user in Knock by upserting the provided user information."

### Enhanced security

From [security and authentication][k-security]:

- "When enhanced security mode is enabled, Knock will reject requests from the client using your public API key that **do not include a signed user token**." The error code is `missing_user_token`: "This environment requires that you supply a `X-Knock-User-Token` header when using a public API key" ([error codes][k-error-codes]).
- Without enhanced security, "a request with your public key can act as any user."
- A token is "granted access to all resources by default" unless it sets `explicit_grants: true`. The relevant grants are `preferences/read`, `preferences/write`, `user/feed_read`, `user/feed_write` ("mark as read, seen, or archived") and `user/write`.
- The page doesn't say that enhanced security changes how Knock treats a user id it doesn't know.

### What the client SDK sends

- **`authenticate()` identifies the user by default** ([`knock.ts`][gh-knock]).
  - `identificationStrategy` defaults to `"inline"`. When `authenticate` gets an object with an `id`, it calls `this.user.identify(properties)`, which sends `PUT /v1/users/{id}` with the remaining properties, so an `{ id }`-only call sends `{}`.
  - The call is fire-and-forget: errors are only logged.
  - `identificationStrategy: "skip"` turns it off, and `KnockProvider` passes that prop through ([`KnockProvider.tsx`][gh-provider]).
- **Preferences** ([`users/index.ts`][gh-users]):
  - `getPreferences()` sends `GET /v1/users/{id}/preferences/{set}`, and `setPreferences()` sends `PUT` to the same path with the body as given.
  - Both throw `Error` on any error status.
- **Mark all as read** ([`feed.ts`][gh-feed]): `markAllAsRead()` sends `POST /v1/channels/{feedId}/messages/bulk/read` with `user_ids: [userId]` plus the feed's current filters (archived, status, tenant).

## 2. Probe results (Development, 2026-11-13)

| # | Call | Auth | Status | Response | User exists afterwards? |
|---|---|---|---|---|---|
| A0 | `GET /v1/users/{A}` (baseline) | secret | `404` | `resource_missing` | no |
| A1 | `GET /v1/users/{A}/preferences/default` | public + token | **`404`** | `resource_missing` | no |
| A2 | `GET /v1/users/{A}/preferences` | public + token | **`404`** | `resource_missing` | no |
| A4 | `PUT /v1/users/{A}/preferences/default`, merge | public + token | **`200`** | `PreferenceSet` holding what was written | **yes**, `id` only |
| A6 | `GET /v1/users/{A}/preferences/default` again | public + token | `200` | the same `PreferenceSet` | yes |
| B1 | `GET /v1/users/{B}/feeds/{channel}` | public + token | `200` | empty feed, all counts `0` | no |
| B3 | `POST /v1/channels/{channel}/messages/bulk/read` | public + token | `200` | `BulkOperation`, `status: "completed"`, 0 rows | no |
| C1 | `PUT /v1/users/{C}/preferences/default`, merge | **secret** | `200` | `PreferenceSet` | **yes**, `id` only |
| D1 | `PUT /v1/users/{D}` with `name` and `email` | secret | `200` | `User` with `name` and `email` | yes |
| D2 | `GET /v1/users/{D}/preferences/default` | public + token | `200` | every key `null` (nothing saved) | yes |
| E1 | `PUT /v1/users/{E}` with body `{}` | public + token | `200` | `User`, `id` only | **yes** |
| Z | `DELETE /v1/users/{A,C,D,E}` | secret | `204` (`404` for B, which never existed) | — | no, all `404` afterwards |

The merge write's body (A4 and C1) was:

```json
{
  "__persistence_strategy__": "merge",
  "categories": { "probe-unknown-user": { "channel_types": { "email": false } } }
}
```

### Response shapes

```json title="A1/A2: preference read for an unknown user (404)"
{
  "code": "resource_missing",
  "message": "The resource you requested does not exist",
  "status": 404,
  "type": "api_error"
}
```

```json title="A4: merge write for an unknown user (200)"
{
  "id": "default",
  "channels": null,
  "categories": { "probe-unknown-user": { "channel_types": { "email": false } } },
  "workflows": null,
  "commercial_subscribed": null,
  "channel_types": null,
  "__typename": "PreferenceSet"
}
```

```json title="A5: the user the write created (secret-key GET /v1/users/{id})"
{ "id": "…", "updated_at": "2026-11-13T14:51:41.944Z", "created_at": null, "__typename": "User" }
```

```json title="B1: feed read for an unknown user (200)"
{
  "meta": { "total_count": 0, "unread_count": 0, "unseen_count": 0, "__typename": "FeedMetadata" },
  "vars": { "app_name": "…", "app_url": "…", "commercial_unsubscribe_url": "…", "manage_preferences_url": "…" },
  "entries": [],
  "page_info": { "after": null, "before": null, "page_size": 50, "__typename": "PageInfo" }
}
```

```json title="B3: bulk mark-all-read for an unknown user (200)"
{
  "id": "…",
  "name": "messages.read",
  "status": "completed",
  "estimated_total_rows": 0,
  "processed_rows": 0,
  "success_count": 0,
  "error_count": 0,
  "error_items": [],
  "progress_path": "/v1/bulk_operations/…",
  "__typename": "BulkOperation"
}
```

```json title="D1: smallest server-side identify (200)"
{
  "id": "…",
  "name": "Probe User",
  "email": "probe+…@example.com",
  "updated_at": "2026-11-13T14:51:45.800Z",
  "created_at": null,
  "__typename": "User"
}
```

## 3. What this means for Cadence

- **`/settings` can read and write with no identify step.**
  - Read the `default` set. On `404` with `code: "resource_missing"`, render the defaults from [What can a person mute, and on which channels?](https://github.com/respergu/cohort-005-project/issues/27).
  - Save with `__persistence_strategy__: "merge"`. The first save creates the Knock user.
  - Branch on `code`, not on the bare status: a path the API doesn't route also returns `404`, but with a different body, `{ "errors": { "detail": "404 Not Found" } }` ([errors][k-errors]).
- **A user created by a preference write has no name or email.** **(inferred)** That's harmless here. Every trigger names its recipients and actor inline as `{ id, name, email }` ([How do Cadence users and audiences reach the vendor?](https://github.com/respergu/cohort-005-project/issues/26)), and identification is an upsert, so the first Notification fills them in.
- **Watch the SDK's default inline identify.** If the bell uses `@knocklabs/client` or `KnockProvider` with `user={{ id: knockId }}`, it sends `PUT /v1/users/{knockId}` with `{}` on every authenticate. That creates every signed-in person in Knock on page load. **(inferred)**
  - This breaks the rule in [How do Cadence users and audiences reach the vendor?](https://github.com/respergu/cohort-005-project/issues/26) that a user first exists in Knock when a trigger names them.
  - The call is fire-and-forget, so a `/settings` read can still race it and get the 404.
  - To keep that ticket's model, pass `identificationStrategy: "skip"`. Either way, handle the 404.
- **If a follow-up ticket prefers to identify up front,** the smallest call is the server-side `PUT /v1/users/{knockId}` with `{ name, email }` (D1). That's one extra Knock request from wherever Cadence makes it, such as the `/settings` loader.

## Not confirmed from a primary source

- **Whether enhanced security changes any of this.** Not probed: it's off in Development and was left off. The docs describe only the token requirement and grants.
- **Whether a read for an existing user with nothing saved returns the environment default set,** as the custom preference center page says. In Development it returned a set with every key `null` (D2). Development may simply have no environment default set yet, and I couldn't check that without the dashboard or the Management API.
- **The 404 on a preference read for an unknown user** comes from the probe only. Knock's API reference lists just a `200` for that endpoint.
- **Whether a replace (non-merge) write also creates the user.** Not probed, because Cadence's writes merge.

## Sources

- [Knock: security and authentication (public-key endpoints, enhanced security, grants)][k-security]
- [Knock: preferences overview (`__persistence_strategy__`, defaults)][k-prefs]
- [Knock: custom preference center][k-custom-pc]
- [Knock: API reference, get user preference set][k-get-prefs]
- [Knock: API reference, update user preference set][k-set-prefs]
- [Knock: API reference, set channel data][k-channel-data]
- [Knock: API reference, identify user][k-identify]
- [Knock: API reference, list feed items][k-feed]
- [Knock: API reference, bulk update message statuses for a channel][k-bulk]
- [Knock: API reference, errors][k-errors]
- [Knock: API reference, error codes][k-error-codes]
- [Knock: users][k-users]
- [Knock: identifying recipients][k-identifying]
- [Knock: implementation guide, going to production][k-going-live]
- [knocklabs/javascript: `packages/client/src/knock.ts`][gh-knock]
- [knocklabs/javascript: `packages/client/src/clients/users/index.ts`][gh-users]
- [knocklabs/javascript: `packages/client/src/clients/feed/feed.ts`][gh-feed]
- [knocklabs/javascript: `packages/react-core/src/modules/core/context/KnockProvider.tsx`][gh-provider]

[k-security]: https://docs.knock.app/in-app-ui/security-and-authentication
[k-prefs]: https://docs.knock.app/preferences/overview
[k-custom-pc]: https://docs.knock.app/preferences/custom-preference-center
[k-get-prefs]: https://docs.knock.app/api-reference/users/get_preferences
[k-set-prefs]: https://docs.knock.app/api-reference/users/set_preferences
[k-channel-data]: https://docs.knock.app/api-reference/users/set_channel_data
[k-identify]: https://docs.knock.app/api-reference/users/update
[k-feed]: https://docs.knock.app/api-reference/users/feeds/list_items
[k-bulk]: https://docs.knock.app/api-reference/channels/bulk/update_message_status
[k-errors]: https://docs.knock.app/api-reference/overview/errors
[k-error-codes]: https://docs.knock.app/api-reference/overview/error-codes
[k-users]: https://docs.knock.app/concepts/users
[k-identifying]: https://docs.knock.app/managing-recipients/identifying-recipients
[k-going-live]: https://docs.knock.app/tutorials/implementation-guide#going-to-production
[gh-js]: https://github.com/knocklabs/javascript
[gh-knock]: https://github.com/knocklabs/javascript/blob/main/packages/client/src/knock.ts
[gh-users]: https://github.com/knocklabs/javascript/blob/main/packages/client/src/clients/users/index.ts
[gh-feed]: https://github.com/knocklabs/javascript/blob/main/packages/client/src/clients/feed/feed.ts
[gh-provider]: https://github.com/knocklabs/javascript/blob/main/packages/react-core/src/modules/core/context/KnockProvider.tsx
