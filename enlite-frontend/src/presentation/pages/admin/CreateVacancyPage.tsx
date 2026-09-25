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
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Stepper } from '@presentation/components/molecules/Stepper';
import { useVacancyModalFlow } from '@hooks/admin/useVacancyModalFlow';
import { useUnsavedChangesGuard } from '@hooks/useUnsavedChangesGuard';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { VacancyDraftSummary, VacancyByAddressSummary } from '@domain/entities/VacancyDraft';
import type { AdminVacancyDetail } from '@domain/entities/Vacancy';
import { VacancyFormSection } from '@presentation/components/features/admin/VacancyModal/VacancyFormSection';
import { ResumeDraftVacancyDialog } from '@presentation/components/features/admin/VacancyModal/ResumeDraftVacancyDialog';
import { AddressHasVacancyDialog } from '@presentation/components/features/admin/VacancyModal/AddressHasVacancyDialog';
import { UnsavedChangesDialog } from '@presentation/components/features/admin/VacancyModal/UnsavedChangesDialog';
import { Button } from '@presentation/components/atoms/Button';

export default function CreateVacancyPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id: routeVacancyId } = useParams<{ id: string }>();
  const isEditMode = Boolean(routeVacancyId);
  // D269: a rota é alcançável por URL; sem vacancy:create (modo novo) / vacancy:update (modo
  // edição), a porta fecha (não só o botão) — PR-8b, o "modo pede a ação" (contracts/permissions-split.md).
  const vacancyWriteGate = useActionGate('vacancy', isEditMode ? 'update' : 'create');
  const v = (k: string) => t(`admin.createVacancyV2.${k}`);

  const formRef = useRef<HTMLFormElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [validationFailedFields, setValidationFailedFields] = useState<string[]>([]);
  const [formComplete, setFormComplete] = useState(false);
  const [existingVacancy, setExistingVacancy] = useState<AdminVacancyDetail | null>(null);
  const [isLoadingVacancy, setIsLoadingVacancy] = useState(isEditMode);
  const [vacancyLoadError, setVacancyLoadError] = useState<string | null>(null);

  // Draft-resume state
  const [drafts, setDrafts] = useState<VacancyDraftSummary[]>([]);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [isCheckingDrafts, setIsCheckingDrafts] = useState(false);
  const lastCheckedPatientIdRef = useRef<string | null>(null);

  // Address-has-vacancy state: warns when the selected patient_address_id is
  // already linked to another vacancy (not deleted, not CLOSED). Per-address
  // granularity complements the per-patient draft check above.
  const [vacanciesAtAddress, setVacanciesAtAddress] = useState<VacancyByAddressSummary[]>([]);
  const [showAddressHasVacancyDialog, setShowAddressHasVacancyDialog] = useState(false);
  const lastCheckedAddressIdRef = useRef<string | null>(null);
  const operatorOverrodeAddressWarningRef = useRef<Set<string>>(new Set());

  const flow = useVacancyModalFlow();
  const patientSelected = isEditMode || flow.selectedCaseNumber != null;

  const guard = useUnsavedChangesGuard(); // Fase 4 (F27) — só o Volver passa por `guardedAction`.

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

  // Check existing vacancies attached to the selected address (per-address
  // warning). Skipped in edit mode (the operator is intentionally editing the
  // vacancy that already points to this address) and skipped on re-selection
  // after the operator explicitly chose "Continue creating anyway".
  useEffect(() => {
    const addressId = flow.selectedAddressId;
    if (isEditMode || !addressId) {
      setShowAddressHasVacancyDialog(false);
      return;
    }
    if (lastCheckedAddressIdRef.current === addressId) return;
    if (operatorOverrodeAddressWarningRef.current.has(addressId)) {
      lastCheckedAddressIdRef.current = addressId;
      return;
    }

    lastCheckedAddressIdRef.current = addressId;

    AdminApiService.listVacanciesByAddress(addressId)
      .then((found) => {
        if (found.length > 0) {
          setVacanciesAtAddress(found);
          setShowAddressHasVacancyDialog(true);
        } else {
          setShowAddressHasVacancyDialog(false);
          setVacanciesAtAddress([]);
        }
      })
      .catch((err: unknown) => {
        console.error('[CreateVacancyPage] address-has-vacancy check failed:', err);
      });
  }, [flow.selectedAddressId, isEditMode]);

  const handleAddressHasVacancyEdit = (vacancy: VacancyByAddressSummary) => {
    setShowAddressHasVacancyDialog(false);
    navigate(vacancy.is_draft ? `/admin/vacancies/${vacancy.id}/edit` : `/admin/vacancies/${vacancy.id}`);
  };

  const handleAddressHasVacancyContinue = () => {
    const addressId = flow.selectedAddressId;
    if (addressId) operatorOverrodeAddressWarningRef.current.add(addressId);
    setShowAddressHasVacancyDialog(false);
  };

  const handleAddressHasVacancyCancel = () => {
    // Revert: clear address selection so the operator can pick another one.
    flow.selectAddress('');
    lastCheckedAddressIdRef.current = null;
    setShowAddressHasVacancyDialog(false);
    setVacanciesAtAddress([]);
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

  if (vacancyWriteGate.denied) return <Navigate to="/admin/vacancies" replace />;

  return (
    <div className="w-full min-h-screen bg-[#FFF9FC] py-10 px-6">
      <div className="max-w-[1392px] mx-auto flex flex-col gap-6">

        {/* Page header */}
        <div className="flex items-center justify-between w-full">
          <Heading level={1} weight="semibold">
            {v('pageTitle')}
          </Heading>
          <div className="flex items-center gap-3">
            {/* Fase 4 (F27): só em edição — Volver devolve à tela do rascunho. */}
            {isEditMode && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  guard.guardedAction(() => navigate(`/admin/vacancies/${routeVacancyId}/borrador`))
                }
                disabled={isBusy}
                className="h-10 rounded-full"
                data-testid="vacancy-wizard-back-btn"
              >
                {v('backButton')}
              </Button>
            )}
            <ActionButton
              resource="vacancy"
              action={isEditMode ? 'update' : 'create'}
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
            </ActionButton>
          </div>
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
              onDirtyChange={(dirty) => (dirty ? guard.markDirty() : guard.markClean())}
            />
          )}
        </div>
      </div>

      {/* Fase 4 (F27): confirmação de saída com alteração não gravada. */}
      <UnsavedChangesDialog
        isOpen={guard.isConfirmOpen}
        onConfirm={guard.confirmDiscard}
        onCancel={guard.cancelDiscard}
      />

      {/* Draft-resume dialog (per-patient) */}
      <ResumeDraftVacancyDialog
        isOpen={showResumeDialog}
        drafts={drafts}
        onResume={handleResumeDialogResume}
        onCreateNew={handleResumeDialogCreateNew}
        onCancel={handleResumeDialogCancel}
      />

      {/* Address-already-has-vacancy dialog (per-address) */}
      <AddressHasVacancyDialog
        isOpen={showAddressHasVacancyDialog}
        vacancies={vacanciesAtAddress}
        onEditExisting={handleAddressHasVacancyEdit}
        onContinueCreating={handleAddressHasVacancyContinue}
        onCancel={handleAddressHasVacancyCancel}
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
