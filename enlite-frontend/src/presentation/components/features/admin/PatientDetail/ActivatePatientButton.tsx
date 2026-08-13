import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Rocket } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { useToast } from '@presentation/hooks/useToast';

interface Props {
  patientId: string;
  status: string | null;
  /** Called after a successful activation so the page can refetch. */
  onActivated: () => void;
}

/** Statuses from which activation is allowed (hidden once ACTIVE). */
const ACTIVATABLE = new Set(['ADMISSION', 'PENDING_ADMISSION']);

/**
 * "Activar paciente" — visible only when the patient is in an activatable
 * status. On confirm, POSTs /activate (creates one draft vacancy per active
 * location). Handles the three backend outcomes: success (toast + refetch),
 * 422 no-address (clear inline message), and idempotent already-active.
 */
export function ActivatePatientButton({ patientId, status, onActivated }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const showToast = useToast();
  const ta = (k: string) => t(`admin.patients.activate.${k}`);

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status || !ACTIVATABLE.has(status)) return null;

  const handleConfirm = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result = await AdminApiService.activatePatient(patientId);
      showToast(ta('successToast').replace('{{count}}', String(result.createdVacancyIds.length)), 'success');
      setConfirming(false);
      onActivated();
    } catch (err) {
      if (err instanceof PatientApiError && err.status === 422) {
        setError(ta('noAddress'));
      } else {
        setError(err instanceof Error ? err.message : ta('error'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        onClick={() => { setError(null); setConfirming(true); }}
        className="flex items-center gap-2"
        data-testid="activate-patient-btn"
      >
        <Rocket className="w-4 h-4" />
        {ta('button')}
      </Button>

      {confirming && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => !busy && setConfirming(false)}
            data-testid="activate-confirm-backdrop"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={ta('confirmTitle')}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 flex flex-col gap-4"
            data-testid="activate-confirm-modal"
          >
            <Heading level={3} weight="semibold" color="primary">{ta('confirmTitle')}</Heading>
            <Text size="sm" color="secondary">{ta('confirmBody')}</Text>
            {error && <Text size="sm" className="text-red-600" data-testid="activate-error">{error}</Text>}
            <div className="flex items-center justify-end gap-3 mt-2">
              <Button variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={busy} data-testid="activate-cancel">
                {ta('cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={handleConfirm} isLoading={busy} data-testid="activate-confirm">
                {ta('confirm')}
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
