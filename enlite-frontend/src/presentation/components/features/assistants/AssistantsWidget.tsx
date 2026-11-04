/**
 * AssistantsWidget — floating button + chat panel with the assistants (spec 080, phase A).
 * Only exists if `list()` (already filtered by reach in the service) returns >= 1 assistant, or the person has the
 * `luz_prueba:chat` cell (spec 086): an empty list or any failure (e.g. PLATFORM_UNAVAILABLE) = nothing in the DOM,
 * not even the button (fail-closed).
 * The red dot on the button means "there are unread messages" (the total is in its aria-label): the sum of the
 * service's `unread_count` over the available assistants in the reach.
 * The composer draft lives here: "minimize" keeps it for the next opening, "close" discards it.
 */
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAssistants } from "@presentation/hooks/useAssistants";
import { useHasCell } from "@presentation/hooks/useCellAccess";
import { AssistantsPanel } from "./AssistantsPanel";

export function AssistantsWidget() {
  const { t } = useTranslation();
  const a = useAssistants();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // Spec 086: the "Luz (prueba)" tab exists only for who has the cell (Acesso Master); without it, no tab, no request.
  const luzPrueba = useHasCell('luz_prueba', 'chat');

  if (a.assistants.length === 0 && !luzPrueba) return null;

  if (open) {
    return (
      <AssistantsPanel
        assistants={a}
        draft={draft}
        setDraft={setDraft}
        onClose={() => {
          setDraft("");
          setOpen(false);
        }}
        onMinimize={() => setOpen(false)}
        pruebaEnabled={luzPrueba}
      />
    );
  }

  return (
    <button
      type="button"
      data-testid="assistants-fab"
      aria-label={t("admin.assistants.button")}
      onClick={() => setOpen(true)}
      className="fixed bottom-4 right-4 z-40 flex h-12 items-center gap-[10px] rounded-full bg-primary pl-[14px] pr-[18px] font-poppins text-[13px] font-semibold text-white shadow-large"
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
          className="absolute -right-[3px] -top-[3px] h-3 w-3 rounded-full border-2 border-gray-200 bg-[#D32F2F]"
        />
      )}
    </button>
  );
}
