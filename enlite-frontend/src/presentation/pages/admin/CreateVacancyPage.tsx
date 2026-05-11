/**
 * CreateVacancyPage
 *
 * Step 1 of the vacancy creation flow. Two routes share this page:
 *   - /admin/vacancies/new           → create mode (blank form)
 *   - /admin/vacancies/:id/edit      → edit mode (hydrate existing vacancy)
 *
 * Edit mode is the entry point for "Atrás" coming back from Step 2 — we load
 * the persisted vacancy + patient + address so all previously entered data is
 * preserved across step navigation.
 *
 * Steps:
 *   1. Datos de la vacante  ← this page
 *   2. Configuración Talentum  (/admin/vacancies/:id/talentum)
 *   3. Detalle y postulantes   (/admin/vacancies/:id)
 *
 * Wraps the same `VacancyFormSection` used by the legacy `VacancyModal`.
 * On successful submit:
 *   1. Vacancy is created (or updated) and meet links saved inside the form.
 *   2. We block the UI with a "generating AI content" overlay.
 *   3. We POST /vacancies/:id/generate-ai-content to get description+prescreening.
 *   4. Navigate to Step 2 with the generated payload via location.state so the
 *      Talentum page does not have to re-call the AI.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Stepper } from '@presentation/components/molecules/Stepper';
import { useVacancyModalFlow } from '@hooks/admin/useVacancyModalFlow';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { VacancyDraftSummary } from '@domain/entities/VacancyDraft';
import { VacancyFormSection } from '@presentation/components/features/admin/VacancyModal/VacancyFormSection';
import { ResumeDraftVacancyDialog } from '@presentation/components/features/admin/VacancyModal/ResumeDraftVacancyDialog';

export default function CreateVacancyPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id: routeVacancyId } = useParams<{ id: string }>();
  const isEditMode = Boolean(routeVacancyId);
  const v = (k: string) => t(`admin.createVacancyV2.${k}`);

  const formRef = useRef<HTMLFormElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [validationFailedFields, setValidationFailedFields] = useState<string[]>([]);
  const [formComplete, setFormComplete] = useState(false);
  const [existingVacancy, setExistingVacancy] = useState<any | null>(null);
  const [isLoadingVacancy, setIsLoadingVacancy] = useState(isEditMode);
  const [vacancyLoadError, setVacancyLoadError] = useState<string | null>(null);

  // Draft-resume state
  const [drafts, setDrafts] = useState<VacancyDraftSummary[]>([]);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [isCheckingDrafts, setIsCheckingDrafts] = useState(false);
  const lastCheckedPatientIdRef = useRef<string | null>(null);

  const flow = useVacancyModalFlow();
  const patientSelected = isEditMode || flow.selectedCaseNumber != null;

  // Hydrate edit mode: fetch existing vacancy + seed flow with case/patient/address
  // so the form pre-fills and the address selector highlights the linked address.
  useEffect(() => {
    if (!isEditMode || !routeVacancyId) return;
    setIsLoadingVacancy(true);
    setVacancyLoadError(null);
    AdminApiService.getVacancyById(routeVacancyId)
      .then((vac) => {
        setExistingVacancy(vac);
        if (vac.patient_id) {
          flow.selectCase(
            vac.case_number ?? 0,
            vac.patient_id,
            vac.patient_address_id ?? null,
          );
        }
      })
      .catch((err: unknown) =>
        setVacancyLoadError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setIsLoadingVacancy(false));
    // selectCase is stable (useCallback w/ empty deps); re-running the fetch on
    // every render would refetch the vacancy unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeVacancyId, isEditMode]);

  // Check for existing drafts when a patient is selected in create mode
  useEffect(() => {
    const patientId = flow.selectedPatientId;
    if (isEditMode || !patientId || isCheckingDrafts) return;
    if (lastCheckedPatientIdRef.current === patientId) return;

    lastCheckedPatientIdRef.current = patientId;
    setIsCheckingDrafts(true);

    AdminApiService.listDraftsForPatient(patientId)
      .then((found) => {
        if (found.length > 0) {
          setDrafts(found);
          setShowResumeDialog(true);
        } else {
          setShowResumeDialog(false);
        }
      })
      .catch((err: unknown) => {
        // Non-blocking: log but do not prevent vacancy creation
        console.error('[CreateVacancyPage] draft check failed:', err);
      })
      .finally(() => {
        setIsCheckingDrafts(false);
      });
  // isCheckingDrafts intentionally omitted to avoid loop — ref guards re-entry
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.selectedPatientId, isEditMode]);

  const handleResumeDialogResume = (vacancyId: string) => {
    navigate(`/admin/vacancies/${vacancyId}/edit`);
  };

  const handleResumeDialogCreateNew = () => {
    setShowResumeDialog(false);
  };

  const handleResumeDialogCancel = () => {
    flow.reset();
    lastCheckedPatientIdRef.current = null;
    setShowResumeDialog(false);
    setDrafts([]);
  };

  const handleSave = () => {
    formRef.current?.requestSubmit();
  };

  const handleSuccess = async (vacancyId: string) => {
    setGenerateError(null);
    setGenerating(true);
    try {
      const result = await AdminApiService.generateAIContent(vacancyId);
      navigate(`/admin/vacancies/${vacancyId}/talentum`, {
        state: {
          description: result.description,
          prescreeningQuestions: result.prescreening.questions,
          prescreeningFaq: result.prescreening.faq,
        },
      });
    } catch (err: unknown) {
      // Vacancy is already saved — just surface the error and let the user
      // navigate manually. Step 2 will auto-retry generation on mount.
      setGenerateError(err instanceof Error ? err.message : String(err));
      navigate(`/admin/vacancies/${vacancyId}/talentum`);
    } finally {
      setGenerating(false);
    }
  };

  const isBusy = submitting || generating;

  return (
    <div className="w-full min-h-screen bg-[#FFF9FC] py-10 px-6">
      <div className="max-w-[1392px] mx-auto flex flex-col gap-6">

        {/* Page header */}
        <div className="flex items-center justify-between w-full">
          <Heading level={1} weight="semibold">
            {v('pageTitle')}
          </Heading>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            // In edit mode the vacancy already passed validation when it was
            // created — relying on `formComplete` here causes the button to
            // get stuck disabled while RHF/flow rehydrate from `existingVacancy`.
            // Let RHF validate on submit and surface errors via the banner.
            disabled={isBusy || (!isEditMode && !formComplete)}
            isLoading={isBusy}
            className="h-10 w-40 rounded-full bg-[#180149] text-white font-['Poppins'] font-semibold text-[16px] hover:bg-[#180149]/90 active:bg-[#180149]/80"
            data-testid="create-vacancy-save-btn"
          >
            {generating ? v('generatingAI') : submitting ? v('saving') : v('saveButton')}
          </Button>
        </div>

        {/* Stepper */}
        <Stepper
          currentStep={1}
          steps={[
            { label: v('steps.vacancyData') },
            { label: v('steps.talentumConfig') },
            { label: v('steps.vacancyDetail') },
          ]}
        />

        {/* Zod validation failure — surfaced from the inner form */}
        {validationFailedFields.length > 0 && (
          <div
            className="bg-red-50 border border-red-200 rounded-[10px] px-5 py-3"
            data-testid="vacancy-form-validation-error"
            role="alert"
          >
            <Text size="sm" weight="medium" color="inherit" className="text-red-600">
              {t('admin.vacancyModal.validationBanner.title')}
            </Text>
            <ul className="list-disc pl-5 mt-1">
              {validationFailedFields.map((label) => (
                <li key={label}>
                  <Text as="span" size="sm" color="inherit" className="text-red-600">{label}</Text>
                </li>
              ))}
            </ul>
          </div>
        )}

        {generateError && (
          <div className="bg-red-50 border border-red-200 rounded-[10px] px-5 py-3">
            <Text size="sm" color="inherit" className="text-red-600">
              {generateError}
            </Text>
          </div>
        )}

        {/* Form card — side-sheet style */}
        <div className="bg-white rounded-l-[32px] pl-12 pr-6 py-10 shadow-medium">
          {isLoadingVacancy ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-[#180149]" />
            </div>
          ) : vacancyLoadError ? (
            <div className="bg-red-50 border border-red-200 rounded-[10px] px-5 py-3">
              <Text size="sm" color="inherit" className="text-red-600">
                {vacancyLoadError}
              </Text>
            </div>
          ) : (
            <VacancyFormSection
              mode={isEditMode ? 'edit' : 'create'}
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
              onSuccess={handleSuccess}
              selectCase={flow.selectCase}
              selectAddress={flow.selectAddress}
              onValidationFailedFieldsChange={setValidationFailedFields}
              onCompleteChange={setFormComplete}
            />
          )}
        </div>
      </div>

      {/* Draft-resume dialog */}
      <ResumeDraftVacancyDialog
        isOpen={showResumeDialog}
        drafts={drafts}
        onResume={handleResumeDialogResume}
        onCreateNew={handleResumeDialogCreateNew}
        onCancel={handleResumeDialogCancel}
      />

      {/* Full-screen overlay during AI generation */}
      {generating && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="bg-white rounded-2xl px-8 py-6 shadow-xl flex items-center gap-4 max-w-md mx-6">
            <Loader2 className="w-6 h-6 animate-spin text-[#180149]" />
            <Text as="span" size="base" weight="medium" color="inherit" className="text-[#180149]">
              {v('generatingAI')}
            </Text>
          </div>
        </div>
      )}
    </div>
  );
}
