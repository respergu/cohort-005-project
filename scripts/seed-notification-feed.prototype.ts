// PROTOTYPE, throwaway (respergu/cohort-005-project#24). Never merge to main.
//
// Puts a few catalogue Notifications into the real Knock Development feed for
// one demo user per role, through the `prototype-notification-feed` workflow.
//
//   npm run prototype:notification-feed:seed            # users 1, 2, 5, 10
//   npm run prototype:notification-feed:seed -- 3 7     # specific user ids
//   npm run prototype:notification-feed:seed -- --force # re-seed anyway
//
// Every message counts toward Knock's 10,000/month, so users whose feed
// already has items are skipped unless --force is passed.
import Database from "better-sqlite3";
import {
  countFeedItems,
  prototypeNotificationsFor,
  triggerPrototypeNotification,
} from "../app/lib/notification-feed.prototype.server";

const DEMO_USERS = [
  1, // Alex Rivera, Platform Admin
  2, // Sarah Chen, Instructor
  5, // Emma Wilson, Student
  10, // Bossy McBossface, Student + Team Admin
];

const args = process.argv.slice(2);
const force = args.includes("--force");
const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);
const userIds = ids.length ? ids : DEMO_USERS;

const sqlite = new Database("data.db", { readonly: true });
let sent = 0;

for (const userId of userIds) {
  const user = sqlite
    .prepare("select id, name, role from users where id = ?")
    .get(userId) as { id: number; name: string; role: string } | undefined;
  if (!user) {
    console.log(`#${userId}: no such user, skipped`);
    continue;
  }
  const existing = await countFeedItems(userId);
  if (existing > 0 && !force) {
    console.log(`${user.name}: already has ${existing} in the feed, skipped`);
    continue;
  }
  const notifications = prototypeNotificationsFor(sqlite, userId);
  // Oldest first, so the feed reads newest-on-top in catalogue order
  for (const n of [...notifications].reverse()) {
    await triggerPrototypeNotification(user, n);
    sent++;
  }
  console.log(
    `${user.name} (${user.role}): ${notifications.map((n) => n.data.kind).join(", ")}`
  );
}

console.log(
  `\nTriggered ${sent} messages (each counts toward Knock's 10K/month).`
);
