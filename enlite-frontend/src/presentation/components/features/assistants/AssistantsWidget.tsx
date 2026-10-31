/**
 * AssistentesWidget — botão flutuante + painel de chat com os asistentes (spec 080, fase A).
 * Só existe se `listar()` (já filtrado por célula ABAC no backend) devolver ≥ 1 agente: lista vazia =
 * nada no DOM, nem o botão. Contrato: `specs/080-assistentes-no-app/contratos/rota-mensagens.md`.
 */
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAssistentes } from "@presentation/hooks/useAssistentes";
import { AssistentesPainel } from "./AssistentesPainel";

export function AssistentesWidget() {
  const { t } = useTranslation();
  const a = useAssistentes();
  const [aberto, setAberto] = useState(false);

  if (a.agentes.length === 0) return null;

  if (aberto) {
    return (
      <AssistentesPainel assistentes={a} onFechar={() => setAberto(false)} />
    );
  }

  return (
    <button
      type="button"
      data-testid="assistentes-fab"
      aria-label={t("admin.assistentes.botao")}
      onClick={() => setAberto(true)}
      className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-primary px-5 py-3 font-poppins text-sm font-medium text-white shadow-large"
    >
      <MessageCircle size={20} aria-hidden="true" />
      {t("admin.assistentes.botao")}
      {a.naoLidas > 0 && (
        <span
          data-testid="assistentes-badge"
          className="ml-1 rounded-full bg-white px-2 text-xs font-semibold text-[#262626]"
        >
          {a.naoLidas}
        </span>
      )}
    </button>
  );
}
