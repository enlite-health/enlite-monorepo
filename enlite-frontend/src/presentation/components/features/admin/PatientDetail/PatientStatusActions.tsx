import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import type { PatientCompletenessCode } from '@domain/entities/PatientCompleteness';
import type { PatientDetail, PatientStatusActionOption, PatientStatusActionPayload } from '@domain/entities/PatientDetail';
import { ON_HOLD_REASONS } from '@domain/entities/patientEnums';
import { ACTIVE_ALLOCATION_BLOCK, refusalFromError } from '@domain/entities/PatientStatusRefusal';
import { usePatientStatusActions } from '@hooks/admin/usePatientStatusActions';
import { friendlyStatusMessage, missingItemsLabel } from '@presentation/utils/patientStatusMessages';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { FormField } from '@presentation/components/molecules/FormField';
import { Combobox, type ComboboxOption } from '@presentation/components/atoms/Combobox';
import { SuspensionExitReasonSelect } from './SuspensionExitReasonSelect';

interface Props {
  patient: PatientDetail;
  /** Chamado depois de uma ação aplicada, para a página reler (badge de estado + Historial). */
  onSaved: () => void;
}

/** Teto de `on_hold_note` — espelha o schema do servidor (lex C7.1-f). */
const ON_HOLD_NOTE_MAX = 2000;

/**
 * F3 (estado-automatico-do-paciente, D5/D9) — as ações dos estados humanos na ficha: Pausar (com motivo), Suspender, Dar de alta, Dar de
 * baja, Retomar (re-deriva pelo itinerário) e Reativar (sair de Baja, re-derivado). A lista vem do SERVIDOR (a mesma avaliação da escrita):
 * a tela não decide FSM, permissão nem destino — retomar/reativar nem mandam destino. Ação bloqueada (completude que falta, prestador
 * alocado) aparece desabilitada com o motivo. Pausar e sair de Suspendido abrem o campo do motivo; as demais agem no clique. A nota de
 * Pausar é texto clínico restrito: `data-clarity-mask` e, redigida para este ator, nem é enviada.
 */
export function PatientStatusActions({ patient, onSaved }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const ts = (k: string, opts?: Record<string, string>): string => String(t(`admin.patients.status.${k}`, opts ?? {}));
  const ta = (k: string, opts?: Record<string, string>): string => ts(`actions.${k}`, opts);

  const refreshKey = `${patient.status}|${[...(patient.completeness?.missing ?? [])].sort().join(',')}`;
  const { state, reload } = usePatientStatusActions(patient.id, refreshKey, patient.admissionStatus === 'DONE');

  const [asking, setAsking] = useState<PatientStatusActionOption | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (patient.admissionStatus !== 'DONE' || state.phase === 'loading' || state.phase === 'readonly') return null;
  if (state.phase === 'error') {
    return (
      <div className="flex items-center gap-2" data-testid="patient-status-actions-error">
        <Text size="sm" className="text-red-600">{ta('loadError')}</Text>
        <Button type="button" variant="quiet" size="xs" onClick={reload} data-testid="patient-status-actions-retry">{ts('optionsRetry')}</Button>
      </div>
    );
  }
  if (state.actions.length === 0) return null;

  const lockedByAllocation = state.actions.some((a) => a.blockedBy?.includes(ACTIVE_ALLOCATION_BLOCK));
  const reasonOptions: ComboboxOption[] = ON_HOLD_REASONS.map((r) => ({ value: r, label: t(`admin.patients.onHoldReasonOptions.${r}`, r) }));
  const needsReason = asking?.exige.includes('onHoldReason') === true;
  const needsExitReason = asking?.exige.includes('suspensionExitReason') === true;
  const canConfirm = asking !== null && (!needsReason || reason !== '') && (!needsExitReason || exitReason !== '') && !busy;

  const reset = (): void => { setAsking(null); setReason(''); setNote(''); setExitReason(''); };

  const apply = async (a: PatientStatusActionOption): Promise<void> => {
    setError(null);
    setBusy(true);
    const payload: PatientStatusActionPayload = { action: a.acao };
    if (a.exige.includes('onHoldReason')) {
      payload.onHoldReason = reason;
      // Redigido para este ator, ou vazio: a CHAVE nem entra no corpo (`onHoldNote: null` APAGA a nota — o servidor a trata como escrita).
      if (!patient.onHoldNoteRedacted && note.trim()) payload.onHoldNote = note;
    }
    if (a.exige.includes('suspensionExitReason')) payload.suspensionExitReason = exitReason;
    try {
      await AdminApiService.performPatientStatusAction(patient.id, payload);
      reset();
      onSaved();
    } catch (err) {
      const api = err instanceof PatientApiError ? err : null;
      const friendly = api ? friendlyStatusMessage(t, refusalFromError(api, a.destino)) : null;
      // Nunca `err.message` do backend na tela: o código mapeado (friendly) ou o genérico i18n.
      setError(friendly ?? ts('error'));
      // A lista pode ter ficado velha (permissão revogada, dado completado em outra aba): relê.
      if (api && (api.status === 403 || api.status === 422)) reload();
    } finally {
      setBusy(false);
    }
  };

  const click = (a: PatientStatusActionOption): void => {
    setError(null);
    if (a.exige.length === 0) { void apply(a); return; }
    setAsking(a);
  };

  const blockedTitle = (a: PatientStatusActionOption): string | undefined => {
    const items = missingItemsLabel(t, a.blockedBy?.filter((c): c is PatientCompletenessCode => c !== ACTIVE_ALLOCATION_BLOCK));
    return items ? ts('blockedOption', { status: ta(`names.${a.acao}`), items }) : undefined;
  };

  return (
    <div className="flex flex-col gap-2" data-testid="patient-status-actions">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={ta('title')}>
        {state.actions.map((a) => (
          <Button
            key={a.acao}
            type="button"
            variant="quiet"
            size="xs"
            disabled={busy || !!a.blockedBy?.length}
            title={blockedTitle(a) ?? ta('willBecome', { status: String(t(`admin.patients.statusOptions.${a.destino}`, a.destino)) })}
            onClick={() => click(a)}
            data-testid={`patient-status-action-${a.acao}`}
          >
            {ta(`names.${a.acao}`)}
          </Button>
        ))}
      </div>
      {lockedByAllocation && (
        <Text size="sm" className="text-amber-700" data-testid="patient-status-actions-locked-notice">{ts('friendly.lockedByAllocation')}</Text>
      )}
      {asking && (
        <div className="flex flex-col gap-2" data-testid="patient-status-action-form">
          {needsReason && (
            <>
              <FormField label={ts('reason')} htmlFor="patient-status-action-reason" required>
                <Combobox
                  id="patient-status-action-reason"
                  inputSize="compact"
                  options={reasonOptions}
                  placeholder={t('admin.patients.editDrawer.unset')} clearLabel={t('admin.patients.editDrawer.unset')}
                  value={reason}
                  onChange={(v) => setReason(v)}
                  data-testid="patient-status-action-reason"
                />
              </FormField>
              <FormField label={ts('note')} htmlFor="patient-status-action-note" optional>
                {/* Texto clínico restrito (D211.2): o Clarity não pode gravar. */}
                <div data-clarity-mask="True">
                  <Textarea
                    id="patient-status-action-note"
                    inputSize="compact"
                    resize="vertical"
                    rows={3}
                    maxLength={ON_HOLD_NOTE_MAX}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    disabled={!!patient.onHoldNoteRedacted}
                    placeholder={patient.onHoldNoteRedacted ? ts('noteRedacted') : ts('notePlaceholder')}
                    data-testid="patient-status-action-note"
                  />
                </div>
              </FormField>
            </>
          )}
          {needsExitReason && (
            <SuspensionExitReasonSelect id="patient-status-action-exit-reason" value={exitReason} onChange={setExitReason} data-testid="patient-status-action-exit-reason" />
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="primary" size="xs" onClick={() => void apply(asking)} disabled={!canConfirm} isLoading={busy} data-testid="patient-status-action-confirm">
              {ta('confirm')}
            </Button>
            <Button type="button" variant="quiet" size="xs" onClick={reset} disabled={busy} data-testid="patient-status-action-cancel">
              {ta('cancel')}
            </Button>
          </div>
        </div>
      )}
      {error && <Text size="sm" className="text-red-600" data-testid="patient-status-action-error">{error}</Text>}
    </div>
  );
}
