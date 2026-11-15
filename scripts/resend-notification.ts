// Re-sends a parked outbox row, with its original idempotency key, to recover
// from a bad deploy:
//
//   npm run notifications:resend -- <row id>
//
// The row id is in the log line that parked it. The script sends through the
// transport the server would use (KNOCK_TRIGGERS, from the environment or
// .env). If the send fails, the row goes back into the normal retries, which
// the running server's sweep picks up. A row 24 hours old is dropped instead,
// and so is every row the sweep finds at that age. See docs/adr/0014.

import { z } from "zod";
import { db } from "~/db";
import {
  createNotificationSender,
  type ResendOutcome,
} from "~/lib/notification-sender.server";
import {
  chooseTransport,
  createTransport,
} from "~/lib/notification-transports.server";

const USAGE = "Usage: npm run notifications:resend -- <row id>";

const rowId = z.coerce.number().int().positive().safeParse(process.argv[2]);
if (!rowId.success) {
  console.error(USAGE);
  process.exit(1);
}
const id = rowId.data;

const sender = createNotificationSender(
  db,
  createTransport(chooseTransport(process.env))
);
const outcome = await sender.resend(id, new Date());

const report: Record<ResendOutcome, string> = {
  sent: `Sent outbox row ${id}.`,
  retrying: `Outbox row ${id} failed to send again. It's back in the retries, which the running server's sweep will pick up.`,
  parked: `Knock rejected outbox row ${id} again, so it's still parked.`,
  expired: `Outbox row ${id} was 24 hours old, so it was dropped instead of sent.`,
  "not parked": `There's no parked outbox row ${id}. It may have been sent or dropped already, or still be waiting.`,
};
if (outcome === "sent") {
  console.log(report[outcome]);
} else {
  console.error(report[outcome]);
  process.exitCode = 1;
}
