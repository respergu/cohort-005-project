import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Knock, { APIError, type ClientOptions } from "@knocklabs/node";
import type { NotificationData, NotificationUser } from "~/db/schema";

// ─── Notification transports ───
// The sender hands each outbox row to a transport, the way sendEmail hands
// each email to a MailTransport (mailer.server.ts). A transport either
// accepts the trigger or throws.

/** One whole Knock trigger, exactly as Knock receives it. */
export type KnockTrigger = {
  workflow: string;
  recipients: NotificationUser[];
  actor: NotificationUser | null;
  data: NotificationData;
  idempotencyKey: string;
};

export interface NotificationTransport {
  send(trigger: KnockTrigger): Promise<void>;
}

/**
 * Triggers the workflow in Knock, with the row's UUID as the idempotency key,
 * so a retried send never reaches anyone twice. `options` is for tests.
 */
export function knockTransport(
  apiKey: string,
  options: Pick<ClientOptions, "fetch"> = {}
): NotificationTransport {
  const knock = new Knock({
    apiKey,
    // The outbox owns retries: a failed send stays waiting for the sweep.
    maxRetries: 0,
    timeout: 10_000,
    ...options,
  });

  return {
    async send(trigger) {
      await knock.workflows.trigger(
        trigger.workflow,
        {
          recipients: trigger.recipients,
          actor: trigger.actor,
          data: trigger.data,
        },
        { idempotencyKey: trigger.idempotencyKey }
      );
    },
  };
}

/**
 * Whether a failed send might pass if it's tried again: a 408 or 429, a 5xx,
 * a timeout or a network failure. Any other 4xx means Knock rejected the
 * trigger outright. A throw that isn't a Knock response, such as a folder
 * write that failed, counts as one that might pass.
 */
export function mightPassOnRetry(error: unknown): boolean {
  // Timeouts and network failures are APIErrors without a status.
  if (!(error instanceof APIError) || typeof error.status !== "number") {
    return true;
  }
  const { status } = error;
  return status === 408 || status === 429 || status < 400 || status >= 500;
}

/**
 * A failed send for a log line: Knock's status and response body, or why
 * there was no response.
 */
export function describeSendFailure(error: unknown): string {
  if (error instanceof APIError && typeof error.status === "number") {
    return `Knock answered ${error.status} ${JSON.stringify(error.error)}`;
  }
  return error instanceof Error
    ? `no response from Knock: ${error.message}`
    : `it threw ${String(error)}`;
}

/**
 * Writes each trigger to `directory` as one JSON file instead of sending it,
 * so a developer can read exactly what Knock would have received. Never used
 * in Production.
 */
export function folderTransport(directory: string): NotificationTransport {
  return {
    async send(trigger) {
      mkdirSync(directory, { recursive: true });
      const file = join(
        directory,
        `${Date.now()}-${trigger.workflow}-${trigger.idempotencyKey}.json`
      );
      writeFileSync(file, JSON.stringify(trigger, null, 2));
    },
  };
}

// ─── The send switch ───
// See "The send switch" in PRD #37 and #30.

export type TransportChoice =
  | { kind: "knock"; apiKey: string }
  | { kind: "folder"; directory: string };

export type SenderEnv = {
  NODE_ENV?: string;
  KNOCK_TRIGGERS?: string;
  KNOCK_API_KEY?: string;
};

export const NOTIFICATIONS_FOLDER = ".outbox/notifications";

/** Which transport the server sends through, from its environment. */
export function chooseTransport(
  env: SenderEnv,
  warn: (message: string) => void = console.warn
): TransportChoice {
  const production = env.NODE_ENV === "production";

  // Production never falls back to the folder: a misconfigured deploy would
  // silently drop every Notification.
  if (production && env.KNOCK_TRIGGERS !== "on") {
    throw new Error(
      "Refusing to start: Production must send Notifications to Knock. Set KNOCK_TRIGGERS=on and KNOCK_API_KEY."
    );
  }

  // Only the switch turns sending on. The keys alone aren't enough: they stay
  // in .env for the bell and /settings, whose calls Knock doesn't bill.
  if (env.KNOCK_TRIGGERS !== "on") {
    return { kind: "folder", directory: NOTIFICATIONS_FOLDER };
  }

  if (!env.KNOCK_API_KEY) {
    throw new Error(
      "Refusing to start: KNOCK_TRIGGERS=on sends Notifications to Knock, but KNOCK_API_KEY is missing."
    );
  }

  if (!production) {
    warn(
      "KNOCK_TRIGGERS=on: Notifications are going to Knock and spending the monthly budget of 10,000 messages."
    );
  }
  return { kind: "knock", apiKey: env.KNOCK_API_KEY };
}

export function createTransport(choice: TransportChoice): NotificationTransport {
  return choice.kind === "knock"
    ? knockTransport(choice.apiKey)
    : folderTransport(choice.directory);
}
