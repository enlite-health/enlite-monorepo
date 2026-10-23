import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import type { SubstitutionRequestItem, SubstitutionWhen } from '@domain/entities/SubstitutionRequest';
import { classifyActionError } from '@hooks/admin/contractedServiceActionError';
import { useServiceExitReasonOptions } from '@hooks/admin/useServiceExitReasonOptions';
import { useSubstitutionRequests } from '@hooks/admin/useSubstitutionRequests';
import { SUBSTITUTION_ROW_GRID, SubstitutionRequestRow } from './SubstitutionRequestRow';

interface SubstitutionsTabProps {
  patientId: string;
  serviceId: string;
  /** Muda quando o fluxo cria um pedido (ou outra escrita invalida a lista): refaz o GET. */
  refreshKey: number;
  onNew: () => void;
  /** "Elegir quién entra" do pedido. */
  onPick: (request: SubstitutionRequestItem) => void;
  /** Uma escrita desta aba ("Deshacer") mudou o quadro: quem monta a tela refaz as leituras. */
  onChanged: () => void;
}

const FILTERS: Array<{ id: SubstitutionWhen; key: string }> = [
  { id: 'upcoming', key: 'upcoming' },
  { id: 'past', key: 'past' },
];

/**
 * A aba "Sustituciones" (spec 069, US6/FR-20; mockup `b2c.png`): filtro Próximas · Pasadas e UMA linha por pedido, no formato de
 * "substituição de futebol" — Cuándo · Sale ↓ · Entra ↑ · Acción. Sem pedido: estado vazio com "Nueva sustitución".
 */
export function SubstitutionsTab({ patientId, serviceId, refreshKey, onNew, onPick, onChanged }: SubstitutionsTabProps): JSX.Element {
  const { t } = useTranslation();
  const td = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.substitutions.${key}`, opts);
  const [when, setWhen] = useState<SubstitutionWhen>('upcoming');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const { requests, status } = useSubstitutionRequests(patientId, serviceId, when, refreshKey);
  const { options } = useServiceExitReasonOptions();
  const reasonOf = (code: string | null): string | null => options.find((o) => o.code === code)?.label ?? null;

  const undo = async (request: SubstitutionRequestItem): Promise<void> => {
    setUndoing(request.requestId);
    setUndoError(null);
    try {
      await AdminSubstitutionRequestsApiService.undo(patientId, serviceId, request.requestId as string);
    } catch (err) {
      const classified = classifyActionError(err);
      setUndoError(classified.kind === 'coded' ? classified.code : 'GENERIC');
    } finally {
      setUndoing(null);
      // Sucesso OU recusa (409): a lista refaz — o pedido volta ao estado do banco ("Deshecha", ou já sem o que desfazer).
      onChanged();
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="sustituciones-panel">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div role="group" aria-label={td('filterLabel')} className="flex gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={when === f.id}
              onClick={() => setWhen(f.id)}
              data-testid={`sustituciones-filtro-${f.id}`}
              className={`h-9 rounded-full border-[1.5px] px-[18px] ${when === f.id ? 'border-primary bg-primary' : 'border-[#D6CDE0] bg-white'}`}
            >
              <Text as="span" size="sm" weight="medium" color={when === f.id ? 'white' : 'primary'}>
                {td(`filters.${f.key}`)}
              </Text>
            </button>
          ))}
        </div>
      </div>

      {undoError !== null && (
        <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="sustituciones-deshacer-error">
          {t(`admin.patients.detail.itinerary.actionErrors.${undoError}`, td('undoError'))}
        </Text>
      )}

      {status === 'loading' || status === 'idle' ? (
        <Text size="sm" color="tertiary" data-testid="sustituciones-cargando">
          {td('loading')}
        </Text>
      ) : status !== 'ok' || requests === null ? (
        <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="sustituciones-error">
          {status === 'forbidden' ? td('forbidden') : td('loadError')}
        </Text>
      ) : requests.length === 0 ? (
        <div className="flex flex-col items-start gap-3" data-testid="sustituciones-vacio">
          <Text size="sm" color="tertiary">
            {when === 'upcoming' ? td('emptyUpcoming') : td('emptyPast')}
          </Text>
          {when === 'upcoming' && (
            <ActionButton resource="patient_itinerary" action="update" size="sm" onClick={onNew} data-testid="sustituciones-vacio-nueva">
              <span className="inline-flex items-center gap-2">
                <Plus size={16} aria-hidden="true" />
                {t('admin.patients.detail.itinerary.serviceScreen.newSubstitution')}
              </span>
            </ActionButton>
          )}
        </div>
      ) : (
        <div data-testid="sustituciones-lista">
          <div className={`${SUBSTITUTION_ROW_GRID} border-b border-[#D6CDE0] pb-2`}>
            <Text as="span" size="xs" weight="semibold" color="tertiary">
              {td('columns.when')}
            </Text>
            <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)] gap-3">
              <Text as="span" size="xs" weight="semibold" color="tertiary">
                {td('columns.sale')}
              </Text>
              <span aria-hidden="true" />
              <Text as="span" size="xs" weight="semibold" color="tertiary">
                {td('columns.enters')}
              </Text>
            </div>
            <Text as="span" size="xs" weight="semibold" color="tertiary" className="text-right">
              {td('columns.action')}
            </Text>
          </div>
          <ul>
            {requests.map((request) => {
              const key = request.requestId ?? `legacy-${request.from}-${request.outgoingWorkerId}`;
              return (
                <SubstitutionRequestRow
                  key={key}
                  request={request}
                  reasonLabel={reasonOf(request.reasonCode)}
                  expanded={expanded[key] === true}
                  undoing={undoing === request.requestId}
                  onToggleDays={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))}
                  onUndo={() => void undo(request)}
                  onPick={() => onPick(request)}
                />
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
