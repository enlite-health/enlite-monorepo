import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useVacancyModalFlow } from '@hooks/admin/useVacancyModalFlow';
import { VacancyFormSection } from './VacancyFormSection';

export interface VacancyModalProps {
  mode: 'create' | 'edit';
  vacancyId?: string;
  isOpen: boolean;
  onClose: () => void;
  /** Receives the saved vacancy id; modal callers may ignore it. */
  onSuccess: (vacancyId: string) => void;
}

export function VacancyModal({
  mode,
  vacancyId,
  isOpen,
  onClose,
  onSuccess,
}: VacancyModalProps): JSX.Element {
  const { t } = useTranslation();
  const tp = (k: string) => t(`admin.vacancyModal.${k}`);

  const formRef = useRef<HTMLFormElement>(null);
  const [existingVacancy, setExistingVacancy] = useState<any | null>(null);
  const [isLoadingVacancy, setIsLoadingVacancy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const flow = useVacancyModalFlow();

  useEffect(() => {
    if (!isOpen) {
      flow.reset();
      setExistingVacancy(null);
      setLoadError(null);
      return;
    }

    if (mode === 'edit' && vacancyId) {
      setIsLoadingVacancy(true);
      setLoadError(null);
      AdminApiService.getVacancyById(vacancyId)
        .then((v) => {
          setExistingVacancy(v);
          if (v.patient_id) flow.selectCase(v.case_number ?? 0, v.patient_id);
        })
        .catch((err: unknown) =>
          setLoadError(err instanceof Error ? err.message : String(err)),
        )
        .finally(() => setIsLoadingVacancy(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, vacancyId]);

  const handleClose = () => {
    flow.reset();
    onClose();
  };

  const handleSave = () => {
    formRef.current?.requestSubmit();
  };

  const patientSelected = mode === 'edit' || flow.selectedCaseNumber != null;

  const title = mode === 'create' ? tp('createTitle') : tp('editTitle');
  const saveLabel = submitting ? tp('saving') : tp('save');

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleClose}
        data-testid="vacancy-modal-backdrop"
      />

      {/* Side sheet — wide two-column layout */}
      <div
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-5xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        data-testid="vacancy-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-12 py-5 border-b border-slate-100 shrink-0">
          <span className="text-2xl font-bold text-[#1B1B4B] font-poppins">
            {title}
          </span>

          <div className="flex items-center gap-4">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={submitting || (mode === 'create' && !patientSelected)}
              isLoading={submitting}
              className="w-40 rounded-full bg-[#1B1B4B] border-[#1B1B4B] text-white text-sm h-10"
              data-testid="header-save-btn"
            >
              {saveLabel}
            </Button>

            <button
              onClick={handleClose}
              className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded"
              aria-label={tp('close')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-12 py-10">
          {isLoadingVacancy && (
            <div className="py-10 flex items-center justify-center text-sm text-slate-400">
              {t('common.loading')}
            </div>
          )}

          {loadError && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <p className="text-red-600 text-sm">{loadError}</p>
            </div>
          )}

          {!isLoadingVacancy && !loadError && (
            <VacancyFormSection
              mode={mode}
              existingVacancy={existingVacancy}
              selectedCaseNumber={flow.selectedCaseNumber}
              selectedPatientId={flow.selectedPatientId}
              selectedAddressId={flow.selectedAddressId}
              dependencyLevel={flow.dependencyLevel}
              addresses={flow.addresses}
              isLoadingPatient={flow.isLoadingPatient}
              patientError={flow.patientError}
              patientSelected={patientSelected}
              formRef={formRef}
              onSubmittingChange={setSubmitting}
              onSuccess={onSuccess}
              selectCase={flow.selectCase}
              selectAddress={flow.selectAddress}
            />
          )}
        </div>
      </div>
    </>
  );
}
