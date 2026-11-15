import type {
  KnockTrigger,
  NotificationTransport,
} from "~/lib/notification-transports.server";

/**
 * An in-memory transport for sender tests. It records every attempt and every
 * trigger it accepts, and throws `failWith`'s error until told to `recover`.
 */
export function fakeNotificationTransport() {
  const attempts: KnockTrigger[] = [];
  const accepted: KnockTrigger[] = [];
  let failure: Error | null = null;

  const transport: NotificationTransport & {
    attempts: KnockTrigger[];
    accepted: KnockTrigger[];
    failWith(error: Error): void;
    recover(): void;
  } = {
    attempts,
    accepted,
    failWith(error) {
      failure = error;
    },
    recover() {
      failure = null;
    },
    async send(trigger) {
      attempts.push(trigger);
      if (failure) throw failure;
      accepted.push(trigger);
    },
  };

  return transport;
}
