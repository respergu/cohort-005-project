# Trigger Notifications through a SQLite outbox

Cadence never calls Knock from the request that causes a Notification. The domain function that writes the event (approving a Refund Request, claiming a Seat, posting a Reply) also writes the whole Knock trigger as an outbox row, in the same SQLite transaction. That row holds the workflow, recipients, data and a random UUID used as the idempotency key. After the commit the request starts sending its rows without waiting, and a timer in the server process sweeps every ~30s for retries and for rows a crash left behind. We chose this over calling Knock inline, as the refund emails call Postmark today, so a Knock failure can't fail an action that has already committed, and a crash or outage can't lose a Notification. Today a failed refund email gives a 500 after the decision is saved, and the email is gone.

## Considered Options

- **Inline after the write, log failures.** Simplest, but a Knock outage or a crash between commit and call drops the Notification.
- **Inline with a few in-request retries.** Fewer drops, but the action slows while Knock struggles, and a crash still drops it.
- **Batching in the outbox.** Rejected in favour of Knock's Batch step (per recipient, fixed 1-hour window, no flush of the first event), which keeps the outbox to "get each trigger to Knock".

## Consequences

- The outbox is a delivery queue, not Cadence's record of Notifications. A row is deleted as soon as Knock accepts it, so there is no "sent" state. Anyone checking whether a person was told looks in Knock, which keeps feed items forever and message logs for 30 days on the Free plan.
- Retries stop after about an hour, then the row is parked as failed and logged, to be re-sent by hand. A stale Notification is worse than a missing one, so the sweep deletes every row, waiting or parked, 24 hours after it was written, and logs that it did. A row that a crash left behind during a long outage is dropped instead of sent late. Every send and re-send stays inside Knock's 24-hour idempotency window, so none can deliver the same Notification twice.
- The idempotency key is a random UUID, not the row id. A reseed reuses row ids, and Knock would replay the old response and silently drop the new trigger.
- Who gets told is decided when the event happens. Knock's batch then delivers to whoever was triggered, even if, say, an Enrollment ends before the hour closes.
