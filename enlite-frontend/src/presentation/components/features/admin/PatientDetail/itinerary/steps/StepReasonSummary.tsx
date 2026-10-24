import { useTranslation } from 'react-i18next';
import { Combobox } from '@presentation/components/atoms/Combobox';
import { Text } from '@presentation/components/atoms/Text';
import type { PreviewShift, SubstitutionPreview } from '@domain/entities/SubstitutionRequest';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';
import { useServiceExitReasonOptions } from '@hooks/admin/useServiceExitReasonOptions';
import { ExitDestinationField } from '../../ExitDestinationField';
import { formatDDMM } from '../../substitutionDates';
import { SaleEntraBlock, type EntraPerson } from '../SaleEntraBlock';
import { SingleLine } from '../SingleLine';
import { resolveCover, summarizeEntra, type FlowDraft } from '../flowModel';
import { dayMonthLabel, fullDayLabel, periodRangeLabel, shortDayLabel } from '../substitutionLabels';

interface StepReasonSummaryProps {
  draft: FlowDraft;
  onChange: (patch: Partial<FlowDraft>) => void;
  asOf: string;
  shifts: PreviewShift[];
  /** A pré-visão do período — o passo 4 só existe com ela pronta. */
  preview: SubstitutionPreview;
  outgoingName: string | null;
  candidates: ServiceTeamMember[];
  /** O código que a API explicou na criação (409/422) — vira o texto traduzido, nunca o código cru. */
  submitError: string | null;
}

/**
 * Passo 4 — "Motivo y resumen": o motivo (catálogo ATIVO, obrigatório, sem texto livre) e "Vas a registrar:" com o MESMO bloco Sale →
 * Entra da lista. No "No vuelve más": a frase "A partir del DD/MM los turnos quedan Sin cubrir", o estado novo do paciente (da pré-visão,
 * só quando ninguém entra) e "Se cancelan N sustituciones ya cargadas desde esa fecha". Destino de quem sai só quando D = hoje (P6).
 */
export function StepReasonSummary({ draft, onChange, asOf, shifts, preview, outgoingName, candidates, submitError }: StepReasonSummaryProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const ts = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.flow.summary.${key}`, opts);
  const { options, status } = useServiceExitReasonOptions();
  const reasonLabel = options.find((o) => o.code === draft.reason)?.label ?? null;
  const cover = resolveCover(draft, shifts);
  const entra = summarizeEntra(cover, shifts);
  // quem entra SEMPRE veio do pool (o passo 3 só escolhe dele): o `get` não falha
  const personById = new Map<string, EntraPerson>(candidates.map((c) => [c.workerId, { workerId: c.workerId, displayName: c.displayName, role: c.status }]));
  const permanent = draft.type === 'PERMANENT';
  const nobody = entra.kind === 'NOBODY';
  const destinationAsked = permanent && draft.from === asOf;

  const period = permanent
    ? ts('since', { date: dayMonthLabel(draft.from, i18n.language) })
    : draft.type === 'DAYS' && draft.from !== draft.to
      ? periodRangeLabel(t, draft.from, draft.to, i18n.language)
      : fullDayLabel(draft.from, i18n.language);
  const count = permanent ? ts('slots', { count: shifts.length }) : ts('shifts', { count: shifts.length });
  const { permanent: perm, statusAfter } = preview;
  const statusLabel = (code: string): string => t(`admin.patients.statusOptions.${code}`, code);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Text as="span" size="xs" weight="semibold" color="tertiary">
          {ts('reason')}
        </Text>
        <Combobox
          inputSize="compact"
          data-testid="substitucion-motivo"
          className="[&_button]:!text-primary"
          options={options.map((o) => ({ value: o.code, label: o.label }))}
          value={draft.reason}
          onChange={(reason) => onChange({ reason })}
          placeholder={t('admin.patients.detail.serviceTeam.substitution.reasonPlaceholder')}
          aria-label={ts('reason')}
        />
        {status === 'error' && (
          <Text as="p" size="xs" role="alert" color="inherit" className="text-red-800" data-testid="substitucion-motivo-error">
            {t('admin.patients.detail.serviceTeam.substitution.reasonLoadError')}
          </Text>
        )}
      </div>

      {destinationAsked && (
        <ExitDestinationField value={draft.destination} onChange={(destination) => onChange({ destination })} data-testid="substitucion-destino" />
      )}

      <div className="flex flex-col gap-2.5 rounded-[14px] bg-[#F1E8FF] px-4 py-3.5 text-[#2A0A66]" data-testid="substitucion-resumen">
        <Text as="span" size="sm" weight="bold" color="inherit">
          {ts('registering')}
        </Text>
        <SingleLine as="p" size="sm" weight="semibold" color="inherit" data-testid="substitucion-resumen-periodo">
          {`${period} · ${count}`}
        </SingleLine>
        <div className="rounded-xl bg-white/60 p-2.5">
          <SaleEntraBlock
            data-testid="substitucion-resumen-bloque"
            sale={{ workerId: draft.outgoingWorkerId as string, displayName: outgoingName, caption: reasonLabel }}
            entra={entra.kind === 'NOBODY' ? [] : entra.workerIds.map((id) => personById.get(id) as EntraPerson)}
            uncoveredLabels={entra.kind === 'PEOPLE' ? entra.uncoveredDates.map((d) => shortDayLabel(d, i18n.language)) : []}
          />
        </div>
        {permanent && nobody && (
          <Text as="p" size="sm" weight="semibold" color="inherit" data-testid="substitucion-resumen-sin-cubrir">
            {ts('uncoveredFrom', { date: formatDDMM(draft.from) })}
          </Text>
        )}
        {permanent && nobody && statusAfter?.changes && statusAfter.after !== null && (
          <Text as="p" size="sm" color="inherit" data-testid="substitucion-resumen-estado">
            {statusAfter.current === null
              ? ts('statusChangeTo', { to: statusLabel(statusAfter.after) })
              : ts('statusChange', { from: statusLabel(statusAfter.current), to: statusLabel(statusAfter.after) })}
          </Text>
        )}
        {perm !== undefined && perm.cancelledAbsences > 0 && (
          <Text as="p" size="sm" color="inherit" data-testid="substitucion-resumen-canceladas">
            {ts('cancelled', { count: perm.cancelledAbsences })}
          </Text>
        )}
        {perm !== undefined && perm.clearedSubstitutes > 0 && (
          <Text as="p" size="sm" color="inherit" data-testid="substitucion-resumen-limpias">
            {ts('cleared', { count: perm.clearedSubstitutes })}
          </Text>
        )}
      </div>

      {submitError !== null && (
        <Text as="p" size="sm" role="alert" color="inherit" className="text-red-800" data-testid="substitucion-error">
          {i18n.exists(`admin.patients.detail.itinerary.actionErrors.${submitError}`)
            ? t(`admin.patients.detail.itinerary.actionErrors.${submitError}`)
            : ts('createError')}
        </Text>
      )}
    </div>
  );
}
