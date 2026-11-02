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
import { ChevronDown, Lock, Minus, Send, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PersonAvatar } from "@presentation/components/atoms/PersonAvatar";
import type { UseAssistants } from "@presentation/hooks/useAssistants";

interface Props {
  assistants: UseAssistants;
  /** Composer text lives in the widget so that "minimize" can keep it and "close" can drop it. */
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  /** Closes and discards the draft. */
  onClose: () => void;
  /** Closes keeping the draft (only offered with more than one assistant). */
  onMinimize: () => void;
}

const COMPOSER_MIN_PX = 36;
const COMPOSER_MAX_PX = 90; // 4 lines of 18px + padding + border

export function AssistantsPanel({
  assistants: a,
  draft,
  setDraft,
  onClose,
  onMinimize,
}: Props) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const privacyId = useId();
  const listboxId = useId();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pickerBtnRef = useRef<HTMLButtonElement>(null);
  const pickerListRef = useRef<HTMLDivElement>(null);
  const { active, assistants, loadConversation } = a;
  const activeSlug = active?.slug;

  useEffect(() => {
    composerRef.current?.focus();
  }, [activeSlug]);

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

  // One line (36px) growing up to ~4 lines.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = `${COMPOSER_MIN_PX}px`;
    const wanted = el.scrollHeight + 2;
    el.style.height = `${Math.min(Math.max(wanted, COMPOSER_MIN_PX), COMPOSER_MAX_PX)}px`;
  }, [draft, activeSlug]);

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

  if (!active) return null;
  const unavailable = !active.available;
  const multiple = assistants.length > 1;

  const submit = async () => {
    if (unavailable || a.waiting || !draft.trim()) return;
    const v = draft;
    setDraft("");
    const r = await a.send(v);
    // Refused input (clinical/personal data): the text goes back to the field to be edited, unless the person already typed.
    if (r?.refused) setDraft((cur) => cur || v);
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
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
              <b className="truncate text-sm font-semibold">{active.name}</b>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className="shrink-0 text-[#404040]"
              />
            </button>
          ) : (
            <b className="truncate text-sm font-semibold">{active.name}</b>
          )}
          {active.area && (
            <span className="truncate text-[11px] text-[#404040]">
              {active.area}
            </span>
          )}
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-[#404040]">
            <Lock size={11} aria-hidden="true" className="shrink-0" />
            <span className="truncate">
              {t("admin.assistants.yourGroup", {
                group: active.area,
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
          {assistants.map((g) => {
            const selected = g.slug === active.slug;
            return (
              <button
                key={g.slug}
                type="button"
                role="option"
                aria-selected={selected}
                data-testid={`assistants-tab-${g.slug}`}
                onKeyDown={onOptionKeyDown}
                onClick={() => {
                  a.setTab(g.slug);
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
            className={`max-w-[86%] whitespace-pre-wrap break-words rounded-[14px] px-[11px] py-[9px] ${
              m.author === "PERSON"
                ? "justify-self-end rounded-br-[4px] bg-primary text-white"
                : "justify-self-start rounded-bl-[4px] bg-gray-200 text-[#262626]"
            }`}
          >
            {m.text}
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
            {t(`admin.assistants.${a.notice}`, { assistant: active.name })}
          </p>
        )}
        {unavailable && (
          <p className="text-[#404040]">{t("admin.assistants.comingSoon")}</p>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-gray-300 px-3 py-2.5">
        <textarea
          ref={composerRef}
          data-testid="assistants-composer"
          aria-label={t("admin.assistants.placeholder")}
          aria-describedby={privacyId}
          placeholder={t("admin.assistants.placeholder")}
          rows={1}
          value={draft}
          disabled={unavailable}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKeyDown}
          className="box-border min-h-9 max-h-[90px] flex-1 resize-none rounded-input border border-gray-600 bg-gray-100 px-3 py-2 font-poppins text-[12.5px] leading-[18px] text-[#262626] placeholder:text-[#404040] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
        />
        <button
          type="button"
          data-testid="assistants-send"
          aria-label={t("admin.assistants.send")}
          disabled={unavailable || a.waiting || !draft.trim()}
          onClick={() => void submit()}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-white disabled:opacity-50"
        >
          <Send size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="px-3 pb-2 text-center text-[10px] leading-snug text-[#404040]">
        <p id={privacyId} data-testid="assistants-privacy-notice">
          {t("admin.assistants.privacyNotice")}
        </p>
        <p>{t("admin.assistants.footer")}</p>
      </div>
    </div>
  );
}
