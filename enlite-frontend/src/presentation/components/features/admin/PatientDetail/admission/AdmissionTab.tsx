/**
 * AdmissionTab — aba "Admisión" da ficha do paciente (spec 049, F7): as reuniões de admissão (as do painel E as que a
 * família marcou pelo site), da mais recente para a mais antiga, com os selos de saúde; "Nueva agenda", cancelar e
 * reenviar o WhatsApp que falhou.
 *
 * Células (D286): a LEITURA é do container (`ContainerGate resource="patient_admission"` na página); aqui, escrever
 * (`:create` libera "Nueva agenda"; `:update` libera "Cancelar" — convenção PR-8b, sem `write`), e `:resend_message` libera "Reenviar". Sem a célula o botão SOME.
 * Horários sempre no fuso do país do paciente. Nada de PII em log: este componente não loga.
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, Loader2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { useAdmissionAppointments } from '@hooks/admin/useAdmissionAppointments';
import {
  AdminAdmissionApiService,
  type AdmissionAppointment,
  type AdmissionCountry,
  type ResendKind,
} from '@infrastructure/http/AdminAdmissionApiService';
import { AdmissionAppointmentRow } from './AdmissionAppointmentRow';
import { AdmissionConfirmDialog } from './AdmissionConfirmDialog';
import { NewAdmissionModal } from './NewAdmissionModal';
import { cancelErrorKey, isStateConflict, resendErrorKey } from './admissionErrors';
import { timeZoneForCountry } from './admissionTime';

interface Props {
  patientId: string;
  /** País do paciente: define o roster e o fuso. Fora de AR/BR cai em AR (o roster de admissão só existe nesses dois). */
  country: string;
  /** Leva à aba Documentos (o selo "Documento" é atalho para o resumo). Ausente = aba Documentos invisível. */
  onOpenDocuments?: () => void;
  /** Relógio injetável (teste). */
  now?: () => Date;
}

interface Pending {
  appointment: AdmissionAppointment;
  kind?: ResendKind;
}

const asAdmissionCountry = (c: string): AdmissionCountry => (c === 'BR' ? 'BR' : 'AR');

export function AdmissionTab({ patientId, country, onOpenDocuments, now = () => new Date() }: Props): JSX.Element {
  const { t } = useTranslation();
  const ta = (key: string): string => t(`admin.patients.detail.admissionTab.${key}`);
  const updateGate = useActionGate('patient_admission', 'update');
  const resendGate = useActionGate('patient_admission', 'resend_message');
  const { appointments, status, reload } = useAdmissionAppointments(patientId);
  const timeZone = timeZoneForCountry(country);

  const [newOpen, setNewOpen] = useState(false);
  const [pendingCancel, setPendingCancel] = useState<Pending | null>(null);
  const [pendingResend, setPendingResend] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const closeDialogs = (): void => {
    setPendingCancel(null);
    setPendingResend(null);
    setDialogError(null);
  };

  const confirmCancel = async (): Promise<void> => {
    if (!pendingCancel) return;
    setBusy(true);
    setDialogError(null);
    try {
      await AdminAdmissionApiService.cancelAppointment(patientId, pendingCancel.appointment.id);
      closeDialogs();
      setNotice(null);
      await reload();
    } catch (err) {
      setDialogError(t(cancelErrorKey(err)));
      if (isStateConflict(err)) await reload();
    } finally {
      setBusy(false);
    }
  };

  const confirmResend = async (): Promise<void> => {
    if (!pendingResend?.kind) return;
    setBusy(true);
    setDialogError(null);
    try {
      const out = await AdminAdmissionApiService.resendMessage(patientId, pendingResend.appointment.id, pendingResend.kind);
      closeDialogs();
      // Falha de envio / skip NÃO é erro de HTTP: a tentativa foi gasta e o selo mostra o resultado.
      setNotice(out.outcome === 'sent' ? ta('resend.sent') : ta('resend.notSent'));
      await reload();
    } catch (err) {
      // 409 = o estado mudou (entregue, teto, outra pessoa reenviou): mostra o motivo e recarrega para o botão sumir.
      setDialogError(t(resendErrorKey(err)));
      if (isStateConflict(err)) await reload();
    } finally {
      setBusy(false);
    }
  };

  const nowDate = now();

  return (
    <div className="flex flex-col gap-4" data-testid="admission-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading level={2} weight="semibold" color="secondary">{ta('title')}</Heading>
        <ActionButton
          resource="patient_admission"
          action="create"
          variant="primary"
          size="sm"
          onClick={() => { setNotice(null); setNewOpen(true); }}
          data-testid="admission-new-button"
        >
          <CalendarPlus className="w-4 h-4 mr-2" aria-hidden="true" />
          {ta('newButton')}
        </ActionButton>
      </div>

      {notice && <Text color="inherit" as="p" size="sm" role="status" className="text-green-900" data-testid="admission-notice">{notice}</Text>}

      {status === 'loading' && (
        <div className="flex items-center gap-2 text-slate-600 text-sm" data-testid="admission-loading">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          {ta('loading')}
        </div>
      )}
      {status === 'error' && (
        <Text color="inherit" as="p" size="sm" role="alert" className="text-red-800" data-testid="admission-load-error">{ta('loadError')}</Text>
      )}
      {status === 'ok' && appointments.length === 0 && (
        <Text color="inherit" as="p" size="sm" className="italic text-slate-600" data-testid="admission-empty">{ta('empty')}</Text>
      )}
      {status === 'ok' && appointments.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="admission-list">
          {appointments.map((a) => (
            <AdmissionAppointmentRow
              key={a.id}
              appointment={a}
              timeZone={timeZone}
              canResendCell={resendGate.allowed}
              canCancel={updateGate.allowed}
              now={nowDate}
              onOpenDocuments={onOpenDocuments}
              onResend={(kind) => { setDialogError(null); setPendingResend({ appointment: a, kind }); }}
              onCancel={() => { setDialogError(null); setPendingCancel({ appointment: a }); }}
            />
          ))}
        </div>
      )}

      {newOpen && (
        <NewAdmissionModal
          patientId={patientId}
          country={asAdmissionCountry(country)}
          now={now}
          onClose={() => setNewOpen(false)}
          onBooked={() => { setNewOpen(false); void reload(); }}
        />
      )}
      {pendingCancel && (
        <AdmissionConfirmDialog
          testId="admission-cancel-dialog"
          title={ta('cancel.title')}
          body={ta('cancel.body')}
          confirmLabel={ta('cancel.confirm')}
          busyLabel={ta('cancel.busy')}
          busy={busy}
          error={dialogError}
          onConfirm={() => { void confirmCancel(); }}
          onClose={closeDialogs}
        />
      )}
      {pendingResend && (
        <AdmissionConfirmDialog
          testId="admission-resend-dialog"
          title={ta('resend.title')}
          body={ta(pendingResend.kind === 'reminder_30min' ? 'resend.bodyReminder' : 'resend.bodyConfirmation')}
          confirmLabel={ta('resend.confirm')}
          busyLabel={ta('resend.busy')}
          busy={busy}
          error={dialogError}
          onConfirm={() => { void confirmResend(); }}
          onClose={closeDialogs}
        />
      )}
    </div>
  );
}
