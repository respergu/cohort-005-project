import {
  Bell,
  Receipt,
  ReceiptText,
  Ticket,
  TicketCheck,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { WorkflowKey } from "~/lib/notification-workflows";
import { CirclePlay } from "lucide-react";

// ─── Notification Feed icons ───
// Each row in the bell shows an icon for its kind of Notification, picked
// from the feed item's `source.key`, which is the Knock workflow key.
//
// To add one, add the workflow's key to `notificationIcons` below. The map is
// checked against `WorkflowKey`, so a workflow added to
// app/lib/notification-workflows.ts fails `tsc` until it has an icon. An entry
// is either an icon or a function of the item's trigger data, for a workflow
// whose branches look different (Seat claims picks on `data.last_seat`).

export type NotificationIcon = {
  Icon: LucideIcon;
  /** Tailwind classes for the round badge behind the icon. */
  tone: string;
};

export type NotificationItemData = Readonly<Record<string, unknown>>;

type IconRule =
  NotificationIcon | ((data: NotificationItemData) => NotificationIcon);

export const notificationIcons = {
  "new-lesson": {
    Icon: CirclePlay,
    tone: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  },
  "refund-request-raised": {
    Icon: Receipt,
    tone: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  },
  "refund-request-decided": {
    Icon: Receipt,
    tone: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  },
  "refund-request-approved": {
    Icon: ReceiptText,
    tone: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  },

  // ── Seat claims and New Enrollment (#49) ──
  // One workflow sends both Seat claimed and Last Seat claimed. Only the final
  // claim's trigger carries last_seat, and Knock's batch merge keeps it.
  "seat-claimed": (data) =>
    data.last_seat === true
      ? {
          Icon: TicketCheck,
          tone: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
        }
      : {
          Icon: Ticket,
          tone: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
        },
  "new-enrollment": {
    Icon: UserPlus,
    tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
} satisfies Record<WorkflowKey, IconRule>;

/** For a workflow the code doesn't know yet, or an item with no source. */
export const fallbackNotificationIcon: NotificationIcon = {
  Icon: Bell,
  tone: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function pickNotificationIcon(
  rules: Readonly<Record<string, IconRule>>,
  workflow: string,
  data: NotificationItemData
): NotificationIcon {
  if (!Object.hasOwn(rules, workflow)) return fallbackNotificationIcon;
  const rule = rules[workflow];
  return typeof rule === "function" ? rule(data) : rule;
}

export function notificationIconFor(
  workflow: string,
  data: NotificationItemData
): NotificationIcon {
  return pickNotificationIcon(notificationIcons, workflow, data);
}
