// PROTOTYPE tooling, throwaway (respergu/cohort-005-project#24). A floating
// bar that flips between UI variants via ?variant=. Dev builds only.
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

export type PrototypeVariant = { key: string; name: string };

const STICKY_KEY = "prototype-variant";

// ?variant= is the source of truth. Sidebar links drop the query string, so
// the last choice is re-applied from sessionStorage after a navigation.
export function usePrototypeVariant(variants: PrototypeVariant[]) {
  const [searchParams, setSearchParams] = useSearchParams();
  const fromUrl = searchParams.get("variant");
  const current = variants.find((v) => v.key === fromUrl);

  useEffect(() => {
    try {
      if (current) {
        sessionStorage.setItem(STICKY_KEY, current.key);
        return;
      }
      const stored = sessionStorage.getItem(STICKY_KEY);
      if (stored && variants.some((v) => v.key === stored)) {
        setSearchParams(
          (prev) => {
            prev.set("variant", stored);
            return prev;
          },
          { replace: true, preventScrollReset: true }
        );
      }
    } catch {}
  }, [current?.key]);

  const select = (key: string) =>
    setSearchParams(
      (prev) => {
        prev.set("variant", key);
        return prev;
      },
      { replace: true, preventScrollReset: true }
    );

  return { current: current ?? variants[0], select };
}

export function PrototypeSwitcher({
  label,
  variants,
  current,
  onSelect,
  children,
}: {
  label: string;
  variants: PrototypeVariant[];
  current: PrototypeVariant;
  onSelect: (key: string) => void;
  children?: React.ReactNode;
}) {
  const index = variants.findIndex((v) => v.key === current.key);
  const step = (delta: number) =>
    onSelect(variants[(index + delta + variants.length) % variants.length].key);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      )
        return;
      if (document.querySelector("[role=dialog]")) return;
      step(e.key === "ArrowLeft" ? -1 : 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env.DEV) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-1 rounded-full bg-zinc-900 p-1 text-sm text-white shadow-2xl ring-1 ring-white/10">
      <span className="pl-3 pr-1 text-[10px] font-bold uppercase tracking-widest text-amber-300">
        {label}
      </span>
      <button
        onClick={() => step(-1)}
        aria-label="Previous variant"
        className="rounded-full p-1.5 hover:bg-white/10"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-40 text-center font-medium tabular-nums">
        {current.key} <span className="text-white/60">({current.name})</span>
      </span>
      <button
        onClick={() => step(1)}
        aria-label="Next variant"
        className="rounded-full p-1.5 hover:bg-white/10"
      >
        <ChevronRight className="size-4" />
      </button>
      {children}
    </div>
  );
}
