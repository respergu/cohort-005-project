import { useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "~/lib/utils";
import { connectKnock, type KnockClientConfig } from "~/lib/knock-browser";
import {
  createNotificationPreferences,
  preferenceRowsFor,
  type ChannelChoices,
  type MutableCategory,
  type MutableRow,
  type NotificationPreferences as Preferences,
  type PreferenceChannel,
  type PreferenceChoices,
  type PreferencePerson,
} from "~/lib/notification-preferences";

// ─── The Notifications section on /settings ───
// One row per kind of Notification the person can get, with a Notification
// Feed toggle and, where email is offered, an email toggle. Reads and saves
// go straight to Knock from the browser with the bell's token. Each toggle
// saves its row at once; nothing else changes.

const CHANNEL_NAMES: Record<PreferenceChannel, string> = {
  in_app_feed: "Feed",
  email: "Email",
};

type Loaded =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; choices: PreferenceChoices };

export function NotificationPreferences({
  config,
  person,
}: {
  /** The layout's Knock config. Null when Knock isn't set up. */
  config: KnockClientConfig | null;
  person: PreferencePerson;
}) {
  const rows = preferenceRowsFor(person);
  const { preferences, loaded, setChoices } = usePreferences(config);
  const [saving, setSaving] = useState<ReadonlySet<MutableCategory>>(new Set());

  async function toggle(
    category: MutableCategory,
    channel: PreferenceChannel,
    on: boolean
  ) {
    if (!preferences || loaded.status !== "ready") return;
    const before = loaded.choices[category];
    const after: ChannelChoices = { ...before, [channel]: on };
    setChoices(category, after);
    setSaving((current) => new Set(current).add(category));
    const result = await preferences.save(category, after);
    setSaving((current) => {
      const next = new Set(current);
      next.delete(category);
      return next;
    });
    if (result === "error") {
      setChoices(category, before);
      toast.error("That change couldn't be saved. Try again in a moment.");
    }
  }

  return (
    <div className="divide-y">
      <div className="flex items-end justify-end gap-2 pb-2 text-xs font-medium text-muted-foreground">
        {(["in_app_feed", "email"] as const).map((channel) => (
          <span key={channel} className="w-12 text-center">
            {CHANNEL_NAMES[channel]}
          </span>
        ))}
      </div>
      {rows.map((row) =>
        row.locked ? (
          <div key={row.category} className="flex items-start gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Lock className="size-3.5 text-muted-foreground" aria-hidden />
                {row.readOnly}
              </p>
              <p className="text-xs text-muted-foreground">
                {row.description} These are about your money, so they can't be
                muted.
              </p>
            </div>
          </div>
        ) : (
          <MutableRowToggles
            key={row.category}
            row={row}
            choice={
              loaded.status === "ready" ? loaded.choices[row.category] : null
            }
            disabled={loaded.status !== "ready" || saving.has(row.category)}
            onToggle={toggle}
          />
        )
      )}
      {loaded.status === "error" && (
        <p className="pt-3 text-sm text-muted-foreground">
          Your Notification settings couldn't be loaded. Try again in a moment.
        </p>
      )}
    </div>
  );
}

function MutableRowToggles({
  row,
  choice,
  disabled,
  onToggle,
}: {
  row: MutableRow;
  /** Null until Knock answers. */
  choice: ChannelChoices | null;
  disabled: boolean;
  onToggle: (
    category: MutableCategory,
    channel: PreferenceChannel,
    on: boolean
  ) => void;
}) {
  return (
    <div className="flex items-start gap-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{row.label}</p>
        <p className="text-xs text-muted-foreground">
          {row.description}
          {row.emailNote && ` ${row.emailNote}`}
        </p>
      </div>
      {(["in_app_feed", "email"] as const).map((channel) => (
        <div key={channel} className="flex w-12 justify-center pt-0.5">
          {row.channels.includes(channel) ? (
            <Toggle
              label={`${row.label}: ${CHANNEL_NAMES[channel]}`}
              checked={choice?.[channel] ?? false}
              disabled={disabled}
              onChange={(on) => onToggle(row.category, channel, on)}
            />
          ) : (
            <span
              className="text-xs text-muted-foreground"
              title="Not sent by email"
            >
              –
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Switch.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        "bg-input data-[state=checked]:bg-primary"
      )}
    >
      <Switch.Thumb className="pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </Switch.Root>
  );
}

/**
 * One Knock connection for as long as the section is mounted, and the
 * person's choices once Knock answers. The connection keeps and refreshes its
 * own token, so a later config from the layout is ignored. The section is
 * keyed on the Knock id, so a new user starts again.
 */
function usePreferences(config: KnockClientConfig | null) {
  const [firstConfig] = useState(config);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loaded, setLoaded] = useState<Loaded>(
    config ? { status: "loading" } : { status: "error" }
  );

  useEffect(() => {
    if (!firstConfig) return;
    let current = true;
    const connection = connectKnock(firstConfig);
    const next = createNotificationPreferences(connection);
    setPreferences(next);
    void next.load().then((result) => {
      if (current) setLoaded(result);
    });
    return () => {
      current = false;
      connection.disconnect();
    };
  }, [firstConfig]);

  function setChoices(category: MutableCategory, choice: ChannelChoices) {
    setLoaded((state) =>
      state.status === "ready"
        ? { ...state, choices: { ...state.choices, [category]: choice } }
        : state
    );
  }

  return { preferences, loaded, setChoices };
}
