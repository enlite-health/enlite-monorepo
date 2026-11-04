/**
 * useLuzPrueba — state of the "Luz (prueba)" tab (spec 086, RF-1..5).
 * The history lives HERE (the tab's session, DF-4): each turn sends the last 10 sent turns, never the current message.
 * `reset` clears the messages and draws a NEW `sessao`: the next message is turn 0. A reply that arrives for a
 * session that was already reset is dropped.
 */
import { useCallback, useRef, useState } from "react";
import { AdminLuzPruebaApiService } from "@infrastructure/http/AdminLuzPruebaApiService";
import {
  LuzPruebaError,
  type LuzPruebaHistoryTurn,
  type LuzPruebaMessage,
} from "@domain/entities/LuzPrueba";

export const HISTORY_LIMIT = 10;
const HISTORY_CONTENT_MAX = 4000;

/** i18n key (under `admin.luzPrueba.`) of each error notice. */
export type LuzPruebaNotice = "cap" | "unavailable" | "noAccess" | "genericError";

export interface LuzPruebaNoticeState {
  key: LuzPruebaNotice;
  limite?: number;
}

/** `[A-Za-z0-9_-]`, 32 chars (<= 40): safe for the header `prueba:<uid>:<sessao>#turno-N`. */
export function newSessionId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export function noticeOfError(e: unknown): LuzPruebaNoticeState {
  if (!(e instanceof LuzPruebaError)) return { key: "genericError" };
  switch (e.codigo) {
    case "TETO_DIARIO":
      return { key: "cap", limite: e.limite };
    case "TRIAGE_INDISPONIVEL":
      return { key: "unavailable" };
    case "NO_ACCESS":
      return { key: "noAccess" };
    default:
      return { key: "genericError" };
  }
}

export interface UseLuzPrueba {
  sessao: string;
  messages: LuzPruebaMessage[];
  waiting: boolean;
  notice: LuzPruebaNoticeState | null;
  /** Synthetic provider's name; null until the first answer. */
  prestadora: string | null;
  /** Resolves `{ ok: false }` when the turn failed: the message was taken off the screen (the caller gives the text back to the box). */
  send: (text: string) => Promise<{ ok: boolean }>;
  reset: () => void;
}

export function useLuzPrueba(): UseLuzPrueba {
  const [sessao, setSessao] = useState(newSessionId);
  const [messages, setMessages] = useState<LuzPruebaMessage[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [notice, setNotice] = useState<LuzPruebaNoticeState | null>(null);
  const [prestadora, setPrestadora] = useState<string | null>(null);
  const seq = useRef(0);
  const sessaoRef = useRef(sessao);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const waitingRef = useRef(false);

  const send = useCallback(async (text: string) => {
    const mensagem = text.trim();
    if (!mensagem || waitingRef.current) return { ok: true };
    const mySession = sessaoRef.current;
    const historico: LuzPruebaHistoryTurn[] = messagesRef.current
      .filter((m) => m.role === "user" || m.kind === "reply")
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content.slice(0, HISTORY_CONTENT_MAX) }));
    const mine: LuzPruebaMessage = {
      id: `u-${++seq.current}`,
      role: "user",
      content: mensagem,
      kind: "reply",
      ferramentas: [],
      validadores: [],
    };
    setMessages((l) => [...l, mine]);
    setNotice(null);
    waitingRef.current = true;
    setWaiting(true);
    let ok = true;
    try {
      const r = await AdminLuzPruebaApiService.turn({ sessao: mySession, mensagem, historico });
      if (sessaoRef.current !== mySession) return { ok: true }; // reset while waiting: the answer belongs to a dead session
      setPrestadora(r.prestadora?.nome ?? null);
      setMessages((l) => [
        ...l,
        {
          id: `a-${++seq.current}`,
          role: "assistant",
          content: r.texto ?? "",
          kind: r.tipo,
          motivo: r.motivo,
          ferramentas: r.ferramentas ?? [],
          validadores: r.validadores ?? [],
        },
      ]);
    } catch (e) {
      if (sessaoRef.current === mySession) {
        ok = false;
        setNotice(noticeOfError(e));
        setMessages((l) => l.filter((m) => m.id !== mine.id));
      }
    } finally {
      if (sessaoRef.current === mySession) {
        waitingRef.current = false;
        setWaiting(false);
      }
    }
    return { ok };
  }, []);

  const reset = useCallback(() => {
    const next = newSessionId();
    sessaoRef.current = next;
    waitingRef.current = false;
    setSessao(next);
    setMessages([]);
    setNotice(null);
    setPrestadora(null);
    setWaiting(false);
  }, []);

  return { sessao, messages, waiting, notice, prestadora, send, reset };
}
