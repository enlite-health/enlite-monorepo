/**
 * VacancyFormRightColumn
 *
 * Right column fields of the two-column VacancyFormSection:
 *  - Status
 *  - Service type (work_schedule)
 *  - Location (read-only from patient)
 *  - Service address — address selector
 *  - Address complement (read-only from selected patient_address)
 *  - Map placeholder (280px)
 *  - Payment day
 *  - Weekly hours (visual only)
 *  - Net hourly rate (salary_text)
 *  - Providers needed
 *  - Schedule picker
 *
 * Design-system components used:
 *   - FormField  → replaces FieldGroup
 *   - SelectField → replaces raw <select> (via Controller)
 *   - InputWithIcon → replaces raw <input> + INPUT_CLS
 */

import { UseFormRegister, Control, Controller, FieldErrors, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import type { PatientAddressRow } from '@domain/entities/PatientAddress';
import { FormField } from '@presentation/components/molecules/FormField/FormField';
import { SelectField } from '@presentation/components/molecules/SelectField/SelectField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon/InputWithIcon';
import { ServiceAreaMap } from '@presentation/components/molecules/ServiceAreaMap';
import { VacancyDaySchedulePicker } from './VacancyDaySchedulePicker';
import type { VacancyFormData } from '../vacancy-form-schema';
import { STATUS_OPTIONS } from '../vacancy-form-schema';
import { computeWeeklyHours } from '../vacancyScheduleUtils';
import { READONLY_CLS } from './vacancyFormShared';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface VacancyFormRightColumnProps {
  register: UseFormRegister<VacancyFormData>;
  control: Control<VacancyFormData>;
  errors: FieldErrors<VacancyFormData>;
  patientSelected: boolean;
  addresses: PatientAddressRow[];
  selectedAddressId: string | null;
  isLoadingPatient: boolean;
  patientError: string | null;
  cityLocality?: string | null;
  /** Patient's service_type from ClickUp (Profession[]). Drives the read-only "Tipo de servicio" field. */
  serviceType?: string[] | null;
  selectAddress: (addressId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function VacancyFormRightColumn({
  register,
  control,
  errors,
  patientSelected,
  addresses,
  selectedAddressId,
  isLoadingPatient,
  patientError,
  cityLocality,
  serviceType,
  selectAddress,
}: VacancyFormRightColumnProps): JSX.Element {
  const { t } = useTranslation();
  const tp = (k: string) => t(`admin.vacancyModal.${k}`);
  const tf = (k: string) => t(`admin.vacancyDetail.vacancyForm.${k}`);

  // When patient isn't selected: gray-out the white wrappers of inputs/selects/readonly cells
  // (signals "fill the case first") without fading labels. We target `.bg-white` on the
  // molecule wrappers (InputWithIcon/SelectField) and read-only divs.
  const patientDis = !patientSelected
    ? 'pointer-events-none select-none [&_.bg-white]:!bg-[#f3f4f6]'
    : '';

  // Auto-computed from the current schedule field — re-renders on schedule change.
  const schedule = useWatch({ control, name: 'schedule' }) ?? [];
  const weeklyHours = computeWeeklyHours(schedule);

  return (
    <div className="space-y-6">
      {/* 1. Status */}
      <div className={patientDis}>
        <FormField label={tp('status')}>
          <Controller
            name="status"
            control={control}
            render={({ field }) => (
              <SelectField
                value={field.value ?? ''}
                onChange={(v) => field.onChange(v)}
                options={STATUS_OPTIONS.map((o) => ({
                  value: o,
                  label: tf(`statusOptions.${o}`),
                }))}
                placeholder={tp('statusPlaceholder')}
                data-testid="status-select"
              />
            )}
          />
        </FormField>
      </div>

      {/* 2. Service type — read-only from patient.serviceType (ClickUp "Servicio").
          Profession[] is joined+translated to the Spanish ClickUp label
          (e.g. ['AT','CAREGIVER'] → "AT y Cuidador"). */}
      <div className={patientDis}>
        <FormField label={tp('serviceType')}>
          <div className={READONLY_CLS}>
            {(() => {
              const types = serviceType ?? [];
              if (types.length === 0) return '—';
              if (types.includes('AT') && types.includes('CAREGIVER')) {
                return tf('professionOptions.AT_AND_CAREGIVER');
              }
              return types
                .map((p) =>
                  t(`admin.vacancyDetail.vacancyForm.professionOptions.${p}`, {
                    defaultValue: p,
                  }),
                )
                .join(', ');
            })()}
          </div>
        </FormField>
      </div>

      {/* 3. Location — read-only from patient (city_locality / zone_neighborhood) */}
      <div className={patientDis}>
        <FormField label={tp('location')}>
          <div className={READONLY_CLS}>
            {cityLocality ?? '—'}
          </div>
        </FormField>
      </div>

      {/* 4. Service address — address selector */}
      <div className={patientDis}>
        <FormField label={tp('serviceAddress')} required>
          {isLoadingPatient ? (
            <div className={`${READONLY_CLS} text-slate-400 text-sm`}>
              {t('common.loading')}
            </div>
          ) : patientError ? (
            <div className={`${READONLY_CLS} text-red-500 text-sm`}>
              {patientError}
            </div>
          ) : addresses.length > 0 ? (
            <div className="space-y-2">
              {addresses.map((addr) => (
                <button
                  key={addr.id}
                  type="button"
                  onClick={() => selectAddress(addr.id)}
                  className={[
                    'w-full text-left h-[60px] px-5 rounded-xl border transition-colors flex items-center gap-3',
                    selectedAddressId === addr.id
                      ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                      : 'border-[#E5E7EB] bg-white hover:border-slate-300',
                  ].join(' ')}
                  data-testid={`address-option-${addr.id}`}
                >
                  <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="truncate text-base text-slate-700">
                    {addr.address_formatted || addr.address_raw || '—'}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className={`${READONLY_CLS} text-slate-400 text-sm`}>
              {t('admin.vacancyModal.caseSelectStep.noAddresses')}
            </div>
          )}
        </FormField>
      </div>

      {/* 5. Address complement — read-only from selected patient_address (migration 157) */}
      <div className={patientDis}>
        <FormField label={tp('addressComplement')}>
          <div className={READONLY_CLS}>
            {addresses.find((a) => a.id === selectedAddressId)?.complement ?? '—'}
          </div>
        </FormField>
      </div>

      {/* 6. Map of the selected address. lat/lng come from the backend
          (PatientService geocodes at upsert; backfill script fills legacy rows).
          When coords are missing the component shows its placeholder. */}
      <FormField label="">
        {(() => {
          const selected = addresses.find((a) => a.id === selectedAddressId);
          return (
            <ServiceAreaMap
              lat={selected?.lat ?? null}
              lng={selected?.lng ?? null}
            />
          );
        })()}
      </FormField>

      {/* 7. Payment day */}
      <FormField label={tp('paymentDeadline')}>
        <InputWithIcon type="text" {...register('payment_day')} />
      </FormField>

      {/* 8. Providers needed */}
      <FormField
        label={tp('providersNeeded')}
        required
        error={
          errors.providers_needed
            ? tf('validation.providersMin')
            : undefined
        }
      >
        <InputWithIcon
          type="number"
          min={1}
          {...register('providers_needed', { valueAsNumber: true })}
          data-testid="providers-needed-input"
          error={
            errors.providers_needed
              ? tf('validation.providersMin')
              : undefined
          }
        />
      </FormField>

      {/* 9. Net hourly rate (salary_text) */}
      <FormField label={tp('netHourlyRate')}>
        <InputWithIcon type="text" {...register('salary_text')} />
      </FormField>

      {/* 10. Weekly hours — auto-computed from the schedule below */}
      <FormField label={tp('weeklyHours')}>
        <div className={READONLY_CLS} data-testid="weekly-hours-display">
          {weeklyHours > 0 ? weeklyHours : '—'}
        </div>
      </FormField>

      {/* 11. Schedule */}
      <FormField
        label={tp('schedule')}
        required
        error={errors.schedule ? tf('validation.scheduleRequired') : undefined}
      >
        <Controller
          name="schedule"
          control={control}
          render={({ field }) => (
            <VacancyDaySchedulePicker value={field.value} onChange={field.onChange} />
          )}
        />
      </FormField>
    </div>
  );
}
