/**
 * KanbanCardStageMessage — "Mensaje de etapa (<etapa>): <data>" na tarjeta (DEC-12 / PEND-14).
 * Aparece independentemente do botão de reenvio; some quando nunca houve envio por etapa.
 */
import { useTranslation } from 'react-i18next';
import { formatLastSent } from './kanbanCardFormat';

export interface StageMessageInfo { stage: string; templateSlug: string | null; at: string }

export function KanbanCardStageMessage({ lastStageMessage }: { lastStageMessage?: StageMessageInfo | null }) {
  const { t } = useTranslation();
  if (!lastStageMessage) return null;
  return (
    <span data-testid="stage-last-message" className="block mt-1 px-2 text-[10px] text-indigo-700" title={lastStageMessage.templateSlug ?? undefined}>
      {t('admin.kanban.stageLastMessage', {
        stage: t(`admin.kanban.columns.${lastStageMessage.stage}`, lastStageMessage.stage),
        date: formatLastSent(lastStageMessage.at),
      })}
    </span>
  );
}
