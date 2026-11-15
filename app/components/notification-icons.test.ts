import { describe, expect, it } from "vitest";
import { Bell, Receipt, ReceiptText, Ticket, TicketCheck } from "lucide-react";
import {
  notificationIconFor,
  pickNotificationIcon,
  type NotificationIcon,
} from "./notification-icons";

describe("notificationIconFor", () => {
  it("shows a receipt for Refund Request raised", () => {
    expect(notificationIconFor("refund-request-raised", {}).Icon).toBe(Receipt);
  });

  it("shows the buyer a receipt for Refund Request decided", () => {
    expect(notificationIconFor("refund-request-decided", {}).Icon).toBe(
      Receipt
    );
  });

  it("shows the Instructor an itemised receipt for Refund Request approved", () => {
    expect(notificationIconFor("refund-request-approved", {}).Icon).toBe(
      ReceiptText
    );
  });

  it("falls back to a bell for a workflow it doesn't know", () => {
    expect(notificationIconFor("something-new", {}).Icon).toBe(Bell);
  });

  it("does not treat Object.prototype names as workflows", () => {
    expect(notificationIconFor("toString", {}).Icon).toBe(Bell);
  });
});

describe("pickNotificationIcon", () => {
  it("lets a workflow choose its icon from the item's data", () => {
    const seat: NotificationIcon = { Icon: Ticket, tone: "seat" };
    const lastSeat: NotificationIcon = { Icon: TicketCheck, tone: "last" };
    const rules = {
      "seat-claimed": (data: Readonly<Record<string, unknown>>) =>
        data.last_seat === true ? lastSeat : seat,
    };

    expect(
      pickNotificationIcon(rules, "seat-claimed", { last_seat: true })
    ).toBe(lastSeat);
    expect(pickNotificationIcon(rules, "seat-claimed", {})).toBe(seat);
  });
});
