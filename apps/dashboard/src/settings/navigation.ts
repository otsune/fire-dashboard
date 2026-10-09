import { useEffect, useRef, useState } from "react";

export type SettingsSection = "rss" | "usage" | "weather" | "clock_audio";
export type SettingsGuard = { dirty: boolean; saving: boolean };
type Transition = SettingsSection | "close";
type Entry = { id: string; section: SettingsSection; openerId: string };
const entryKey = "fireDashboardSettings";
const sections: SettingsSection[] = ["rss", "usage", "weather", "clock_audio"];
let nextId = 0;

function readEntry(state: unknown): Entry | null {
  if (!state || typeof state !== "object") return null;
  const entry = (state as Record<string, unknown>)[entryKey];
  if (!entry || typeof entry !== "object") return null;
  const { id, section, openerId } = entry as Partial<Entry>;
  return typeof id === "string" &&
    typeof openerId === "string" &&
    sections.includes(section as SettingsSection)
    ? { id, section: section as SettingsSection, openerId }
    : null;
}

export function useSettingsNavigation(guard: SettingsGuard) {
  const [initial] = useState(() => readEntry(window.history.state));
  const [section, setSection] = useState<SettingsSection | null>(
    initial?.section ?? null,
  );
  const [pending, setPending] = useState<Transition | null>(null);
  const current = useRef(section);
  const pendingRef = useRef<Transition | null>(null);
  const guardRef = useRef(guard);
  const opener = useRef(initial?.openerId ?? "");
  const entryId = useRef(initial?.id ?? `${Date.now()}-${++nextId}`);
  // Back cancellation restores the existing entry with Forward, never pushState.
  const flight = useRef<"closing" | "restoring" | null>(null);
  const discardedClose = useRef(false);
  const afterRestore = useRef<Transition | null>(null);
  guardRef.current = guard;

  const commitSection = (next: SettingsSection | null) => {
    current.current = next;
    setSection(next);
  };
  const updatePending = (next: Transition | null) => {
    pendingRef.current = next;
    setPending(next);
  };
  const entryState = (next: SettingsSection) => ({
    ...(window.history.state && typeof window.history.state === "object"
      ? window.history.state
      : {}),
    [entryKey]: {
      id: entryId.current,
      section: next,
      openerId: opener.current,
    } satisfies Entry,
  });
  const commit = (target: Transition, discarded = false) => {
    if (target === "close") {
      if (flight.current) return;
      flight.current = "closing";
      discardedClose.current = discarded;
      window.history.back();
    } else {
      window.history.replaceState(entryState(target), "");
      commitSection(target);
    }
  };
  const request = (target: Transition) => {
    if (
      !current.current ||
      target === current.current ||
      guardRef.current.saving ||
      pendingRef.current ||
      flight.current
    )
      return;
    if (guardRef.current.dirty) updatePending(target);
    else commit(target);
  };
  const open = (next: SettingsSection, openerId: string) => {
    if (current.current) {
      request(next);
      return;
    }
    if (guardRef.current.saving || flight.current) return;
    opener.current = openerId;
    window.history.pushState(entryState(next), "");
    commitSection(next);
  };
  const discardPending = () => {
    if (!pendingRef.current || guardRef.current.saving) return;
    const target = pendingRef.current;
    updatePending(null);
    if (flight.current === "restoring") afterRestore.current = target;
    else commit(target, true);
  };
  const keepEditing = () => {
    afterRestore.current = null;
    updatePending(null);
  };
  // Event listeners read refs so repeated events cannot race a React render.
  useEffect(() => {
    const pop = (event: PopStateEvent) => {
      const entry = readEntry(event.state);
      // A closed remount has no active entry to protect. Forward may restore
      // an earlier instance's valid marker; adopt its identity and opener.
      if (entry && (!current.current || entry.id === entryId.current)) {
        const restoring = flight.current === "restoring";
        flight.current = null;
        discardedClose.current = false;
        entryId.current = entry.id;
        opener.current = entry.openerId;
        commitSection(entry.section);
        if (restoring && afterRestore.current) {
          const target = afterRestore.current;
          afterRestore.current = null;
          if (!guardRef.current.saving) commit(target, true);
          else updatePending(target);
        }
        return;
      }
      if (!current.current) return;
      // A queued Back may run before our Forward, and a Forward may only reach
      // an older predecessor. Keep converging until our actual entry is seen,
      // even if the user canceled or a save finished during restoration.
      if (flight.current === "restoring") {
        window.history.forward();
        return;
      }
      if (
        !guardRef.current.saving &&
        (!guardRef.current.dirty || discardedClose.current)
      ) {
        flight.current = null;
        discardedClose.current = false;
        updatePending(null);
        commitSection(null);
        return;
      }
      discardedClose.current = false;
      if (
        guardRef.current.dirty &&
        !guardRef.current.saving &&
        !pendingRef.current
      )
        updatePending("close");
      flight.current = "restoring";
      window.history.forward();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && current.current) {
        event.preventDefault();
        request("close");
      }
    };
    window.addEventListener("popstate", pop);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("popstate", pop);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  const previouslyOpen = useRef(false);
  useEffect(() => {
    if (section)
      document.getElementById(`settings-heading-${section}`)?.focus();
    else if (previouslyOpen.current)
      document.getElementById(opener.current)?.focus();
    previouslyOpen.current = section !== null;
  }, [section]);

  return {
    section,
    pending,
    open,
    select: (next: SettingsSection) => request(next),
    close: () => request("close"),
    discardPending,
    keepEditing,
  };
}
