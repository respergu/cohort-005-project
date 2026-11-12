// PROTOTYPE, throwaway (respergu/cohort-005-project#24). Never merge to main.
// The full-page Notification Feed for variant B ("Inbox page").
import { VariantBInboxPage } from "~/components/notification-feed-prototype";

export function meta() {
  return [{ title: "Notifications — Cadence" }];
}

export default function NotificationsPrototype() {
  return <VariantBInboxPage />;
}
