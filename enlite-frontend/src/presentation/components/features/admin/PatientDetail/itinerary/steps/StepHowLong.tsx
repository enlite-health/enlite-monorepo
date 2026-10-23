import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { PreviewShift, SubstitutionRequestType } from '@domain/entities/SubstitutionRequest';
import type { UseSubstitutionPreviewResult } from '@hooks/admin/useSubstitutionPreview';
import { DdMmDateInput } from '../../DdMmDateInput';
import { periodProblem, type FlowDraft } from '../flowModel';
import { shiftChipLabel } from '../substitutionLabels';
import { OptionCard } from './OptionCard';

interface StepHowLongProps {
  draft: FlowDraft;
  onChange: (patch: Partial<FlowDraft>) => void;
  asOf: string;
  outgoingName: string;
  /** A pré-visão do período (sem candidatos): dela vêm os turnos, nunca de uma conta no front. */
  period: UseSubstitutionPreviewResult;
}

const OPTIONS: SubstitutionRequestType[] = ['ONE_DAY', 'DAYS', 'PERMANENT'];

function ShiftChips({ shifts, language }: { shifts: PreviewShift[]; language: string }): JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-1.5" data-testid="substitucion-turnos">
      {shifts.map((shift) => (
        <span key={`${shift.date}|${shift.slotId}`} className="flex h-7 items-center justify-center whitespace-nowrap rounded-full bg-[#F1E8FF] px-2 text-[#3B0A8C]">
          <Text as="span" size="xs" weight="medium" color="inherit">
            {shiftChipLabel(shift.date, shift.startTime, shift.endTime, language)}
          </Text>
        </span>
      ))}
    </div>
  );
}

/**
 * Passo 2 — "¿Por cuánto tiempo?": Un solo día · Varios días · No vuelve más (sem "parte de un turno", US4). A data passada é
 * bloqueada ANTES de enviar; os turnos da pessoa no período vêm da pré-visão; período sem turno = mensagem e bloqueio.
 */
export function StepHowLong({ draft, onChange, asOf, outgoingName, period }: StepHowLongProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const ts = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.flow.howLong.${key}`, opts);
  const problem = draft.type === null ? null : periodProblem(draft, asOf);
  const shifts = period.preview?.shifts ?? [];
  const pendingEntry = period.preview?.permanent?.pendingEntry === true;
  const firstName = outgoingName.split(' ')[0];

  const message = (key: string, testId: string): JSX.Element => (
    <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid={testId}>
      {key}
    </Text>
  );

  const feedback = (): JSX.Element | null => {
    if (problem === 'past') return message(t('admin.patients.detail.itinerary.actionErrors.ABSENCE_DATE_IN_PAST'), 'substitucion-periodo-pasado');
    if (problem === 'toBeforeFrom') return message(ts('toBeforeFrom'), 'substitucion-periodo-invertido');
    if (problem !== null) return null;
    if (period.status === 'loading') {
      return (
        <Text size="sm" color="tertiary" data-testid="substitucion-turnos-cargando">
          {ts('loadingShifts')}
        </Text>
      );
    }
    if (period.status === 'error') {
      const known = period.errorCode !== null && i18n.exists(`admin.patients.detail.itinerary.actionErrors.${period.errorCode}`);
      return message(known ? t(`admin.patients.detail.itinerary.actionErrors.${period.errorCode}`) : ts('previewError'), 'substitucion-turnos-error');
    }
    if (period.status !== 'ok') return null;
    return (
      <>
        <Text size="sm" weight="semibold" color="primary" data-testid="substitucion-turnos-cuenta">
          {draft.type === 'PERMANENT'
            ? ts('permanentCount', { name: firstName, count: shifts.length })
            : ts('shiftsCount', { name: firstName, count: shifts.length })}
        </Text>
        {draft.type !== 'PERMANENT' && <ShiftChips shifts={shifts} language={i18n.language} />}
        {pendingEntry && message(t('admin.patients.detail.itinerary.actionErrors.WORKER_HAS_PENDING_ENTRY'), 'substitucion-entrada-pendiente')}
      </>
    );
  };

  const dateFields = (type: SubstitutionRequestType): JSX.Element => {
    if (type === 'DAYS') {
      return (
        <div className="flex gap-2.5">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <Text as="span" size="xs" weight="semibold" color="tertiary">
              {ts('from')}
            </Text>
            <DdMmDateInput value={draft.from} onChange={(from) => onChange({ from })} ariaLabel={ts('from')} data-testid="substitucion-desde" />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <Text as="span" size="xs" weight="semibold" color="tertiary">
              {ts('to')}
            </Text>
            <DdMmDateInput value={draft.to} onChange={(to) => onChange({ to })} ariaLabel={ts('to')} data-testid="substitucion-hasta" />
          </label>
        </div>
      );
    }
    return (
      <label className="flex flex-col gap-1">
        <Text as="span" size="xs" weight="semibold" color="tertiary">
          {type === 'PERMANENT' ? ts('since') : ts('date')}
        </Text>
        <DdMmDateInput value={draft.from} onChange={(from) => onChange({ from })} ariaLabel={type === 'PERMANENT' ? ts('since') : ts('date')} data-testid="substitucion-fecha" />
      </label>
    );
  };

  return (
    <div className="flex flex-col gap-2.5" role="radiogroup" aria-label={ts('title')}>
      {OPTIONS.map((type) => (
        <OptionCard
          key={type}
          name="substitucion-duracion"
          selected={draft.type === type}
          onSelect={() => onChange({ type })}
          title={ts(`options.${type}.title`)}
          description={ts(`options.${type}.description`)}
          data-testid={`substitucion-duracion-${type}`}
        >
          {dateFields(type)}
          {feedback()}
        </OptionCard>
      ))}
    </div>
  );
}
