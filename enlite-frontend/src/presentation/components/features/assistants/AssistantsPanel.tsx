/**
 * AssistantsPanel — 360x480 panel (phone: full screen): header with the assistant (`Combobox` picker if > 1), tabs, conversation and composer. Colors: text #262626, secondary/placeholder #404040 (>= 7:1).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Combobox } from "@presentation/components/atoms/Combobox/Combobox";
import { Textarea } from "@presentation/components/atoms/Textarea/Textarea";
import type { UseAssistants } from "@presentation/hooks/useAssistants";

interface Props {
  assistants: UseAssistants;
  onClose: () => void;
}

export function AssistantsPanel({ assistants: a, onClose }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const { active, assistants, loadConversation } = a;
  const activeSlug = active?.slug;

  useEffect(() => {
    composerRef.current?.focus();
  }, [activeSlug]);

  // Opening a tab (including the panel opening on an already-active one) marks THAT tab read — only if it is
  // available and has unread messages. Never for the other tabs, never on a timer.
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

  if (!active) return null;
  const unavailable = !active.available;
  const options = assistants.map((g) => ({
    value: g.slug,
    label: g.available
      ? g.name
      : `${g.name} · ${t("admin.assistants.comingSoon")}`,
  }));

  const submit = async () => {
    if (unavailable || a.waiting || !text.trim()) return;
    const v = text;
    setText("");
    const r = await a.send(v);
    // Refused input (clinical/personal data): the text goes back to the field to be edited, unless the person already typed.
    if (r?.refused) setText((cur) => cur || v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      role="dialog"
      aria-label={t("admin.assistants.title")}
      data-testid="assistants-panel"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className="fixed z-50 flex flex-col overflow-hidden bg-white font-poppins text-[#262626] shadow-large inset-0 sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[480px] sm:w-[360px] sm:rounded-card"
    >
      <header className="border-b border-gray-600 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {assistants.length > 1 ? (
              <Combobox
                data-testid="assistants-picker"
                aria-label={t("admin.assistants.title")}
                options={options}
                value={active.slug}
                onChange={(v) => v && a.setTab(v)}
                valueClassName="text-[#262626]"
              />
            ) : (
              <p className="text-base font-semibold text-[#262626]">
                {active.name}
              </p>
            )}
            <p className="mt-1 text-xs text-[#404040]">{active.area}</p>
            <p className="text-xs text-[#404040]">
              {t("admin.assistants.yourGroup", {
                group: active.area,
                count: assistants.length,
              })}
            </p>
          </div>
          <button
            type="button"
            data-testid="assistants-close"
            aria-label={t("admin.assistants.close")}
            onClick={onClose}
            className="rounded-full p-1 text-[#262626]"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {assistants.length > 1 && (
          <div role="tablist" className="mt-2 flex gap-1 overflow-x-auto">
            {assistants.map((g) => (
              <button
                key={g.slug}
                type="button"
                role="tab"
                aria-selected={g.slug === active.slug}
                data-testid={`assistants-tab-${g.slug}`}
                onClick={() => a.setTab(g.slug)}
                className={`whitespace-nowrap rounded-full px-3 py-1 text-xs ${
                  g.slug === active.slug
                    ? "bg-primary text-white"
                    : "bg-gray-200 text-[#262626]"
                }`}
              >
                {g.name}
                {!g.available && (
                  <span
                    data-testid={`assistants-tab-soon-${g.slug}`}
                    className="ml-1 italic"
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
                    className="ml-1 rounded-full bg-[#262626] px-1.5 text-[10px] text-white"
                  >
                    {g.unread_count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </header>

      <div
        className="flex-1 space-y-2 overflow-y-auto px-4 py-3"
        aria-live="polite"
      >
        {a.messages.map((m) => (
          <div
            key={m.id}
            data-testid={`assistants-msg-${m.id}`}
            className={`max-w-[85%] whitespace-pre-wrap rounded-[14px] px-3 py-2 text-sm ${
              m.author === "PERSON"
                ? "ml-auto bg-primary text-white"
                : "bg-gray-200 text-[#262626]"
            }`}
          >
            {m.text}
          </div>
        ))}
        {a.waiting && (
          <p
            data-testid="assistants-typing"
            className="text-xs italic text-[#404040]"
          >
            {t("admin.assistants.typing")}
          </p>
        )}
        {a.historyError && (
          <p
            role="alert"
            data-testid="assistants-history-error"
            className="text-sm text-[#262626]"
          >
            {t("admin.assistants.historyError")}
          </p>
        )}
        {a.notice && (
          <p
            role="alert"
            data-testid="assistants-notice"
            className="text-sm text-[#262626]"
          >
            {t(`admin.assistants.${a.notice}`, { assistant: active.name })}
          </p>
        )}
        {unavailable && (
          <p className="text-sm text-[#404040]">
            {t("admin.assistants.comingSoon")}
          </p>
        )}
      </div>

      <div className="flex items-end gap-2 border-t border-gray-600 px-4 py-3">
        <Textarea
          ref={composerRef}
          data-testid="assistants-composer"
          aria-label={t("admin.assistants.placeholder")}
          placeholder={t("admin.assistants.placeholder")}
          rows={2}
          value={text}
          disabled={unavailable}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="flex-1 !text-[#262626] placeholder:!text-[#404040]"
        />
        <button
          type="button"
          data-testid="assistants-send"
          disabled={unavailable || a.waiting || !text.trim()}
          onClick={() => void submit()}
          className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {t("admin.assistants.send")}
        </button>
      </div>
      <p className="px-4 pb-3 text-[11px] text-[#404040]">
        {t("admin.assistants.footer")}
      </p>
    </div>
  );
}
