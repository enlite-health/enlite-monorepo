import { useTranslation } from 'react-i18next';
import type { AllocationOptionStatus as Status } from '@domain/entities/ServiceTeam';

/**
 * Marca de estado de quem aparece na lista de prestadores do itinerário (041 R2, DEC-05): verde = em
 * atendimento, azul = Equipe de Resposta Rápida, SEM bolinha = Selecionado. O marcador é o mesmo
 * `span` redondo do cabeçalho das colunas do Kanban (`KanbanColumn`); só a cor muda, por token do Tailwind.
 */
const DOT_CLASS: Record<Exclude<Status, 'SELECTED'>, string> = {
  IN_SERVICE: 'bg-green-600',
  QUICK_RESPONSE: 'bg-blue-600',
};

/** As MESMAS chaves dos quadros: quadro C (en atención / seleccionado) e colunas da vacante (resposta rápida). */
const LABEL_KEY: Record<Status, string> = {
  IN_SERVICE: 'admin.patients.detail.serviceTeam.columns.IN_SERVICE',
  QUICK_RESPONSE: 'admin.kanban.columns.QUICK_RESPONSE_TEAM',
  SELECTED: 'admin.patients.detail.serviceTeam.columns.SELECTED_FOR_SERVICE',
};

interface AllocationOptionStatusProps {
  status: Status;
  /** Para o e2e achar a marca de cada prestador. */
  'data-testid'?: string;
}

export function AllocationOptionStatus({ status, 'data-testid': testId }: AllocationOptionStatusProps): JSX.Element {
  const { t } = useTranslation();
  const dotClass = status === 'SELECTED' ? null : DOT_CLASS[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-800" data-testid={testId} data-status={status}>
      {dotClass && <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotClass}`} data-testid="allocation-option-dot" aria-hidden="true" />}
      {t(LABEL_KEY[status])}
    </span>
  );
}
