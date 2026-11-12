// PROTOTYPE, throwaway (respergu/cohort-005-project#24). Never merge to main.
//
// Three variants of the Notification Feed in the real app layout, switchable
// via ?variant=A|B|C and the floating bar at the bottom.
//   A  Bell popover     bell in the sidebar header, unread count, popover
//                       (the winner; its badge was switched to unread)
//   B  Inbox page       sidebar nav item, unread count, /notifications page
//   C  Activity drawer  bell by the avatar, dot only, right drawer + toasts
import { useEffect } from "react";
import { useFetcher } from "react-router";
import { Send } from "lucide-react";
import { toast } from "sonner";
import {
  PrototypeSwitcher,
  usePrototypeVariant,
} from "~/components/prototype-switcher";
import { useNotificationFeed } from "./feed";
import * as A from "./variant-a-bell-popover";
import * as B from "./variant-b-inbox";
import * as C from "./variant-c-drawer";

export { NotificationFeedProvider, type FeedClientConfig } from "./feed";
export { VariantBInboxPage } from "./variant-b-inbox";

const variants = [
  { key: "A", name: A.name },
  { key: "B", name: B.name },
  { key: "C", name: C.name },
];

export function useNotificationFeedVariant() {
  const { current, select } = usePrototypeVariant(variants);
  return {
    current,
    select,
    sidebar: {
      headerAccessory: current.key === "A" ? <A.VariantAHeaderBell /> : null,
      navAccessory: current.key === "B" ? <B.VariantBNavItem /> : null,
      userAccessory: current.key === "C" ? <C.VariantCUserBell /> : null,
    },
  };
}

export function NotificationFeedSwitcher({
  current,
  select,
  enabled,
}: {
  current: { key: string; name: string };
  select: (key: string) => void;
  enabled: boolean;
}) {
  return (
    <PrototypeSwitcher
      label="Feed"
      variants={variants}
      current={current}
      onSelect={select}
    >
      {enabled && <SendTestNotification />}
    </PrototypeSwitcher>
  );
}

function SendTestNotification() {
  const fetcher = useFetcher<{ ok: boolean; kind?: string; error?: string }>();
  const feed = useNotificationFeed();

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      feed.refreshSoon();
    } else {
      toast.error(`Test Notification failed: ${fetcher.data.error}`);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <fetcher.Form method="post" action="/api/notification-feed-prototype">
      <button
        type="submit"
        disabled={fetcher.state !== "idle"}
        title="Trigger a random catalogue Notification to yourself through Knock (counts toward the 10K/month)"
        className="ml-1 flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20 disabled:opacity-50"
      >
        <Send className="size-3.5" />
        {fetcher.state !== "idle" ? "Sending…" : "Send me one"}
      </button>
    </fetcher.Form>
  );
}
