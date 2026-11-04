/**
 * AssistantsComposer — the one-line text box + send button of the assistants widget (36px growing up to ~4 lines,
 * Enter sends, Shift+Enter breaks the line). Shared by the Maria panel and the "Luz (prueba)" tab (spec 086).
 */
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { useTranslation } from "react-i18next";

const COMPOSER_MIN_PX = 36;
const COMPOSER_MAX_PX = 90; // 4 lines of 18px + padding + border

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** The box is focused (and re-focused) whenever this changes. */
  focusKey?: string;
  disabled?: boolean;
  sendDisabled: boolean;
  maxLength?: number;
  testIdInput?: string;
  testIdSend?: string;
}

export function AssistantsComposer({
  value,
  onChange,
  onSubmit,
  focusKey,
  disabled,
  sendDisabled,
  maxLength,
  testIdInput = "assistants-composer",
  testIdSend = "assistants-send",
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [focusKey]);

  // One line (36px) growing up to ~4 lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = `${COMPOSER_MIN_PX}px`;
    const wanted = el.scrollHeight + 2;
    el.style.height = `${Math.min(Math.max(wanted, COMPOSER_MIN_PX), COMPOSER_MAX_PX)}px`;
  }, [value, focusKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-gray-300 px-3 py-2.5">
      <textarea
        ref={ref}
        data-testid={testIdInput}
        aria-label={t("admin.assistants.placeholder")}
        placeholder={t("admin.assistants.placeholder")}
        rows={1}
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="box-border min-h-9 max-h-[90px] flex-1 resize-none rounded-input border border-gray-600 bg-gray-100 px-3 py-2 font-poppins text-[12.5px] leading-[18px] text-[#262626] placeholder:text-[#404040] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
      />
      <button
        type="button"
        data-testid={testIdSend}
        aria-label={t("admin.assistants.send")}
        disabled={sendDisabled}
        onClick={onSubmit}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-white disabled:opacity-50"
      >
        <Send size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
