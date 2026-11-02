/**
 * useAssistants — state of the assistants chat widget (spec 080, phase A).
 * `list()` is already filtered by reach in the service: an empty list (or any failure) = the widget does not exist (fail-closed).
 * The tab (active assistant) is remembered in `localStorage` (`assistants.tab`), always inside try/catch.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminAuthStore } from "@presentation/stores/adminAuthStore";
import { AdminAssistantsApiService } from "@infrastructure/http/AdminAssistantsApiService";
import {
  AssistantError,
  type Assistant,
  type AssistantMessage,
} from "@domain/entities/Assistant";

export const TAB_STORAGE_KEY = "assistants.tab";

/** i18n key (under `admin.assistants.`) of each error notice. */
export type AssistantNotice =
  "cap"
  | "noAccess"
  | "modelError"
  | "unavailableError"
  | "inputClinical"
  | "genericError";

export function noticeOfError(e: unknown): AssistantNotice {
  if (!(e instanceof AssistantError)) return "genericError";
  switch (e.code) {
    case "PERSON_DAILY_CAP":
    case "ASSISTANT_MONTHLY_CAP":
      return "cap";
    case "INPUT_CLINICAL":
      return "inputClinical";
    case "NO_REACH":
      return "noAccess";
    case "MODEL_ERROR":
      return "modelError";
    case "ASSISTANT_UNAVAILABLE":
      return "unavailableError";
    default:
      return "genericError";
  }
}

function readTab(): string | null {
  try {
    return window.localStorage.getItem(TAB_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeTab(slug: string): void {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, slug);
  } catch {
    /* no storage (private window): the tab is just not remembered */
  }
}

export interface UseAssistants {
  assistants: Assistant[];
  active: Assistant | null;
  setTab: (slug: string) => void;
  messages: AssistantMessage[];
  waiting: boolean;
  notice: AssistantNotice | null;
  /** The active assistant's history failed to load (shown as a notice; NOT an empty conversation). */
  historyError: boolean;
  /** Sum of the service's `unread_count` over the AVAILABLE assistants in the reach. */
  unreadTotal: number;
  /** Resolves `{ refused: true }` when the server refused the INPUT (clinical/personal data): the message was not stored. */
  send: (text: string) => Promise<{ refused: boolean }>;
  /** Marks the assistant's conversation as read; on 204 zeroes ITS badge. A failure (403/5xx) changes nothing. */
  markRead: (slug: string) => Promise<void>;
  /** Loads the active assistant's history (called when the panel opens or the tab changes). */
  loadConversation: () => void;
}

export function useAssistants(): UseAssistants {
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [tabSlug, setTabSlug] = useState<string | null>(() => readTab());
  const [bySlug, setBySlug] = useState<Record<string, AssistantMessage[]>>({});
  const [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState<AssistantNotice | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const seq = useRef(0);

  // Group simulation (spec 026) changes who the actor is for the backend: re-read the list on start / switch / end.
  const simulationGroupId = useAdminAuthStore((s) => s.authz?.simulation?.groupId ?? null);

  useEffect(() => {
    let alive = true;
    // Fail-closed: the previous identity's assistants/conversations must not stay on screen while the new list loads.
    setAssistants([]);
    setBySlug({});
    AdminAssistantsApiService.list()
      .then((l) => alive && setAssistants(l))
      .catch(() => alive && setAssistants([]));
    return () => {
      alive = false;
    };
  }, [simulationGroupId]);

  const active =
    assistants.find((a) => a.slug === tabSlug) ?? assistants[0] ?? null;

  const setTab = useCallback((slug: string) => {
    writeTab(slug);
    setTabSlug(slug);
    setNotice(null);
    setHistoryError(false);
  }, []);

  const loadConversation = useCallback(() => {
    if (!active || !active.available) return;
    const slug = active.slug;
    setHistoryError(false);
    AdminAssistantsApiService.messages(slug)
      // Does not trample what the person already sent while the history was arriving (send × load race).
      .then((p) =>
        setBySlug((m) => (m[slug]?.length ? m : { ...m, [slug]: p.messages })),
      )
      // A failed load is shown, never mistaken for an empty conversation (no content is logged).
      .catch(() => setHistoryError(true));
  }, [active]);

  const markRead = useCallback(async (slug: string) => {
    try {
      await AdminAssistantsApiService.markRead(slug);
    } catch {
      return; // the badge stays; the screen keeps working
    }
    setAssistants((l) =>
      l.map((x) => (x.slug === slug ? { ...x, unread_count: 0 } : x)),
    );
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (!active || !active.available || !text.trim()) return { refused: false };
      const slug = active.slug;
      const local: AssistantMessage = {
        id: `local-${++seq.current}`,
        author: "PERSON",
        text,
        tools: [],
        validator: null,
        created_at: new Date().toISOString(),
      };
      setBySlug((m) => ({ ...m, [slug]: [...(m[slug] ?? []), local] }));
      setNotice(null);
      setWaiting(true);
      try {
        const r = await AdminAssistantsApiService.sendMessage(slug, text);
        setBySlug((m) => ({
          ...m,
          [slug]: [...(m[slug] ?? []), r.message],
        }));
        // The reply arrived with the tab open: it is read, so the server marker advances.
        void markRead(slug);
        return { refused: false };
      } catch (e) {
        const n = noticeOfError(e);
        setNotice(n);
        // The server did not store a refused input: it must not stay in the history as if it had been sent.
        const refused = n === "inputClinical";
        if (refused) {
          setBySlug((m) => ({
            ...m,
            [slug]: (m[slug] ?? []).filter((x) => x.id !== local.id),
          }));
        }
        return { refused };
      } finally {
        setWaiting(false);
      }
    },
    [active, markRead],
  );

  return {
    assistants,
    active,
    setTab,
    messages: active ? (bySlug[active.slug] ?? []) : [],
    waiting,
    notice,
    historyError,
    unreadTotal: assistants.reduce(
      (s, a) => (a.available ? s + a.unread_count : s),
      0,
    ),
    send,
    markRead,
    loadConversation,
  };
}
