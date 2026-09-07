import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import type { PatientDetail, UpdatePatientStatusPayload } from '@domain/entities/PatientDetail';
import { CLINICAL_PATIENT_STATUSES, ON_HOLD_REASONS } from '@domain/entities/patientEnums';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { FormField } from '@presentation/components/molecules/FormField';
import { Label } from '@presentation/components/atoms/Label';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';

interface Props {
  patient: PatientDetail;
  /** Called after a successful move so the page can refetch (status badge + Historial). */
  onSaved: () => void;
}

/** Teto de `on_hold_note` — espelha o schema do servidor (lex C7.1-f). */
export const ON_HOLD_NOTE_MAX = 2000;

/**
 * O estado clínico v2 da ficha (spec 012, US-B7): select dos seis estados; ON_HOLD abre motivo
 * (obrigatório) + nota. A regra de transição é do SERVIDOR (patient_status_transitions, 422 com
 * código) — a tela só traduz a recusa. Só existe para quem já passou pela admissão; antes disso o
 * caminho é o botão "Activar paciente".
 *
 * A nota é texto clínico restrito (pacote D211.2): `data-clarity-mask` no wrapper, e quando o
 * backend a redigiu para este ator (`onHoldNoteRedacted`) o campo nem é editável — não há valor
 * real para preservar.
 */
export function PatientStatusControl({ patient, onSaved }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const ts = (k: string, opts?: Record<string, string>): string => String(t(`admin.patients.status.${k}`, opts ?? {}));

  const current = patient.status ?? 'ACTIVE';
  const [status, setStatus] = useState<string>(current);
  const [reason, setReason] = useState<string>(patient.onHoldReason ?? '');
  const [note, setNote] = useState<string>(patient.onHoldNote ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (patient.admissionStatus !== 'DONE') return null;

  const goingOnHold = status === 'ON_HOLD';
  const changed = status !== current || (goingOnHold && (reason !== (patient.onHoldReason ?? '') || note !== (patient.onHoldNote ?? '')));
  const canSave = changed && (!goingOnHold || reason !== '') && !busy;

  const statusOptions: SelectOption[] = CLINICAL_PATIENT_STATUSES.map((s) => ({ value: s, label: t(`admin.patients.statusOptions.${s}`, s) }));
  const reasonOptions: SelectOption[] = ON_HOLD_REASONS.map((r) => ({ value: r, label: t(`admin.patients.onHoldReasonOptions.${r}`, r) }));
  const label = (s: string) => t(`admin.patients.statusOptions.${s}`, s);

  const handleSave = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    const payload: UpdatePatientStatusPayload = { status };
    if (goingOnHold) {
      payload.onHoldReason = reason;
      // Redigido para este ator: a CHAVE nem entra no corpo — `onHoldNote: null` é ESCRITA
      // (apaga a nota clínica, sem segunda cópia em lugar nenhum). Mesmo molde dos dois irmãos
      // desta ficha: PatientClinicalEditDrawer (emergencyInstructions) e ContractedServiceFormRow
      // (hourlyValue). O textarea nasce vazio e desabilitado — não há valor real para preservar.
      if (!patient.onHoldNoteRedacted) payload.onHoldNote = note.trim() ? note : null;
    }
    try {
      await AdminApiService.updatePatientStatus(patient.id, payload);
      onSaved();
    } catch (err) {
      if (err instanceof PatientApiError && err.code === 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED') {
        const d = (err.details ?? {}) as { from?: string; to?: string };
        setError(ts('transitionNotAllowed', { from: label(d.from ?? current), to: label(d.to ?? status) }));
      } else if (err instanceof PatientApiError && err.code === 'ON_HOLD_REASON_REQUIRED') {
        setError(ts('reasonRequired'));
      } else {
        setError(err instanceof Error ? err.message : ts('error'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 min-w-[240px]" data-testid="patient-status-control">
      {/* 06/09 (Gabriel): o rótulo "Estado" ficava ACIMA do select, empilhado, e o bloco inteiro
          era mais alto que os botões vizinhos do cabeçalho — o controle flutuava numa altura
          própria. Agora é UMA linha: rótulo, select e ação lado a lado. O `Label` continua ligado
          ao select por `htmlFor`, então o nome acessível não se perde; só deixou de empilhar.
          Os campos de ON_HOLD (motivo e nota) seguem empilhando abaixo, como antes. */}
      <div className="flex items-center gap-2">
        <Label htmlFor="patient-status-select" size="compact" className="shrink-0 whitespace-nowrap">
          {ts('title')}
        </Label>
        <SelectField
          id="patient-status-select"
          inputSize="compact"
          options={statusOptions}
          value={status}
          onChange={(v) => { setStatus(v); setError(null); }}
          data-testid="patient-status-select"
        />
        <Button type="button" variant="primary" size="sm" onClick={handleSave} disabled={!canSave} isLoading={busy} data-testid="patient-status-save">
          {ts('save')}
        </Button>
      </div>
      {goingOnHold && (
        <>
          <FormField label={ts('reason')} htmlFor="patient-status-reason" required>
            <SelectField
              id="patient-status-reason"
              inputSize="compact"
              options={reasonOptions}
              placeholder={t('admin.patients.editDrawer.unset')}
              value={reason}
              onChange={(v) => setReason(v)}
              data-testid="patient-status-reason"
            />
          </FormField>
          <FormField label={ts('note')} htmlFor="patient-status-note" optional>
            {/* Texto clínico restrito (D211.2): o Clarity não pode gravar. */}
            <div data-clarity-mask="True">
              <Textarea
                id="patient-status-note"
                inputSize="compact"
                resize="vertical"
                rows={3}
                maxLength={ON_HOLD_NOTE_MAX}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={!!patient.onHoldNoteRedacted}
                placeholder={patient.onHoldNoteRedacted ? ts('noteRedacted') : ts('notePlaceholder')}
                data-testid="patient-status-note"
              />
            </div>
          </FormField>
        </>
      )}
      {error && <Text size="sm" className="text-red-600" data-testid="patient-status-error">{error}</Text>}
    </div>
  );
}
