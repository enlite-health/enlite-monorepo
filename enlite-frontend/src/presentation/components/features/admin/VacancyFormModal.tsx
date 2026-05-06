import { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { SchedulePicker } from './VacancySchedulePicker';
import {
  vacancyFormSchema, type VacancyFormData, DEFAULT_FORM_VALUES,
  STATUS_OPTIONS, PROFESSION_OPTIONS, SEX_OPTIONS,
  WORK_SCHEDULE_OPTIONS,
  scheduleToJsonb, buildScheduleFromVacancy,
} from './vacancy-form-schema';

// ---------------------------------------------------------------------------
// Shared CSS
// ---------------------------------------------------------------------------

const inputCls =
  'border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/30';
const selectCls = `${inputCls} bg-white`;

// ---------------------------------------------------------------------------
// Micro-components
// ---------------------------------------------------------------------------

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="border-t border-slate-200 pt-4 mt-2">
      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
    </div>
  );
}

function Field({ label, req, error, children }: {
  label: string; req?: boolean; error?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-slate-700">{label}{req && ' *'}</label>
      {children}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface VacancyFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (vacancyId: string) => void;
  vacancy?: any;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VacancyFormModal({ isOpen, onClose, onSuccess, vacancy }: VacancyFormModalProps) {
  const { t } = useTranslation();
  const isEdit = Boolean(vacancy);
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [loadingTitle, setLoadingTitle] = useState(false);
  const [caseNumber, setCaseNumber] = useState<number | null>(null);
  const [vacancyNumber, setVacancyNumber] = useState<number | null>(null);

  const { register, handleSubmit, reset, control, setValue, formState: { errors } } = useForm<VacancyFormData>({
    resolver: zodResolver(vacancyFormSchema),
    defaultValues: DEFAULT_FORM_VALUES,
  });

  /** Shortcut for i18n keys inside vacancyForm namespace */
  const tp = (k: string) => t(`admin.vacancyDetail.vacancyForm.${k}`);

  // Sync form when modal opens / vacancy changes
  useEffect(() => {
    if (!isOpen) return;
    setApiError(null);

    if (vacancy) {
      setCaseNumber(vacancy.case_number ?? null);
      setVacancyNumber(vacancy.vacancy_number ?? null);
      reset({
        title: vacancy.title ?? '',
        status: vacancy.status ?? 'SEARCHING',
        required_professions: vacancy.required_professions ?? [],
        required_sex: vacancy.required_sex ?? '',
        age_range_min: vacancy.age_range_min ?? undefined,
        age_range_max: vacancy.age_range_max ?? undefined,
        required_experience: vacancy.required_experience ?? '',
        worker_attributes: vacancy.worker_attributes ?? '',
        providers_needed: vacancy.providers_needed ?? 1,
        work_schedule: vacancy.work_schedule ?? '',
        schedule: buildScheduleFromVacancy(vacancy),
        salary_text: vacancy.salary_text ?? '',
        payment_day: vacancy.payment_day ?? '',
        daily_obs: vacancy.daily_obs ?? '',
      });
    } else {
      reset(DEFAULT_FORM_VALUES);
      setCaseNumber(null);
      setVacancyNumber(null);
      setLoadingTitle(true);
      AdminApiService.getNextVacancyNumber()
        .then((n) => { setVacancyNumber(n); setValue('title', `CASO ${n}`); })
        .catch(() => {})
        .finally(() => setLoadingTitle(false));
    }
  }, [isOpen, vacancy, reset, setValue]);

  const onSubmit = async (data: VacancyFormData) => {
    setSubmitting(true);
    setApiError(null);
    try {
      const scheduleJsonb = scheduleToJsonb(data.schedule);
      const payload = {
        case_number: caseNumber,
        title: data.title,
        patient_id: null,
        required_professions: data.required_professions,
        required_sex: data.required_sex || null,
        age_range_min: data.age_range_min ?? null,
        age_range_max: data.age_range_max ?? null,
        required_experience: data.required_experience || null,
        worker_attributes: data.worker_attributes || null,
        schedule: scheduleJsonb.length > 0 ? scheduleJsonb : null,
        work_schedule: data.work_schedule || null,
        providers_needed: data.providers_needed,
        salary_text: data.salary_text || 'A convenir',
        payment_day: data.payment_day || null,
        daily_obs: data.daily_obs || null,
        status: data.status,
      };

      if (isEdit) {
        await AdminApiService.updateVacancy(vacancy.id, payload);
        onSuccess(vacancy.id);
      } else {
        const result = await AdminApiService.createVacancy(payload);
        onSuccess(result.id ?? result);
      }
    } catch (err: any) {
      setApiError(err?.message ?? tp('error'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const modalTitle = isEdit ? tp('editTitle') : tp('createTitle');
  const submitLabel = isEdit
    ? (submitting ? tp('saving') : tp('save'))
    : (submitting ? tp('creating') : tp('create'));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <Heading level={3} weight="semibold" color="secondary">
            {modalTitle}
          </Heading>
          <button onClick={onClose} className="text-[#737373] hover:text-red-500 transition-colors p-1 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">

          {/* ── Información del Caso ── */}
          <SectionHeader label={tp('sectionCaseInfo')} />

          <div className="grid grid-cols-2 gap-4">
            <Field label={tp('caseNumber')}>
              <input type="number" min={1} value={caseNumber ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '') {
                    setCaseNumber(null);
                  } else {
                    const n = Number(val);
                    setCaseNumber(n);
                    if (n > 0 && vacancyNumber != null) setValue('title', `CASO ${n}-${vacancyNumber}`);
                  }
                }}
                className={inputCls} />
            </Field>
            {vacancyNumber != null && (
              <Field label={tp('vacancyNumber')}>
                <input type="text" value={vacancyNumber} readOnly
                  className={`${inputCls} bg-slate-50 cursor-default`} />
              </Field>
            )}
          </div>

          <Field label={tp('title')} error={errors.title && tp('validation.titleMin')}>
            <input type="text" {...register('title')} disabled={loadingTitle}
              className={`${inputCls} ${loadingTitle ? 'opacity-50' : ''}`} />
          </Field>

          <Field label={tp('status')}>
            <select {...register('status')} className={selectCls}>
              {STATUS_OPTIONS.map((o) => <option key={o} value={o}>{tp(`statusOptions.${o}`)}</option>)}
            </select>
          </Field>

          {/* ── Perfil Profesional Buscado ── */}
          <SectionHeader label={tp('sectionProfessionalProfile')} />

          <Field label={tp('requiredProfessions')} req
            error={errors.required_professions && tp('validation.requiredProfessionsMin')}>
            <Controller name="required_professions" control={control} render={({ field }) => (
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {PROFESSION_OPTIONS.map((opt) => (
                  <label key={opt} className="flex items-center gap-1.5 text-sm text-slate-700">
                    <input type="checkbox" checked={field.value.includes(opt)}
                      onChange={(e) => field.onChange(
                        e.target.checked ? [...field.value, opt] : field.value.filter((v: string) => v !== opt),
                      )}
                      className="rounded border-slate-300 text-primary focus:ring-primary/30" />
                    {tp(`professionOptions.${opt}`)}
                  </label>
                ))}
              </div>
            )} />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label={tp('requiredSex')}>
              <select {...register('required_sex')} className={selectCls}>
                <option value="">{tp('sexOptions.unspecified')}</option>
                {SEX_OPTIONS.map((o) => <option key={o} value={o}>{tp(`sexOptions.${o}`)}</option>)}
              </select>
            </Field>
            <Field label={tp('providersNeeded')} req error={errors.providers_needed && tp('validation.providersMin')}>
              <input type="number" min={1} {...register('providers_needed', { valueAsNumber: true })}
                className={inputCls} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label={tp('ageRangeMin')} error={errors.age_range_min && tp('validation.ageRangeMinInvalid')}>
              <input type="number" min={18} placeholder="18" className={inputCls}
                {...register('age_range_min', { setValueAs: (v: string) => (v === '' ? undefined : Number(v)) })} />
            </Field>
            <Field label={tp('ageRangeMax')} error={errors.age_range_max && tp('validation.ageRangeInvalid')}>
              <input type="number" placeholder="65" className={inputCls}
                {...register('age_range_max', { setValueAs: (v: string) => (v === '' ? undefined : Number(v)) })} />
            </Field>
          </div>

          <Field label={tp('requiredExperience')}>
            <textarea {...register('required_experience')} rows={2} className={`${inputCls} resize-none`} />
          </Field>

          <Field label={tp('workerAttributes')}>
            <textarea {...register('worker_attributes')} rows={2} className={`${inputCls} resize-none`} />
          </Field>

          {/* ── Ubicación y Horarios ── */}
          <SectionHeader label={tp('sectionLocationSchedule')} />

          <Field label={tp('workSchedule')}>
            <select {...register('work_schedule')} className={selectCls}>
              <option value="">{tp('selectPlaceholder')}</option>
              {WORK_SCHEDULE_OPTIONS.map((o) => <option key={o} value={o}>{tp(`workScheduleOptions.${o}`)}</option>)}
            </select>
          </Field>

          <Field label={tp('schedule')} req
            error={errors.schedule ? tp('validation.scheduleRequired') : undefined}>
            <Controller name="schedule" control={control} render={({ field }) => (
              <SchedulePicker value={field.value} onChange={field.onChange} />
            )} />
          </Field>

          {/* ── Condiciones ── */}
          <SectionHeader label={tp('sectionConditions')} />

          <div className="grid grid-cols-2 gap-4">
            <Field label={tp('salaryText')}>
              <input type="text" {...register('salary_text')} placeholder="A convenir" className={inputCls} />
            </Field>
            <Field label={tp('paymentDay')}>
              <input type="text" {...register('payment_day')}
                placeholder={tp('paymentDayPlaceholder')} className={inputCls} />
            </Field>
          </div>

          {/* ── Observaciones ── */}
          <Field label={tp('observations')}>
            <textarea {...register('daily_obs')} rows={2} className={`${inputCls} resize-none`} />
          </Field>

          {/* Error + Actions */}
          {apiError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
              <Text size="sm" color="inherit" className="text-red-600">{apiError}</Text>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={submitting}>
              {tp('cancel')}
            </Button>
            <Button type="submit" variant="primary" size="sm" isLoading={submitting} disabled={submitting}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
