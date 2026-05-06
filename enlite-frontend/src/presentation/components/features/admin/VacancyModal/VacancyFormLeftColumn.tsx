/**
 * VacancyFormLeftColumn
 *
 * Left column fields of the two-column VacancyFormSection.
 * Patient-derived fields show a gray background (and are unclickable) until a case is selected.
 *
 * Design-system components used:
 *   - FormField  → replaces FieldGroup (label + children + error)
 *   - SelectField → replaces raw <select> + SELECT_CLS (via Controller)
 *   - InputWithIcon → replaces raw <input> + INPUT_CLS
 */

import { useState, useEffect } from 'react';
import { UseFormRegister, Control, Controller, FieldErrors } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Search, Loader2 } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { CaseOption } from '@hooks/admin/useVacancyModalFlow';
import { FormField } from '@presentation/components/molecules/FormField/FormField';
import { SelectField } from '@presentation/components/molecules/SelectField/SelectField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon/InputWithIcon';
import type { VacancyFormData } from '../vacancy-form-schema';
import { PROFESSION_OPTIONS, SEX_OPTIONS, AGE_RANGE_OPTIONS } from '../vacancy-form-schema';
import { SELECT_CLS, TEXTAREA_CLS, READONLY_CLS } from './vacancyFormShared';
import { MeetLinksField } from './MeetLinksField';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface VacancyFormLeftColumnProps {
  mode: 'create' | 'edit';
  register: UseFormRegister<VacancyFormData>;
  control: Control<VacancyFormData>;
  errors: FieldErrors<VacancyFormData>;
  patientSelected: boolean;
  diagnosis: string | null;
  patientName: string | null;
  selectedCaseNumber: number | null;
  selectedPatientId: string | null;
  dependencyLevel: string | null;
  selectCase: (caseNumber: number, patientId: string) => void;
  setValue: (field: 'age_range_min' | 'age_range_max', value: number | undefined) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function VacancyFormLeftColumn({
  mode,
  register,
  control,
  errors,
  patientSelected,
  diagnosis,
  patientName,
  selectedCaseNumber,
  selectedPatientId,
  dependencyLevel,
  selectCase,
  setValue,
}: VacancyFormLeftColumnProps): JSX.Element {
  const { t } = useTranslation();
  const tp = (k: string) => t(`admin.vacancyModal.${k}`);
  const tf = (k: string) => t(`admin.vacancyDetail.vacancyForm.${k}`);

  const [cases, setCases] = useState<CaseOption[]>([]);
  const [isLoadingCases, setIsLoadingCases] = useState(mode === 'create');
  const [casesError, setCasesError] = useState<string | null>(null);
  const [selectedAgeRange, setSelectedAgeRange] = useState<string>('');

  useEffect(() => {
    if (mode !== 'create') return;
    setIsLoadingCases(true);
    AdminApiService.getCasesForSelect()
      .then(setCases)
      .catch((err: unknown) =>
        setCasesError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setIsLoadingCases(false));
  }, [mode]);

  const handleCaseChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (!val) return;
    const found = cases.find((c) => c.caseNumber === Number(val));
    if (found) selectCase(found.caseNumber, found.patientId);
  };

  // When patient isn't selected: gray-out the white wrappers of inputs/selects/readonly cells
  // (signals "fill the case first") without fading labels. We target `.bg-white` on the
  // molecule wrappers (InputWithIcon/SelectField) and read-only divs.
  const patientDis = !patientSelected
    ? 'pointer-events-none select-none [&_.bg-white]:!bg-[#f3f4f6]'
    : '';

  // Reference selectedPatientId to avoid unused-variable lint error
  void selectedPatientId;

  return (
    <div className="space-y-6">
      {/* 1. Case number — select (create) or read-only (edit) */}
      <div className="flex flex-col gap-1 mb-0">
        <FormField label={tp('caseNumber')} required={mode === 'create'}>
          {mode === 'create' ? (
            isLoadingCases ? (
              <div className="flex items-center gap-2 min-h-[56px] px-4 border-[1.5px] border-[#D9D9D9] rounded-[10px] bg-white text-gray-600 text-sm font-medium">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('admin.vacancyModal.caseSelectStep.loadingCases')}
              </div>
            ) : casesError ? (
              <p className="text-red-500 text-sm">{casesError}</p>
            ) : (
              <div className="flex items-center min-h-[56px] px-4 rounded-[10px] border-[1.5px] border-[#D9D9D9] bg-white focus-within:border-primary transition-colors">
                <div className="flex justify-between w-full items-center relative">
                  <select
                    className={SELECT_CLS}
                    value={selectedCaseNumber ?? ''}
                    onChange={handleCaseChange}
                    data-testid="case-select"
                  >
                    <option value="">
                      {t('admin.vacancyModal.caseSelectStep.casePlaceholder')}
                    </option>
                    {cases.map((c) => (
                      <option key={c.caseNumber} value={c.caseNumber}>
                        {t('admin.vacancyModal.caseSelectStep.caseOptionLabel', {
                          caseNumber: c.caseNumber,
                        })}
                      </option>
                    ))}
                  </select>
                  <img
                    className="absolute right-0 w-3 h-[7px] pointer-events-none z-0"
                    alt="Dropdown"
                    src="https://c.animaapp.com/Bbli6X7n/img/vector-9.svg"
                  />
                </div>
              </div>
            )
          ) : (
            <div className={READONLY_CLS} data-testid="case-number-display">
              {selectedCaseNumber != null ? `CASO ${selectedCaseNumber}` : '—'}
            </div>
          )}
        </FormField>
      </div>

      {/* 2. Patient name — read-only from patient */}
      <div className={patientDis}>
        <FormField label={tp('patientName')}>
          <div className={READONLY_CLS}>{patientName ?? '—'}</div>
        </FormField>
      </div>

      {/* 3. Professional type — Controller to write single value into array */}
      <div className={patientDis}>
        <FormField
          label={tp('professionalType')}
          required
          error={
            errors.required_professions
              ? tf('validation.requiredProfessionsMin')
              : undefined
          }
        >
          <Controller
            name="required_professions"
            control={control}
            render={({ field }) => (
              <SelectField
                value={field.value[0] ?? ''}
                onChange={(v) => field.onChange(v ? [v] : [])}
                options={PROFESSION_OPTIONS.map((p) => ({
                  value: p,
                  label: tf(`professionOptions.${p}`),
                }))}
                placeholder={tp('professionalTypePlaceholder')}
                error={
                  errors.required_professions
                    ? tf('validation.requiredProfessionsMin')
                    : undefined
                }
                data-testid="profession-select"
              />
            )}
          />
        </FormField>
      </div>

      {/* 4. Dependency level — read-only from patient (translated label) */}
      <div className={patientDis}>
        <FormField label={tp('dependencyLevel')}>
          <div className={READONLY_CLS}>
            {dependencyLevel
              ? t(`admin.patients.dependencyOptions.${dependencyLevel}`, {
                  defaultValue: dependencyLevel,
                })
              : '—'}
          </div>
        </FormField>
      </div>

      {/* 5. Worker profile */}
      <FormField label={tp('workerProfile')}>
        <textarea
          {...register('worker_attributes')}
          className={`${TEXTAREA_CLS} h-[183px]`}
        />
      </FormField>

      {/* 6. Available for (sex) */}
      <div className={patientDis}>
        <FormField label={tp('availableFor')}>
          <Controller
            name="required_sex"
            control={control}
            render={({ field }) => (
              <SelectField
                value={field.value ?? ''}
                onChange={(v) => field.onChange(v)}
                options={SEX_OPTIONS.map((o) => ({
                  value: o,
                  label: tf(`sexOptions.${o}`),
                }))}
                placeholder={tp('sexPlaceholder')}
              />
            )}
          />
        </FormField>
      </div>

      {/* 7. Diagnostic hypothesis — read-only from patient */}
      <div className={patientDis}>
        <FormField label={tp('diagnosticHypothesis')}>
          <div className="relative">
            <div className={`min-h-[112px] h-auto w-full px-4 py-3 text-base font-medium text-gray-600 border-[1.5px] border-[#D9D9D9] rounded-[10px] bg-white cursor-default flex items-start pr-12`}>
              <span>{diagnosis ?? '—'}</span>
            </div>
            <Search className="absolute right-4 top-3 w-4 h-4 text-gray-400 pointer-events-none" />
          </div>
        </FormField>
      </div>

      {/* 8. Age range — single select with text labels */}
      <FormField label={tp('ageRange')}>
        <SelectField
          value={selectedAgeRange}
          onChange={(label) => {
            setSelectedAgeRange(label);
            const opt = AGE_RANGE_OPTIONS.find((o) => o.label === label);
            if (opt) {
              setValue('age_range_min', opt.min);
              setValue('age_range_max', opt.max);
            } else {
              setValue('age_range_min', undefined);
              setValue('age_range_max', undefined);
            }
          }}
          options={AGE_RANGE_OPTIONS.map((o) => ({ value: o.label, label: o.label }))}
          placeholder="—"
          data-testid="age-range-select"
        />
      </FormField>

      {/* 9. Meet links — extracted to MeetLinksField for size/SRP. */}
      <div className={patientDis}>
        <MeetLinksField control={control} errors={errors} />
      </div>

      {/* 10. Publish date — defaults to today, optional, editable. */}
      <FormField label={tp('publishDate')}>
        <InputWithIcon
          type="date"
          {...register('published_at')}
          data-testid="published-at-input"
        />
      </FormField>

      {/* 11. Closing date — optional, blank by default. */}
      <FormField label={tp('closingDate')}>
        <InputWithIcon
          type="date"
          {...register('closes_at')}
          data-testid="closes-at-input"
        />
      </FormField>
    </div>
  );
}
