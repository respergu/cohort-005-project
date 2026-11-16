# Identify Knock users inline by a random id

In Knock, each Cadence user is known by a random UUID stored on their `users` row and set when the row is inserted, not by their numeric user id. The Knock user, the feed, saved preferences and the signed user token's `sub` all hang off that UUID. Cadence never syncs users to Knock. Each outbox row lists its recipients and actor as `{ id, name, email }`, read in the event's transaction, and Knock creates or updates them when the trigger runs. Group audiences ("every Platform Admin", "everyone with an Enrollment on the course") are listed by Cadence in that same transaction, not held in Knock. We chose this so `npm run db:seed`, which gives users the same ids every time, starts everyone with a fresh feed, and so Knock holds no state that a missed role change, Lapse or profile edit could leave out of date.

## Considered Options

- **The numeric user id, as Knock's docs show.** Rejected: after a reseed, user 5 keeps their old feed, unread count and links to rows that may no longer exist. Two local databases would also share one feed in the shared Knock Development environment. This is the reason ADR 0014 gives for not using row ids as idempotency keys.
- **Sync users on signup and on every edit.** Rejected: it adds a write path to signup, /settings and /admin/users, plus a backfill, and a missed write leaves Knock out of date. Sending the details on every trigger means each Notification uses the name and email Cadence holds when the event happens.
- **Knock Objects with subscriptions for course and admin audiences.** Rejected: every Enrollment change and role change would need its own outbox write, and Knock reads the subscribers when the trigger runs, not when the event happens. Knock's Audiences and Broadcasts can't be triggered through the API.

## Consequences

- Changing the Knock id later loses every feed and every saved preference.
- A user who has never received a Notification doesn't exist in Knock. Their feed still reads as empty, but anything that writes to them first, such as saving preferences, may need to identify them.
- If an email changes while a batch window is still open, that batch goes to the old address.
- One trigger takes at most 1,000 recipients, so a larger audience is written as several outbox rows, each with its own UUID.
- Knock holds only name and email, never role, avatar or the numeric Cadence id.
- By default Knock's feed returns each actor's full user record, email included, to the recipient's browser. So in every environment the in-app channel's API response filter is set to `actor: { only: ["id", "name"] }`. Otherwise a Reply would show the replier's email to the Question's author.
