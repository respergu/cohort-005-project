import { describe, expect, it } from "vitest";
import {
  Bell,
  Receipt,
  ReceiptText,
  Ticket,
  TicketCheck,
  UserPlus,
} from "lucide-react";
import {
  notificationIconFor,
  pickNotificationIcon,
  type NotificationIcon,
} from "./notification-icons";
import { CirclePlay } from "lucide-react";

describe("notificationIconFor", () => {
  it("shows a play button for New lesson", () => {
    expect(notificationIconFor("new-lesson", {}).Icon).toBe(CirclePlay);
  });

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

  it("shows a ticket for Seat claimed", () => {
    expect(notificationIconFor("seat-claimed", { seats_left: 2 }).Icon).toBe(
      Ticket
    );
  });

  it("shows a checked ticket for Last Seat claimed, a Seat claimed item with last_seat", () => {
    expect(
      notificationIconFor("seat-claimed", { seats_left: 0, last_seat: true })
        .Icon
    ).toBe(TicketCheck);
  });

  it("shows a new person for New Enrollment", () => {
    expect(notificationIconFor("new-enrollment", {}).Icon).toBe(UserPlus);
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
