import { useTranslation } from 'react-i18next';
import { PersonAvatar } from '@presentation/components/atoms/PersonAvatar';
import { Select } from '@presentation/components/atoms/Select';
import { Text } from '@presentation/components/atoms/Text';
import type { PreviewConflict, PreviewShift } from '@domain/entities/SubstitutionRequest';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';
import type { UseSubstitutionPreviewResult } from '@hooks/admin/useSubstitutionPreview';
import { AllocationOptionStatus } from '../../AllocationOptionStatus';
import { workerLabel } from '../../workerLabel';
import { conflictFor, resolveCover, shiftKey, type CoverMode, type FlowDraft } from '../flowModel';
import { shiftChipLabel } from '../substitutionLabels';
import { ConflictBadge, ConflictNote, type ConflictBadgeState } from '../ConflictParts';
import { OptionCard } from './OptionCard';

interface StepWhoCoversProps {
  draft: FlowDraft;
  onChange: (patch: Partial<FlowDraft>) => void;
  shifts: PreviewShift[];
  candidates: ServiceTeamMember[];
  candidatesStatus: 'loading' | 'ok' | 'error';
  /** A pré-visão de conflito dos prestadores ESCOLHIDOS (tri-estado, da função do banco). */
  conflicts: UseSubstitutionPreviewResult;
  permanent: boolean;
}

const MODES: CoverMode[] = ['one', 'perDay', 'nobody'];
/** Sentinela do `<select>` para "Nadie todavía" (o valor vazio já é "sem escolha"). */
const NOBODY = '__nobody__';

/**
 * Passo 3 — "¿Quién la cubre?" (P16: abre SEM escolha marcada). Uma pessoa para tudo · uma por día · "Nadie todavía". O conflito de
 * cada pessoa × turno vem da pré-visão do servidor (`itinerary_worker_conflict`) em 3 estados: `free` · `conflict` · `unknown` ("no se
 * pudo verificar" — bloqueia como o conflito, nunca vale como livre). "Siguiente" só habilita com todo turno resolvido.
 */
export function StepWhoCovers({ draft, onChange, shifts, candidates, candidatesStatus, conflicts, permanent }: StepWhoCoversProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const ts = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.flow.whoCovers.${key}`, opts);
  const cover = resolveCover(draft, shifts);
  const byId = new Map(candidates.map((c) => [c.workerId, c]));
  const nameById = new Map(candidates.map((c) => [c.workerId, c.displayName]));
  const nameOf = (id: string): string => workerLabel(t, id, nameById.get(id) ?? null);
  const personOptions = candidates.map((c) => ({ value: c.workerId, label: nameOf(c.workerId) }));
  const conflictList: PreviewConflict[] | null = conflicts.preview?.conflicts ?? null;

  const stateOf = (workerId: string, shift: PreviewShift): ConflictBadgeState => {
    if (conflicts.status === 'error') return 'unknown';
    const { state } = conflictFor(conflictList, workerId, shift);
    return conflicts.status !== 'ok' || state === 'pending' ? 'checking' : state;
  };

  const conflictNoteFor = (workerId: string, shift: PreviewShift): JSX.Element | null => {
    const { conflict } = conflictFor(conflictList, workerId, shift);
    return conflict === null || conflict.state !== 'conflict' ? null : <ConflictNote conflict={conflict} name={nameOf(workerId)} testId={`substitucion-conflicto-${shiftKey(shift)}`} />;
  };

  /** Uma linha por turno: o chip, o estado do conflito e (quando precisa) o seletor "outra persona para ese día". */
  const shiftRow = (shift: PreviewShift, picker: 'always' | 'onConflict'): JSX.Element => {
    const key = shiftKey(shift);
    const who = cover[key];
    const state = typeof who === 'string' ? conflictFor(conflictList, who, shift).state : null;
    const showPicker = picker === 'always' || (state !== null && state !== 'free' && conflicts.status !== 'loading');
    const options = [{ value: NOBODY, label: ts('nobody.title') }, ...personOptions.filter((o) => o.value !== draft.person || picker === 'always')];
    return (
      <div key={key} className="flex flex-col gap-2" data-testid={`substitucion-turno-${key}`}>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="flex h-7 w-[130px] items-center justify-center whitespace-nowrap rounded-full bg-[#F1E8FF] text-[#3B0A8C]">
            <Text as="span" size="xs" weight="medium" color="inherit">
              {shiftChipLabel(shift.date, shift.startTime, shift.endTime, i18n.language)}
            </Text>
          </span>
          {typeof who === 'string' && <ConflictBadge state={stateOf(who, shift)} testId={`substitucion-estado-${key}`} />}
          {who === null && (
            <Text as="span" size="xs" weight="semibold" color="inherit" className="text-red-900">
              {ts('nobody.title')}
            </Text>
          )}
        </div>
        {typeof who === 'string' && conflictNoteFor(who, shift)}
        {showPicker && (
          <Select
            inputSize="compact"
            aria-label={picker === 'always' ? ts('perDay.pickFor', { day: shiftChipLabel(shift.date, shift.startTime, shift.endTime, i18n.language) }) : ts('pickOtherForDay')}
            data-testid={`substitucion-elegir-${key}`}
            className="[&_select]:!text-primary"
            placeholder={picker === 'always' ? ts('pickPerson') : ts('pickOtherForDay')}
            value={picker === 'onConflict' && !(key in draft.dayChoices) ? '' : who === undefined ? '' : who === null ? NOBODY : who}
            options={options}
            onValueChange={(value) => {
              if (value === '') return;
              onChange({ dayChoices: { ...draft.dayChoices, [key]: value === NOBODY ? null : value } });
            }}
          />
        )}
      </div>
    );
  };

  if (candidatesStatus === 'loading') {
    return (
      <Text size="sm" color="tertiary" data-testid="substitucion-candidatos-cargando">
        {ts('loadingCandidates')}
      </Text>
    );
  }

  const person = draft.person === null ? null : byId.get(draft.person);

  return (
    <div className="flex flex-col gap-2.5" role="radiogroup" aria-label={ts('title')}>
      {candidatesStatus === 'error' && (
        <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="substitucion-candidatos-error">
          {ts('candidatesError')}
        </Text>
      )}
      {MODES.filter((mode) => !(permanent && mode === 'perDay')).map((mode) => (
        <OptionCard
          key={mode}
          name="substitucion-cobertura"
          selected={draft.coverMode === mode}
          onSelect={() => onChange({ coverMode: mode })}
          title={ts(`${mode}.title`)}
          description={mode === 'nobody' ? ts('nobody.description') : undefined}
          data-testid={`substitucion-cobertura-${mode}`}
        >
          {mode === 'one' && (
            <>
              <Select
                inputSize="compact"
                aria-label={ts('pickPerson')}
                data-testid="substitucion-persona"
                className="[&_select]:!text-primary"
                placeholder={ts('pickPerson')}
                value={draft.person ?? ''}
                options={personOptions}
                onValueChange={(value) => onChange({ person: value === '' ? null : value, dayChoices: {} })}
              />
              {person && (
                <div className="flex items-center gap-2.5" data-testid="substitucion-persona-elegida">
                  <PersonAvatar uid={person.workerId} name={nameOf(person.workerId)} size={32} />
                  <Text as="span" weight="semibold" color="primary">
                    {nameOf(person.workerId)}
                  </Text>
                  {person.status && <AllocationOptionStatus status={person.status} />}
                </div>
              )}
              {draft.person !== null && shifts.map((shift) => shiftRow(shift, 'onConflict'))}
            </>
          )}
          {mode === 'perDay' && shifts.map((shift) => shiftRow(shift, 'always'))}
        </OptionCard>
      ))}
      {draft.coverMode !== null && conflicts.status === 'error' && (
        <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="substitucion-conflicto-error">
          {ts('previewError')}
        </Text>
      )}
    </div>
  );
}
