import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "@knocklabs/node";
import type {
  KnockTrigger,
  NotificationTransport,
} from "~/lib/notification-transports.server";

/**
 * An in-memory transport for sender tests. It records every attempt and every
 * trigger it accepts. Told to fail, it throws on every send until told to
 * `recover`, with the same errors the Knock SDK throws.
 */
export function fakeNotificationTransport() {
  const attempts: KnockTrigger[] = [];
  const accepted: KnockTrigger[] = [];
  let failure: Error | null = null;

  const transport: NotificationTransport & {
    attempts: KnockTrigger[];
    accepted: KnockTrigger[];
    failWith(error: Error): void;
    respondWith(status: number, body?: object): void;
    timeOut(): void;
    loseConnection(): void;
    recover(): void;
  } = {
    attempts,
    accepted,
    failWith(error) {
      failure = error;
    },
    /** Knock answers with this non-2xx status and body. */
    respondWith(status, body = knockErrorBody(status)) {
      failure = APIError.generate(status, body, undefined, new Headers());
    },
    /** The request runs past the Knock client's timeout. */
    timeOut() {
      failure = new APIConnectionTimeoutError();
    },
    /** The request never reaches Knock. */
    loseConnection() {
      failure = new APIConnectionError({
        cause: new Error("getaddrinfo ENOTFOUND api.knock.app"),
      });
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

export type FakeNotificationTransport = ReturnType<
  typeof fakeNotificationTransport
>;

/** The shape of Knock's error bodies: `{ code, message, status, type }`. */
function knockErrorBody(status: number) {
  return {
    code: `http_${status}`,
    message: `Knock answered ${status}.`,
    status,
    type: "api_error",
  };
}
