/**
 * LuzPruebaTab — body of the "Luz (prueba)" tab (spec 086): the person talks as the SYNTHETIC provider with the real Luz.
 * Fixed header (RF-2), the same composer as the Maria tab (RF-3), tools and validators as a discreet line under each
 * answer (no clinical text), a simulated handover block (RF-4), "Reiniciar conversa" (RF-5). Nothing here leaves to WhatsApp.
 * State lives in `useLuzPrueba` (owned by the panel, so switching tabs keeps the conversation).
 */
import { useLayoutEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LuzPruebaMessage } from "@domain/entities/LuzPrueba";
import type { UseLuzPrueba } from "@presentation/hooks/useLuzPrueba";
import { AssistantsComposer } from "./AssistantsComposer";
import { bubbleClass } from "./assistantsStyles";

const MAX_MESSAGE = 1000;
const meta = "text-[10.5px] leading-snug text-[#404040]";

function ToolsLine({ m }: { m: LuzPruebaMessage }) {
  const { t } = useTranslation();
  if (m.ferramentas.length === 0 && m.validadores.length === 0) return null;
  return (
    <div data-testid="luz-prueba-tools" className={`grid gap-0.5 ${meta}`}>
      {m.ferramentas.map((f, i) => (
        <span key={`${f.nome}-${i}`}>
          {t(`admin.luzPrueba.tool${f.prueba ? "Write" : "Read"}${f.ok ? "Ok" : "Fail"}`, { nome: f.nome })}
        </span>
      ))}
      {m.validadores.length > 0 && (
        <span>{t("admin.luzPrueba.validators", { lista: m.validadores.join(", ") })}</span>
      )}
    </div>
  );
}

function Message({ m }: { m: LuzPruebaMessage }) {
  const { t } = useTranslation();
  const fromPerson = m.role === "user";
  let body: string;
  if (fromPerson || m.kind === "reply") body = m.content;
  else if (m.kind === "handover_simulado")
    body = t("admin.luzPrueba.handover", {
      motivo: m.motivo || t("admin.luzPrueba.noReason"),
    });
  else body = t("admin.luzPrueba.skip");
  const discreet = !fromPerson && m.kind === "skip";
  return (
    <div className={`grid gap-1 ${fromPerson ? "justify-items-end" : "justify-items-start"}`}>
      <div
        data-testid="luz-prueba-msg"
        data-role={m.role}
        data-kind={fromPerson ? undefined : m.kind}
        className={discreet ? `justify-self-start ${meta}` : bubbleClass(fromPerson)}
      >
        {body}
      </div>
      {!fromPerson && <ToolsLine m={m} />}
    </div>
  );
}

export function LuzPruebaTab({ state: s }: { state: UseLuzPrueba }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Always show the last message (same rule as the Maria tab).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.messages.length, s.waiting, s.notice]);

  const submit = async () => {
    if (s.waiting || !draft.trim()) return;
    const v = draft;
    setDraft("");
    const r = await s.send(v);
    // A failed turn gives the text back (unless the person already typed something else).
    if (!r.ok) setDraft((cur) => cur || v);
  };

  const noticeText = s.notice
    ? t(`admin.luzPrueba.${s.notice.key}`, { limite: s.notice.limite })
    : null;

  return (
    <>
      <div
        data-testid="luz-prueba-header"
        className="border-b border-gray-300 bg-[#EEE9F6] px-3 py-2 text-[11px] font-semibold leading-snug text-[#262626]"
      >
        {s.prestadora
          ? t("admin.luzPrueba.header", { nome: s.prestadora })
          : t("admin.luzPrueba.headerGeneric")}
      </div>
      <div
        ref={listRef}
        data-testid="luz-prueba-messages"
        aria-live="polite"
        className="grid flex-1 grid-cols-[minmax(0,1fr)] content-start gap-[10px] overflow-y-auto px-3 pb-1 pt-3 text-[12.5px] leading-[1.45]"
      >
        {s.messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {s.waiting && (
          <div
            data-testid="luz-prueba-typing"
            role="status"
            aria-label={t("admin.assistants.typing")}
            className="flex w-max gap-1 justify-self-start rounded-[14px] rounded-bl-[4px] bg-gray-200 px-3 py-2.5"
          >
            {[0, 1, 2].map((i) => (
              <i
                key={i}
                aria-hidden="true"
                style={{ animationDelay: `${i * 0.2}s` }}
                className="block h-1.5 w-1.5 rounded-full bg-[#404040] opacity-60 motion-safe:animate-typing-dot"
              />
            ))}
          </div>
        )}
        {noticeText && (
          <p role="alert" data-testid="luz-prueba-notice" className="text-[#262626]">
            {noticeText}
          </p>
        )}
      </div>
      <AssistantsComposer
        value={draft}
        onChange={setDraft}
        onSubmit={() => void submit()}
        focusKey={s.sessao}
        sendDisabled={s.waiting || !draft.trim()}
        maxLength={MAX_MESSAGE}
        testIdInput="luz-prueba-input"
        testIdSend="luz-prueba-send"
      />
      <div className="flex justify-center px-3 pb-2">
        <button
          type="button"
          data-testid="luz-prueba-reset"
          onClick={() => {
            setDraft("");
            s.reset();
          }}
          className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-[#404040] underline-offset-2 hover:underline"
        >
          <RotateCcw size={11} aria-hidden="true" />
          {t("admin.luzPrueba.reset")}
        </button>
      </div>
    </>
  );
}
