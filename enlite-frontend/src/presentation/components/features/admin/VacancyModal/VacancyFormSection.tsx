/**
 * VacancyFormSection
 *
 * React Hook Form + Zod orchestrator for the VacancyModal.
 * Renders a two-column grid layout (Figma node 6519:31118).
 * The Save button lives in the modal header — it calls
 * formRef.current.requestSubmit() which triggers this form.
 *
 * Column split:
 *   Left  → patient/case fields + job details
 *   Right → status/conditions + address + schedule + payment
 */

import { useState, useEffect, useRef, RefObject } from 'react';
import { useForm, useWatch, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { Typography } from '@presentation/components/atoms/Typography';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientAddressRow } from '@domain/entities/PatientAddress';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import {
  vacancyFormSchema,
  type VacancyFormData,
  DEFAULT_FORM_VALUES,
  buildVacancyPayload,
  buildScheduleFromVacancy,
  MEET_LINK_REGEX,
} from '../vacancy-form-schema';
import { summarizeAddress } from '@presentation/utils/summarizeAddress';
import { VacancyFormLeftColumn } from './VacancyFormLeftColumn';
import { VacancyFormRightColumn } from './VacancyFormRightColumn';

/**
 * Map RHF/Zod field errors to user-friendly labels so the validation banner
 * can list exactly what's missing instead of silently blocking submit.
 */
function listInvalidFields(
  errors: FieldErrors<VacancyFormData>,
  tp: (k: string) => string,
): string[] {
  const labels: string[] = [];
  if (errors.required_professions) labels.push(tp('professionalType'));
  if (errors.providers_needed) labels.push(tp('providersNeeded'));
  if (errors.schedule) labels.push(tp('schedule'));
  if (errors.meet_links) labels.push(tp('meetLinksLabel'));
  if (errors.title) labels.push(tp('caseNumber'));
  if (errors.age_range_max) labels.push(tp('ageRange'));
  return labels;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface VacancyFormSectionProps {
  mode: 'create' | 'edit';
  existingVacancy: any | null;
  selectedCaseNumber: number | null;
  selectedPatientId: string | null;
  selectedAddressId: string | null;
  dependencyLevel: string | null;
  addresses: PatientAddressRow[];
  isLoadingPatient: boolean;
  patientError: string | null;
  patientSelected?: boolean;
  formRef: RefObject<HTMLFormElement>;
  onSubmittingChange: (submitting: boolean) => void;
  /** Called after successful create/update. Receives the vacancy id (newly created or edited). */
  onSuccess: (vacancyId: string) => void;
  selectCase: (caseNumber: number, patientId: string) => void;
  selectAddress: (addressId: string) => void;
  /** Surfaces RHF/Zod validation failures so the page can render a banner above the form. */
  onValidationFailedFieldsChange?: (fields: string[]) => void;
  /**
   * Notifies the parent whenever the form's required-field set is fully
   * satisfied — used to gate the "Continuar" button without invoking RHF's
   * full validation cycle. Watches the same minimum invariants that the
   * Zod schema enforces on submit (case + address + profession + schedule
   * + at least one valid Meet link).
   */
  onCompleteChange?: (isComplete: boolean) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function VacancyFormSection({
  mode,
  existingVacancy,
  selectedCaseNumber,
  selectedPatientId,
  selectedAddressId,
  dependencyLevel,
  addresses,
  isLoadingPatient,
  patientError,
  patientSelected = true,
  formRef,
  onSubmittingChange,
  onSuccess,
  selectCase,
  selectAddress,
  onValidationFailedFieldsChange,
  onCompleteChange,
}: VacancyFormSectionProps): JSX.Element {
  const { t } = useTranslation();

  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [patientDetail, setPatientDetail] = useState<PatientDetail | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    formState: { errors },
  } = useForm<VacancyFormData>({
    resolver: zodResolver(vacancyFormSchema),
    defaultValues: DEFAULT_FORM_VALUES,
  });

  // Sync submitting state to parent (for header Save button)
  const prevSubmitting = useRef(submitting);
  useEffect(() => {
    if (prevSubmitting.current !== submitting) {
      onSubmittingChange(submitting);
      prevSubmitting.current = submitting;
    }
  }, [submitting, onSubmittingChange]);

  // Watch the minimum invariants required by the schema so the parent can
  // gate the "Continuar" button without triggering a full RHF validation pass.
  const watched = useWatch({
    control,
    name: ['required_professions', 'schedule', 'meet_links', 'providers_needed'],
  }) as [
    string[] | undefined,
    Array<{ days: string[]; timeFrom: string; timeTo: string }> | undefined,
    [string, string, string] | undefined,
    number | undefined,
  ];
  const [professions, schedule, meetLinks, providersNeeded] = watched;

  const isComplete =
    patientSelected &&
    !!selectedAddressId &&
    Array.isArray(professions) && professions.length > 0 &&
    typeof providersNeeded === 'number' && providersNeeded >= 1 &&
    Array.isArray(schedule) &&
    schedule.some((s) => s?.days?.length > 0 && !!s.timeFrom && !!s.timeTo) &&
    Array.isArray(meetLinks) &&
    meetLinks.some((l) => !!l && MEET_LINK_REGEX.test(l));

  const prevComplete = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevComplete.current !== isComplete) {
      onCompleteChange?.(isComplete);
      prevComplete.current = isComplete;
    }
  }, [isComplete, onCompleteChange]);

  // Fetch patient detail when patient is selected (for diagnosis / cityLocality)
  useEffect(() => {
    if (!selectedPatientId) {
      setPatientDetail(null);
      return;
    }
    AdminApiService.getPatientById(selectedPatientId)
      .then((p) => setPatientDetail(p as PatientDetail))
      .catch(() => setPatientDetail(null));
  }, [selectedPatientId]);

  // Initialize form when opening or vacancy data arrives
  useEffect(() => {
    setApiError(null);
    if (mode === 'edit' && existingVacancy) {
      reset({
        title: existingVacancy.title ?? '',
        status: existingVacancy.status ?? 'SEARCHING',
        required_professions: existingVacancy.required_professions ?? [],
        required_sex: existingVacancy.required_sex ?? '',
        age_range_min: existingVacancy.age_range_min ?? undefined,
        age_range_max: existingVacancy.age_range_max ?? undefined,
        required_experience: existingVacancy.required_experience ?? '',
        worker_attributes: existingVacancy.worker_attributes ?? '',
        providers_needed: existingVacancy.providers_needed ?? 1,
        work_schedule: existingVacancy.work_schedule ?? '',
        schedule: buildScheduleFromVacancy(existingVacancy),
        salary_text: existingVacancy.salary_text ?? '',
        payment_day: existingVacancy.payment_day ?? '',
        daily_obs: existingVacancy.daily_obs ?? '',
        // Backend returns timestamptz as ISO string; the date input only
        // accepts `YYYY-MM-DD`, so we slice. Empty/null → empty string.
        published_at: existingVacancy.published_at
          ? String(existingVacancy.published_at).slice(0, 10)
          : '',
        closes_at: existingVacancy.closes_at
          ? String(existingVacancy.closes_at).slice(0, 10)
          : '',
        meet_links: [
          existingVacancy.meet_link_1 ?? '',
          existingVacancy.meet_link_2 ?? '',
          existingVacancy.meet_link_3 ?? '',
        ],
      });
    } else if (mode === 'create') {
      reset(DEFAULT_FORM_VALUES);
      AdminApiService.getNextVacancyNumber()
        .then((n) => {
          const cn = selectedCaseNumber;
          setValue('title', cn != null ? `CASO ${cn}-${n}` : `CASO ${n}`);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, existingVacancy]);

  // Update title when case is selected in create mode
  useEffect(() => {
    if (mode !== 'create' || selectedCaseNumber == null) return;
    AdminApiService.getNextVacancyNumber()
      .then((n) => setValue('title', `CASO ${selectedCaseNumber}-${n}`))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCaseNumber, mode]);

  const onValidationError = (errs: FieldErrors<VacancyFormData>) => {
    const fields = listInvalidFields(errs, (k) => t(`admin.vacancyModal.${k}`));
    onValidationFailedFieldsChange?.(fields);
    setApiError(null);
    // Surface in console so the dev sees the exact error keys/paths
    console.warn('[VacancyForm] validation failed', errs);
  };

  const onSubmit = async (data: VacancyFormData) => {
    setSubmitting(true);
    setApiError(null);
    onValidationFailedFieldsChange?.([]);
    try {
      const patientId =
        mode === 'create'
          ? selectedPatientId
          : (existingVacancy?.patient_id ?? selectedPatientId);
      const addressId =
        mode === 'create'
          ? selectedAddressId
          : (existingVacancy?.patient_address_id ?? selectedAddressId);

      const payload = buildVacancyPayload(
        data,
        selectedCaseNumber ?? (existingVacancy?.case_number ?? null),
        patientId,
        addressId,
      );

      let vacancyId: string;
      if (mode === 'edit' && existingVacancy) {
        await AdminApiService.updateVacancy(existingVacancy.id, payload);
        vacancyId = existingVacancy.id;
      } else {
        const result = await AdminApiService.createVacancy(payload);
        vacancyId = (result as any)?.id ?? (result as unknown as string);
      }

      // Save meet links (required by Step 1 → Step 2 gate). Form-level Zod
      // already validated at least one is a valid Meet URL.
      const meetLinksPayload: [string | null, string | null, string | null] = [
        data.meet_links?.[0]?.trim() || null,
        data.meet_links?.[1]?.trim() || null,
        data.meet_links?.[2]?.trim() || null,
      ];
      await AdminApiService.updateVacancyMeetLinks(vacancyId, meetLinksPayload);

      onSuccess(vacancyId);
    } catch (err: unknown) {
      setApiError(
        err instanceof Error
          ? err.message
          : t('admin.vacancyDetail.vacancyForm.error'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit(onSubmit, onValidationError)}
      className="w-full"
      data-testid="vacancy-form"
    >
      {/* Hint banner — create mode before case is selected */}
      {mode === 'create' && !patientSelected && (
        <div className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 mb-6">
          <span className="text-blue-400 text-sm">ℹ</span>
          <p className="text-sm text-blue-600">
            {t('admin.vacancyModal.hintSelectCase')}
          </p>
        </div>
      )}

      {/* Two-column grid */}
      <div className="grid grid-cols-2 gap-12">
        <VacancyFormLeftColumn
          mode={mode}
          register={register}
          control={control}
          errors={errors}
          patientSelected={patientSelected}
          diagnosis={patientDetail?.diagnosis ?? null}
          patientName={
            [patientDetail?.firstName, patientDetail?.lastName]
              .filter(Boolean)
              .join(' ') || null
          }
          selectedCaseNumber={selectedCaseNumber}
          selectedPatientId={selectedPatientId}
          dependencyLevel={dependencyLevel}
          selectCase={selectCase}
          setValue={(field, value) => setValue(field, value)}
        />

        <VacancyFormRightColumn
          register={register}
          control={control}
          errors={errors}
          patientSelected={patientSelected}
          addresses={addresses}
          selectedAddressId={selectedAddressId}
          isLoadingPatient={isLoadingPatient}
          patientError={patientError}
          cityLocality={
            summarizeAddress(
              addresses.find((a) => a.id === selectedAddressId)?.address_formatted
                ?? addresses[0]?.address_formatted,
            ) || null
          }
          serviceType={patientDetail?.serviceType ?? null}
          selectAddress={selectAddress}
        />
      </div>

      {/* API error */}
      {apiError && (
        <div className="mt-6 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <Typography variant="body" className="text-red-600 text-sm">
            {apiError}
          </Typography>
        </div>
      )}

      {/* Hidden submit — triggered by header Save button via formRef.requestSubmit() */}
      <button type="submit" className="hidden" data-testid="form-submit" />
    </form>
  );
}
