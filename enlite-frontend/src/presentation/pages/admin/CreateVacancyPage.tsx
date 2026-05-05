/**
 * CreateVacancyPage
 *
 * Step 1 of the vacancy creation flow:
 *   1. Datos de la vacante  ← this page
 *   2. Configuración Talentum  (/admin/vacancies/:id/talentum)
 *   3. Detalle y postulantes   (/admin/vacancies/:id)
 *
 * Wraps the same `VacancyFormSection` used by the legacy `VacancyModal`.
 * On successful submit:
 *   1. Vacancy is created (and meet links saved) inside VacancyFormSection.
 *   2. We block the UI with a "generating AI content" overlay.
 *   3. We POST /vacancies/:id/generate-ai-content to get description+prescreening.
 *   4. Navigate to Step 2 with the generated payload via location.state so the
 *      Talentum page does not have to re-call the AI.
 */

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Typography } from '@presentation/components/atoms/Typography';
import { Stepper } from '@presentation/components/molecules/Stepper';
import { useVacancyModalFlow } from '@hooks/admin/useVacancyModalFlow';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { VacancyFormSection } from '@presentation/components/features/admin/VacancyModal/VacancyFormSection';

export default function CreateVacancyPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const v = (k: string) => t(`admin.createVacancyV2.${k}`);

  const formRef = useRef<HTMLFormElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [validationFailedFields, setValidationFailedFields] = useState<string[]>([]);
  const [formComplete, setFormComplete] = useState(false);

  const flow = useVacancyModalFlow();
  const patientSelected = flow.selectedCaseNumber != null;

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
          <h1 className="font-['Poppins'] font-semibold text-[32px] leading-[1.3] text-[#180149]">
            {v('pageTitle')}
          </h1>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={isBusy || !formComplete}
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
            <Typography variant="body" className="text-red-600 text-sm font-medium font-['Lexend']">
              {t('admin.vacancyModal.validationBanner.title')}
            </Typography>
            <ul className="list-disc pl-5 mt-1 text-sm text-red-600 font-['Lexend']">
              {validationFailedFields.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </div>
        )}

        {generateError && (
          <div className="bg-red-50 border border-red-200 rounded-[10px] px-5 py-3">
            <Typography variant="body" className="text-red-600 text-sm font-['Lexend']">
              {generateError}
            </Typography>
          </div>
        )}

        {/* Form card — side-sheet style */}
        <div className="bg-white rounded-l-[32px] pl-12 pr-6 py-10 shadow-medium">
          <VacancyFormSection
            mode="create"
            existingVacancy={null}
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
        </div>
      </div>

      {/* Full-screen overlay during AI generation */}
      {generating && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="bg-white rounded-2xl px-8 py-6 shadow-xl flex items-center gap-4 max-w-md mx-6">
            <Loader2 className="w-6 h-6 animate-spin text-[#180149]" />
            <span className="font-['Lexend'] font-medium text-[16px] text-[#180149]">
              {v('generatingAI')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
