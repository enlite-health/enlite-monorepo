/**
 * AssistantsPanel — 356x480 panel (phone: full screen), same as the approved mockup: header with the assistant
 * (a list picker if > 1), conversation, one-line composer and a footer line. Always scrolled to the last message.
 * Colors: text #262626, secondary/placeholder #404040 (>= 7:1 on white, #F7F7F7 and #EEE9F6), "disponible" #14532D (>= 7:1).
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { ChevronDown, Lock, Minus, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PersonAvatar } from "@presentation/components/atoms/PersonAvatar";
import { MessageMarkdown } from "@presentation/components/shared/MessageMarkdown/MessageMarkdown";
import { AssistantsComposer } from "./AssistantsComposer";
import { LuzPruebaTab } from "./LuzPruebaTab";
import { ASSISTANT_MARKDOWN_CLASS, bubbleClass } from "./assistantsStyles";
import type { UseAssistants } from "@presentation/hooks/useAssistants";
import { useLuzPrueba } from "@presentation/hooks/useLuzPrueba";

interface Props {
  assistants: UseAssistants;
  /** Composer text lives in the widget so that "minimize" can keep it and "close" can drop it. */
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  /** Closes and discards the draft. */
  onClose: () => void;
  /** Closes keeping the draft (only offered with more than one assistant). */
  onMinimize: () => void;
  /** The person has the `luz_prueba:chat` cell (computed by the widget): adds the "Luz (prueba)" tab (spec 086, RF-1). */
  pruebaEnabled?: boolean;
}


export function AssistantsPanel({
  assistants: a,
  draft,
  setDraft,
  onClose,
  onMinimize,
  pruebaEnabled = false,
}: Props) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pruebaTab, setPruebaTab] = useState(false);
  const luz = useLuzPrueba();
  const listboxId = useId();
  const messagesRef = useRef<HTMLDivElement>(null);
  const pickerBtnRef = useRef<HTMLButtonElement>(null);
  const pickerListRef = useRef<HTMLDivElement>(null);
  const { active, assistants, loadConversation } = a;
  const activeSlug = active?.slug;

  // Always show the last message: new message (person or assistant), "escribiendo", history loaded, panel opened,
  // assistant switched. `scrollTop = scrollHeight` on the list itself — scrollIntoView would scroll the whole page on phones.
  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
  }, [a.messages.length, a.waiting, a.historyError, a.notice, activeSlug]);

  // The list can change height without any message arriving (composer grows to 4 lines, web font loads late):
  // while the person is at the end, stay at the end.
  const stuckRef = useRef(true);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stuckRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeSlug]);

  // Opening an assistant (including the panel opening on an already-active one) marks THAT assistant read — only if it is
  // available and has unread messages. Never for the others, never on a timer.
  const markReadRef = useRef(a.markRead);
  markReadRef.current = a.markRead;
  const activeRef = useRef(active);
  activeRef.current = active;
  // In-flight guard per slug: React.StrictMode (dev server) runs this effect twice on mount, and the unread count only
  // drops after the POST returns — without the guard the second run would send a duplicate `read`.
  const markingRef = useRef(new Set<string>());
  useEffect(() => {
    const cur = activeRef.current;
    if (cur && cur.available && cur.unread_count > 0 && !markingRef.current.has(cur.slug)) {
      const slug = cur.slug;
      markingRef.current.add(slug);
      void markReadRef.current(slug).finally(() => markingRef.current.delete(slug));
    }
  }, [activeSlug]);

  useEffect(() => {
    loadConversation();
  }, [loadConversation]);

  // Click outside closes the list.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        pickerListRef.current?.contains(target) ||
        pickerBtnRef.current?.contains(target)
      )
        return;
      setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  // Opening the list puts focus on the selected option.
  useEffect(() => {
    if (!pickerOpen) return;
    pickerListRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.focus();
  }, [pickerOpen]);

  if (!active && !pruebaEnabled) return null;
  const showPrueba = pruebaEnabled && (pruebaTab || !active);
  const unavailable = !!active && !active.available;
  const entries = [
    ...assistants.map((g) => ({ ...g, prueba: false })),
    ...(pruebaEnabled
      ? [
          {
            slug: "luz-prueba",
            name: t("admin.luzPrueba.tab"),
            area: t("admin.luzPrueba.area") as string | null,
            available: true,
            unread_count: 0,
            prueba: true,
          },
        ]
      : []),
  ];
  const multiple = entries.length > 1;
  const title = showPrueba ? t("admin.luzPrueba.tab") : active?.name;
  const subtitle = showPrueba ? t("admin.luzPrueba.area") : active?.area;

  const submit = async () => {
    if (unavailable || a.waiting || !draft.trim()) return;
    const v = draft;
    setDraft("");
    const r = await a.send(v);
    // Refused input (clinical/personal data): the text goes back to the field to be edited, unless the person already typed.
    if (r?.refused) setDraft((cur) => cur || v);
  };

  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    if (pickerOpen) {
      // Esc closes the list only, not the panel.
      setPickerOpen(false);
      pickerBtnRef.current?.focus();
      return;
    }
    onClose();
  };

  const onOptionKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const opts = Array.from(
      pickerListRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
    );
    const i = opts.indexOf(e.currentTarget);
    const next = e.key === "ArrowDown" ? i + 1 : i - 1;
    opts[(next + opts.length) % opts.length]?.focus();
  };

  const iconBtn =
    "grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-[#404040] hover:bg-gray-200";

  return (
    <div
      role="dialog"
      aria-label={t("admin.assistants.title")}
      data-testid="assistants-panel"
      onKeyDown={onPanelKeyDown}
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-white font-poppins text-[#262626] shadow-extra-large sm:inset-auto sm:bottom-4 sm:right-4 sm:h-[480px] sm:w-[356px] sm:max-w-[calc(100vw-32px)] sm:rounded-card sm:border sm:border-gray-300"
    >
      <header className="flex items-center gap-[10px] border-b border-gray-300 py-3 pl-[14px] pr-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-white">
          <Sparkles size={18} aria-hidden="true" />
        </div>
        <div className="grid min-w-0 flex-1 leading-[1.2]">
          {multiple ? (
            <button
              ref={pickerBtnRef}
              type="button"
              data-testid="assistants-picker"
              aria-label={t("admin.assistants.openPicker")}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              aria-controls={pickerOpen ? listboxId : undefined}
              onClick={() => setPickerOpen((o) => !o)}
              className="inline-flex w-max max-w-full items-center gap-1 text-[#262626]"
            >
              <b className="truncate text-sm font-semibold">{title}</b>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className="shrink-0 text-[#404040]"
              />
            </button>
          ) : (
            <b className="truncate text-sm font-semibold">{title}</b>
          )}
          {subtitle && (
            <span className="truncate text-[11px] text-[#404040]">
              {subtitle}
            </span>
          )}
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-[#404040]">
            <Lock size={11} aria-hidden="true" className="shrink-0" />
            <span className="truncate">
              {showPrueba
                ? t("admin.assistants.masterOnly")
                : t("admin.assistants.yourGroup", {
                    group: active?.area,
                    count: assistants.length,
                  })}
            </span>
          </span>
        </div>
        {multiple && (
          <button
            type="button"
            data-testid="assistants-minimize"
            aria-label={t("admin.assistants.minimize")}
            onClick={onMinimize}
            className={iconBtn}
          >
            <Minus size={16} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          data-testid="assistants-close"
          aria-label={t("admin.assistants.close")}
          onClick={onClose}
          className={iconBtn}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      {multiple && pickerOpen && (
        <div
          ref={pickerListRef}
          id={listboxId}
          role="listbox"
          aria-label={t("admin.assistants.title")}
          className="absolute left-3 right-3 top-16 z-10 grid gap-0.5 rounded-[14px] border border-gray-600 bg-white p-1.5 shadow-large"
        >
          {entries.map((g) => {
            const selected = g.prueba ? showPrueba : !showPrueba && g.slug === active?.slug;
            return (
              <button
                key={g.slug}
                type="button"
                role="option"
                aria-selected={selected}
                data-testid={`assistants-tab-${g.slug}`}
                onKeyDown={onOptionKeyDown}
                onClick={() => {
                  setPruebaTab(g.prueba);
                  if (!g.prueba) a.setTab(g.slug);
                  setPickerOpen(false);
                }}
                className={`grid grid-cols-[30px_1fr_auto] items-center gap-[10px] rounded-input p-2 text-left text-[#262626] hover:bg-[#EEE9F6] ${
                  selected ? "bg-[#EEE9F6]" : ""
                }`}
              >
                <PersonAvatar
                  uid={g.slug}
                  name={g.name}
                  size={30}
                  colorClassName="bg-primary"
                  data-testid={`assistants-avatar-${g.slug}`}
                />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-semibold leading-[1.2]">
                    {g.name}
                  </span>
                  {g.area && (
                    <span className="block truncate text-[10.5px] text-[#404040]">
                      {g.area}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {g.available ? (
                    <span className="text-[10px] text-[#14532D]">
                      {t("admin.assistants.available")}
                    </span>
                  ) : (
                    <span
                      data-testid={`assistants-tab-soon-${g.slug}`}
                      className="text-[10px] text-[#404040]"
                    >
                      {t("admin.assistants.comingSoon")}
                    </span>
                  )}
                  {g.available && g.unread_count > 0 && (
                    <span
                      data-testid={`assistants-tab-badge-${g.slug}`}
                      aria-label={t("admin.assistants.unreadBadge", {
                        count: g.unread_count,
                      })}
                      className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-white"
                    >
                      {g.unread_count}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {showPrueba ? (
        <LuzPruebaTab state={luz} />
      ) : (
        <>
      <div
        ref={messagesRef}
        data-testid="assistants-messages"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="grid flex-1 grid-cols-[minmax(0,1fr)] content-start gap-[10px] overflow-y-auto px-3 pb-1 pt-3 text-[12.5px] leading-[1.45]"
      >
        {a.messages.map((m) => (
          <div
            key={m.id}
            data-testid={`assistants-msg-${m.id}`}
            className={bubbleClass(m.author === "PERSON")}
          >
            {m.author === "PERSON" ? (
              m.text
            ) : (
              <MessageMarkdown body={m.text} className={ASSISTANT_MARKDOWN_CLASS} />
            )}
          </div>
        ))}
        {a.waiting && (
          <div
            data-testid="assistants-typing"
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
        {a.historyError && (
          <p
            role="alert"
            data-testid="assistants-history-error"
            className="text-[#262626]"
          >
            {t("admin.assistants.historyError")}
          </p>
        )}
        {a.notice && (
          <p
            role="alert"
            data-testid="assistants-notice"
            className="text-[#262626]"
          >
            {t(`admin.assistants.${a.notice}`, { assistant: active?.name })}
          </p>
        )}
        {unavailable && (
          <p className="text-[#404040]">{t("admin.assistants.comingSoon")}</p>
        )}
      </div>

      <AssistantsComposer
        value={draft}
        onChange={setDraft}
        onSubmit={() => void submit()}
        focusKey={activeSlug}
        disabled={unavailable}
        sendDisabled={unavailable || a.waiting || !draft.trim()}
      />
      <p className="px-3 pb-2 text-center text-[10px] leading-snug text-[#404040]" data-testid="assistants-footer">
        {t("admin.assistants.footer")}
      </p>
        </>
      )}
    </div>
  );
}
