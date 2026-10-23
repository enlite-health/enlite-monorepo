import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { formatCalendarDate } from '@presentation/utils/dateTimeFormat';
import type { SubstitutionRequestItem } from '@domain/entities/SubstitutionRequest';
import { SaleEntraBlock, type EntraPerson } from './SaleEntraBlock';
import { NOWRAP } from './SingleLine';
import { SubstitutionDaysList } from './SubstitutionDaysList';
import { dayMonthLabel, fullDayLabel, periodRangeLabel, shortDayLabel } from './substitutionLabels';
import { dateLocaleOf } from './weekRange';

/** Cuándo e Acción com a largura do CONTEÚDO (nowrap); Sale/Entra dividem o resto (`minmax(0,1fr)`). As linhas são subgrades da lista: as colunas alinham. */
export const SUBSTITUTION_ROW_GRID = 'grid grid-cols-subgrid col-span-3 items-center gap-4';
export const SUBSTITUTION_LIST_GRID = 'grid grid-cols-[max-content_minmax(0,1fr)_max-content] gap-x-4';

interface SubstitutionRequestRowProps {
  request: SubstitutionRequestItem;
  /** O motivo por extenso (catálogo ativo); `null` = não conhecido (a linha mostra só o nome — nunca o código cru). */
  reasonLabel: string | null;
  expanded: boolean;
  undoing: boolean;
  onToggleDays: () => void;
  onUndo: () => void;
  onPick: () => void;
}

/**
 * Uma linha da aba "Sustituciones" (spec 069, US6; mockup `b2c.png`): Cuándo · Sale ↓ · Entra ↑ · Acción. "Ver días" só com mais de um
 * turno; "Deshacer" só no pedido que ainda tem algo futuro (`undoable`); passadas ficam esmaecidas e sem ação; desfeitas = "Deshecha".
 */
export function SubstitutionRequestRow({ request, reasonLabel, expanded, undoing, onToggleDays, onUndo, onPick }: SubstitutionRequestRowProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const td = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.substitutions.${key}`, opts);
  const id = request.requestId ?? 'legacy';
  const language = i18n.language;
  const undone = request.undoneAt !== null;
  const past = request.when === 'past';

  const when =
    request.type === 'PERMANENT'
      ? td('since', { date: dayMonthLabel(request.from, language) })
      : request.to !== null && request.to !== request.from
        ? periodRangeLabel(t, request.from, request.to, language)
        : fullDayLabel(request.from, language);
  const kind = request.type === 'PERMANENT' ? td('types.PERMANENT') : `${td(`types.${request.type}`)} · ${td('shifts', { count: request.shiftCount })}`;

  const entra: EntraPerson[] = request.entra.workerIds.map((workerId, index) => ({ workerId, displayName: request.entraDisplayNames[index] ?? null }));
  const canAct = !undone && !past;

  return (
    <li className={`${SUBSTITUTION_ROW_GRID} col-span-3 border-b border-[#D6CDE0] py-3`} data-testid={`sustitucion-${id}`} data-when={request.when} data-undone={undone}>
        <div className={`flex flex-col ${past || undone ? 'opacity-70' : ''}`}>
          <Text as="span" weight="semibold" color="primary" className="whitespace-nowrap" {...NOWRAP}>
            {when}
          </Text>
          <Text as="span" size="xs" color="tertiary" className="whitespace-nowrap" {...NOWRAP}>
            {kind}
          </Text>
          <div className="mt-1 flex gap-1.5">
            {request.legacy && <Chip tone="neutral" testId={`sustitucion-anterior-${id}`}>{td('legacy')}</Chip>}
            {undone && (
              <Chip tone="neutral" testId={`sustitucion-deshecha-${id}`}>
                {td('undone')}
                {request.undoneAt && ` · ${formatCalendarDate(request.undoneAt, { day: '2-digit', month: '2-digit' }, dateLocaleOf(language)) ?? ''}`}
              </Chip>
            )}
            {request.adjusted && <Chip tone="amber" testId={`sustitucion-ajustado-${id}`}>{td('adjusted')}</Chip>}
          </div>
        </div>

        <SaleEntraBlock
          data-testid={`sustitucion-bloque-${id}`}
          dimmed={past || undone}
          sale={{ workerId: request.outgoingWorkerId, displayName: request.outgoingDisplayName, caption: reasonLabel }}
          entra={entra}
          uncoveredLabels={request.entra.workerIds.length > 0 ? request.entra.uncoveredDates.map((d) => shortDayLabel(d, language)) : []}
          onPick={canAct && request.requestId !== null ? onPick : undefined}
        />

        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          {request.shiftCount > 1 && (
            <Button variant="outline" size="sm" className="whitespace-nowrap" onClick={onToggleDays} aria-expanded={expanded} data-testid={`sustitucion-ver-dias-${id}`} {...NOWRAP}>
              {expanded ? td('hideDays') : td('viewDays')}
            </Button>
          )}
          {canAct && request.undoable && request.requestId !== null && (
            <ActionButton resource="patient_itinerary" action="update" variant="outline" size="sm" className="whitespace-nowrap" disabled={undoing} onClick={onUndo} data-testid={`sustitucion-deshacer-${id}`} {...NOWRAP}>
              {td('undo')}
            </ActionButton>
          )}
        </div>
      {expanded && request.shiftCount > 1 && (
        <div className="col-span-3 mt-3">
          <SubstitutionDaysList request={request} />
        </div>
      )}
    </li>
  );
}

function Chip({ tone, testId, children }: { tone: 'neutral' | 'amber'; testId: string; children: React.ReactNode }): JSX.Element {
  const classes = tone === 'amber' ? 'bg-[#FFE7B0] text-[#4A2F00]' : 'bg-[#E8E8E8] text-[#374151]';
  return (
    <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 ${classes}`} data-testid={testId} {...NOWRAP}>
      <Text as="span" size="xs" weight="semibold" color="inherit">
        {children}
      </Text>
    </span>
  );
}
