/**
 * AssistantsWidget — floating button + chat panel with the assistants (spec 080, phase A).
 * Only exists if `list()` (already filtered by reach in the service) returns >= 1 assistant: an empty list or
 * any failure (e.g. PLATFORM_UNAVAILABLE) = nothing in the DOM, not even the button (fail-closed).
 * The badge is the sum of the service's `unread_count` over the available assistants in the reach.
 */
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAssistants } from "@presentation/hooks/useAssistants";
import { AssistantsPanel } from "./AssistantsPanel";

const BADGE_MAX = 99;

export function AssistantsWidget() {
  const { t } = useTranslation();
  const a = useAssistants();
  const [open, setOpen] = useState(false);

  if (a.assistants.length === 0) return null;

  if (open) {
    return <AssistantsPanel assistants={a} onClose={() => setOpen(false)} />;
  }

  return (
    <button
      type="button"
      data-testid="assistants-fab"
      aria-label={t("admin.assistants.button")}
      onClick={() => setOpen(true)}
      className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-primary px-5 py-3 font-poppins text-sm font-medium text-white shadow-large"
    >
      <MessageCircle size={20} aria-hidden="true" />
      {t("admin.assistants.button")}
      {a.unreadTotal > 0 && (
        <span
          data-testid="assistants-badge"
          role="img"
          aria-label={t("admin.assistants.unreadBadge", {
            count: a.unreadTotal,
          })}
          className="ml-1 rounded-full bg-white px-2 text-xs font-semibold text-[#262626]"
        >
          {a.unreadTotal > BADGE_MAX ? `${BADGE_MAX}+` : a.unreadTotal}
        </span>
      )}
    </button>
  );
}
