import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import type { SubstitutionPreview } from '@domain/entities/SubstitutionRequest';
import { useCoverCandidates, useOutgoingCandidates } from '@hooks/admin/useSubstitutionPeople';
import { useSubstitutionPreview } from '@hooks/admin/useSubstitutionPreview';
import { classifyActionError } from '@hooks/admin/contractedServiceActionError';
import { workerLabel } from '../workerLabel';
import { SubstitutionModalShell } from './SubstitutionModalShell';
import { StepHowLong } from './steps/StepHowLong';
import { StepReasonSummary } from './steps/StepReasonSummary';
import { StepWho } from './steps/StepWho';
import { StepWhoCovers } from './steps/StepWhoCovers';
import {
  EMPTY_DRAFT,
  canAdvanceCover,
  chosenWorkers,
  createBody,
  periodPreviewBody,
  periodProblem,
  resolveCover,
  type FlowDraft,
} from './flowModel';

const TOTAL_STEPS = 4;

interface NewSubstitutionFlowProps {
  patientId: string;
  serviceId: string;
  /** "Hoje" da API — a data passada se mede contra ela, nunca contra o relógio do navegador. */
  asOf: string;
  /** "Cambiar" num turno: a pessoa e o dia já vêm preenchidos e o fluxo abre direto em "¿Quién la cubre?". */
  prefill: PatientItineraryEvent | null;
  onClose: () => void;
  /** O pedido foi criado: a aba refaz as leituras e fecha o fluxo. */
  onCreated: () => void;
}

const FIELDS_THAT_RESET_COVER: Array<keyof FlowDraft> = ['outgoingWorkerId', 'type', 'from', 'to'];

function initialDraft(prefill: PatientItineraryEvent | null): FlowDraft {
  if (prefill === null) return EMPTY_DRAFT;
  return { ...EMPTY_DRAFT, outgoingWorkerId: prefill.titularWorkerId ?? prefill.workerId, type: 'ONE_DAY', from: prefill.date };
}

/**
 * "Nueva sustitución" (spec 069, US3-US6): modal de ~540 px em 4 passos — ¿Quién no va a venir? → ¿Por cuánto tiempo? →
 * ¿Quién la cubre? → Motivo y resumen. A tela só COLETA a escolha do operador: os turnos, o conflito e o estado novo são da pré-visão
 * do servidor; o pedido sai numa chamada só (uma transação no back). Mudar pessoa, tipo ou datas zera a cobertura já escolhida —
 * os turnos mudaram, a escolha antiga não vale mais.
 */
export function NewSubstitutionFlow({ patientId, serviceId, asOf, prefill, onClose, onCreated }: NewSubstitutionFlowProps): JSX.Element {
  const { t } = useTranslation();
  const tf = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.flow.${key}`, opts);
  const [step, setStep] = useState(prefill === null ? 1 : 3);
  const [draft, setDraft] = useState<FlowDraft>(() => initialDraft(prefill));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const outgoing = useOutgoingCandidates(patientId, serviceId);
  const coverPool = useCoverCandidates(patientId, serviceId);

  const periodBody = draft.outgoingWorkerId !== null && step >= 2 ? periodPreviewBody(draft, asOf) : null;
  const period = useSubstitutionPreview(patientId, serviceId, periodBody);
  const shifts = period.preview?.shifts ?? [];
  const cover = resolveCover(draft, shifts);
  const chosen = chosenWorkers(cover);
  const conflictBody = step >= 3 && period.status === 'ok' && chosen.length > 0 ? periodPreviewBody(draft, asOf, chosen) : null;
  const conflicts = useSubstitutionPreview(patientId, serviceId, conflictBody);
  const conflictList = conflicts.preview?.conflicts ?? null;

  const outgoingName = draft.outgoingWorkerId === null ? null : workerLabel(t, draft.outgoingWorkerId, outgoing.people.find((p) => p.workerId === draft.outgoingWorkerId)?.displayName ?? null);
  const candidates = coverPool.candidates.filter((c) => c.workerId !== draft.outgoingWorkerId);
  const permanent = draft.type === 'PERMANENT';
  const destinationAsked = permanent && draft.from === asOf;
  const pendingEntry = period.preview?.permanent?.pendingEntry === true;

  const patch = (change: Partial<FlowDraft>): void => {
    setSubmitError(null);
    setDraft((current) => ({
      ...current,
      ...change,
      ...(FIELDS_THAT_RESET_COVER.some((field) => field in change && change[field] !== current[field]) ? { coverMode: null, person: null, dayChoices: {} } : {}),
    }));
  };

  const canNext = (): boolean => {
    if (step === 1) return draft.outgoingWorkerId !== null;
    if (step === 2) return draft.type !== null && periodProblem(draft, asOf) === null && period.status === 'ok' && shifts.length > 0 && !pendingEntry;
    if (step === 3) return canAdvanceCover(draft, shifts, conflictList) && (chosen.length === 0 || conflicts.status === 'ok');
    return draft.reason !== '' && (!destinationAsked || draft.destination !== '') && !submitting && !pendingEntry;
  };

  const confirm = async (): Promise<void> => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await AdminSubstitutionRequestsApiService.create(patientId, serviceId, createBody(draft, shifts, destinationAsked));
      onCreated();
    } catch (err) {
      const classified = classifyActionError(err);
      setSubmitError(classified.kind === 'coded' ? classified.code : 'GENERIC');
      setSubmitting(false);
    }
  };

  const heading = ['who', 'howLong', 'whoCovers', 'summary'][step - 1];
  const needsBlockHint = step === 3 && draft.coverMode !== null && !canNext() && !(conflicts.status === 'loading');

  return (
    <SubstitutionModalShell
      title={tf('title')}
      heading={tf(`${heading}.title`)}
      progress={{ current: step, total: TOTAL_STEPS }}
      onClose={onClose}
      data-testid="substitucion-flujo"
      footer={
        <>
          <Button variant="outline" size="sm" disabled={step === 1} onClick={() => setStep((s) => s - 1)} data-testid="substitucion-atras">
            {tf('back')}
          </Button>
          {needsBlockHint && (
            <span className="min-w-0 flex-1 text-center" data-testid="substitucion-bloqueo">
              <span className="font-lexend text-xs text-[#374151]">{tf('whoCovers.blocked')}</span>
            </span>
          )}
          {step < TOTAL_STEPS ? (
            <Button size="sm" disabled={!canNext()} onClick={() => setStep((s) => s + 1)} data-testid="substitucion-siguiente">
              {tf('next')}
            </Button>
          ) : (
            <Button size="sm" disabled={!canNext()} onClick={() => void confirm()} data-testid="substitucion-confirmar">
              {submitting ? tf('confirming') : tf('confirm')}
            </Button>
          )}
        </>
      }
    >
      {step === 1 && <StepWho people={outgoing.people} status={outgoing.status} selected={draft.outgoingWorkerId} onSelect={(id) => patch({ outgoingWorkerId: id })} />}
      {step === 2 && <StepHowLong draft={draft} onChange={patch} asOf={asOf} outgoingName={outgoingName as string} period={period} />}
      {step === 3 && (
        <StepWhoCovers draft={draft} onChange={patch} shifts={shifts} candidates={candidates} candidatesStatus={coverPool.status} conflicts={conflicts} permanent={permanent} />
      )}
      {step === 4 && (
        <StepReasonSummary
          draft={draft}
          onChange={patch}
          asOf={asOf}
          shifts={shifts}
          preview={period.preview as SubstitutionPreview}
          outgoingName={outgoingName}
          candidates={candidates}
          submitError={submitError}
        />
      )}
    </SubstitutionModalShell>
  );
}
