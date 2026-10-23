import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { PersonAvatar } from '@presentation/components/atoms/PersonAvatar';
import { Combobox } from '@presentation/components/atoms/Combobox';
import { Text } from '@presentation/components/atoms/Text';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import type { PreviewConflict, PreviewShift, SubstitutionPreviewBody, SubstitutionRequestItem } from '@domain/entities/SubstitutionRequest';
import { classifyActionError } from '@hooks/admin/contractedServiceActionError';
import { useCoverCandidates } from '@hooks/admin/useSubstitutionPeople';
import { useSubstitutionPreview } from '@hooks/admin/useSubstitutionPreview';
import { AllocationOptionStatus } from '../AllocationOptionStatus';
import { workerLabel } from '../workerLabel';
import { SingleLine, NOWRAP } from './SingleLine';
import { ConflictBadge, ConflictNote, type ConflictBadgeState } from './ConflictParts';
import { SubstitutionModalShell } from './SubstitutionModalShell';
import { conflictFor, shiftKey } from './flowModel';
import { shiftChipLabel } from './substitutionLabels';

export type CoverTarget =
  /** "Elegir quién entra" da aba "Sustituciones": todos os turnos do pedido que seguem sem ninguém (rota `:rid/cover`). */
  | { kind: 'request'; request: SubstitutionRequestItem }
  /** "Asignar"/"Cambiar" de UM turno da tabela: a falta daquele turno (rota `absences/:id/substitute`). */
  | { kind: 'absence'; event: PatientItineraryEvent };

interface CoverSubstituteModalProps {
  patientId: string;
  serviceId: string;
  asOf: string;
  target: CoverTarget;
  onClose: () => void;
  onDone: () => void;
}

interface Plan {
  outgoingWorkerId: string;
  body: Omit<SubstitutionPreviewBody, 'candidateWorkerIds'> | null;
  /** Os turnos da pré-visão que ESTE cover cobre (os outros do período já têm quem entra). */
  covers: (shift: PreviewShift) => boolean;
}

const ALL_SHIFTS = (): boolean => true;

/** O que perguntar à pré-visão e quais turnos dela contam — a regra de conflito é do servidor (`ignoreRequestId` tira a própria falta da conta). */
function planOf(target: CoverTarget, asOf: string): Plan {
  if (target.kind === 'absence') {
    const { event } = target;
    const outgoingWorkerId = event.titularWorkerId as string;
    // Falta de ANTES dos pedidos (sem `requestId`): não há como ignorá-la na pré-visão; vale a barreira final do banco.
    const body = event.requestId === null ? null : { type: 'ONE_DAY' as const, outgoingWorkerId, from: event.date, ignoreRequestId: event.requestId };
    return { outgoingWorkerId, body, covers: (s) => s.slotId === event.slotId };
  }
  const { request } = target;
  if (request.type === 'PERMANENT') {
    const from = request.from > asOf ? request.from : asOf;
    return { outgoingWorkerId: request.outgoingWorkerId, body: { type: 'PERMANENT', outgoingWorkerId: request.outgoingWorkerId, from }, covers: ALL_SHIFTS };
  }
  const open = request.shifts.filter((s) => s.workerId === null && s.date >= asOf);
  if (open.length === 0) return { outgoingWorkerId: request.outgoingWorkerId, body: null, covers: ALL_SHIFTS };
  const dates = open.map((s) => s.date).sort();
  const keys = new Set(open.map((s) => `${s.assignmentId}|${s.date}`));
  const [from, to] = [dates[0], dates[dates.length - 1]];
  const body =
    request.type === 'ONE_DAY'
      ? { type: 'ONE_DAY' as const, outgoingWorkerId: request.outgoingWorkerId, from, ignoreRequestId: request.requestId as string }
      : { type: 'DAYS' as const, outgoingWorkerId: request.outgoingWorkerId, from, to, ignoreRequestId: request.requestId as string };
  return { outgoingWorkerId: request.outgoingWorkerId, body, covers: (s) => keys.has(`${s.assignmentId}|${s.date}`) };
}

/**
 * "Elegir quién entra" (spec 069, T608/FR-20): uma só pergunta — quem cobre —, com o MESMO conflito tri-estado do fluxo (a pré-visão
 * ignora a própria falta do pedido). "Asignar" só habilita com a pessoa LIVRE em todos os turnos que ela vai cobrir; conflito, falha
 * da verificação e espera bloqueiam. O pool é o do serviço (`allocation-options`), nunca o próprio titular.
 */
export function CoverSubstituteModal({ patientId, serviceId, asOf, target, onClose, onDone }: CoverSubstituteModalProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const tc = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.cover.${key}`, opts);
  const [selected, setSelected] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pool = useCoverCandidates(patientId, serviceId);
  const plan = planOf(target, asOf);
  const nothingToCover = target.kind === 'request' && plan.body === null;

  const body = plan.body !== null && selected !== '' ? ({ ...plan.body, candidateWorkerIds: [selected] } as SubstitutionPreviewBody) : null;
  const preview = useSubstitutionPreview(patientId, serviceId, body);
  const shifts = (preview.preview?.shifts ?? []).filter(plan.covers);
  const conflicts: PreviewConflict[] | null = preview.preview?.conflicts ?? null;
  const candidates = pool.candidates.filter((c) => c.workerId !== plan.outgoingWorkerId);
  const person = candidates.find((c) => c.workerId === selected);
  const nameById = new Map(candidates.map((c) => [c.workerId, c.displayName]));
  const nameOf = (id: string): string => workerLabel(t, id, nameById.get(id) ?? null);

  const stateOf = (shift: PreviewShift): ConflictBadgeState => {
    const { state } = conflictFor(conflicts, selected, shift);
    return preview.status !== 'ok' || state === 'pending' ? 'checking' : state;
  };
  const verified = plan.body === null || (preview.status === 'ok' && shifts.length > 0 && shifts.every((s) => stateOf(s) === 'free'));
  const canConfirm = selected !== '' && !nothingToCover && verified && !submitting;

  const confirm = async (): Promise<void> => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (target.kind === 'request') await AdminSubstitutionRequestsApiService.cover(patientId, serviceId, target.request.requestId as string, selected);
      else await AdminContractedServicesApiService.setAbsenceSubstitute(patientId, serviceId, target.event.absenceId as string, selected);
      onDone();
    } catch (err) {
      const classified = classifyActionError(err);
      setSubmitError(classified.kind === 'coded' ? classified.code : 'GENERIC');
      setSubmitting(false);
    }
  };

  return (
    <SubstitutionModalShell
      title={tc('title')}
      heading={tc('heading')}
      onClose={onClose}
      data-testid="sustitucion-cubrir"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} data-testid="sustitucion-cubrir-cancelar">
            {tc('cancel')}
          </Button>
          <Button size="sm" disabled={!canConfirm} onClick={() => void confirm()} data-testid="sustitucion-cubrir-confirmar">
            {submitting ? tc('confirming') : tc('confirm')}
          </Button>
        </>
      }
    >
      {nothingToCover ? (
        <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="sustitucion-cubrir-nada">
          {t('admin.patients.detail.itinerary.actionErrors.NOTHING_TO_COVER')}
        </Text>
      ) : (
        <>
          {pool.status === 'error' && (
            <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="sustitucion-cubrir-candidatos-error">
              {t('admin.patients.detail.itinerary.flow.whoCovers.candidatesError')}
            </Text>
          )}
          <Combobox
            inputSize="compact"
            aria-label={t('admin.patients.detail.itinerary.flow.whoCovers.pickPerson')}
            data-testid="sustitucion-cubrir-persona"
            className="[&_button]:!text-primary"
            placeholder={t('admin.patients.detail.itinerary.flow.whoCovers.pickPerson')}
            value={selected}
            options={candidates.map((c) => ({ value: c.workerId, label: nameOf(c.workerId) }))}
            onChange={setSelected}
          />
          {person && (
            <div className="flex min-w-0 items-center gap-2.5" data-testid="sustitucion-cubrir-elegida">
              <PersonAvatar uid={person.workerId} name={nameOf(person.workerId)} size={32} />
              <SingleLine weight="semibold" color="primary">
                {nameOf(person.workerId)}
              </SingleLine>
              {person.status && (
                <span className="shrink-0 whitespace-nowrap" {...NOWRAP}>
                  <AllocationOptionStatus status={person.status} />
                </span>
              )}
            </div>
          )}
          {selected !== '' && shifts.map((shift) => {
            const key = shiftKey(shift);
            const { conflict } = conflictFor(conflicts, selected, shift);
            return (
              <div key={key} className="flex flex-col gap-2" data-testid={`sustitucion-cubrir-turno-${key}`}>
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="flex h-7 w-[130px] items-center justify-center whitespace-nowrap rounded-full bg-[#F1E8FF] text-[#3B0A8C]" {...NOWRAP}>
                    <Text as="span" size="xs" weight="medium" color="inherit" className="whitespace-nowrap">
                      {shiftChipLabel(shift.date, shift.startTime, shift.endTime, i18n.language)}
                    </Text>
                  </span>
                  <ConflictBadge state={stateOf(shift)} testId={`sustitucion-cubrir-estado-${key}`} />
                </div>
                {conflict !== null && conflict.state === 'conflict' && <ConflictNote conflict={conflict} name={nameOf(selected)} testId={`sustitucion-cubrir-conflicto-${key}`} />}
              </div>
            );
          })}
          {selected !== '' && preview.status === 'error' && (
            <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="sustitucion-cubrir-verificacion-error">
              {t('admin.patients.detail.itinerary.flow.whoCovers.previewError')}
            </Text>
          )}
          {submitError !== null && (
            <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="sustitucion-cubrir-error">
              {i18n.exists(`admin.patients.detail.itinerary.actionErrors.${submitError}`) ? t(`admin.patients.detail.itinerary.actionErrors.${submitError}`) : tc('error')}
            </Text>
          )}
        </>
      )}
    </SubstitutionModalShell>
  );
}
