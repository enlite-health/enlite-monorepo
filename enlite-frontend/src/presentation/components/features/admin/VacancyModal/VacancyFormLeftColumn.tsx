/**
 * VacancyFormLeftColumn
 *
 * Left column fields of the two-column VacancyFormSection.
 * Patient-derived fields show a gray background (and are unclickable) until a case is selected.
 *
 * Design-system components used:
 *   - FormField  → label + children + error
 *   - SelectField → simple selects via Controller
 *   - SearchableSelect → case-number picker (typeable filter for many cases)
 *   - InputWithIcon → date inputs
 */

import { useState, useEffect } from 'react';
import { UseFormRegister, Control, Controller, FieldErrors, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Search, Loader2 } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { CaseOption } from '@hooks/admin/useVacancyModalFlow';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';
import { Heading } from '@presentation/components/atoms/Heading';
import { FormField } from '@presentation/components/molecules/FormField/FormField';
import { SelectField } from '@presentation/components/molecules/SelectField/SelectField';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon/InputWithIcon';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import type { VacancyFormData } from '../vacancy-form-schema';
import { PROFESSION_OPTIONS, SEX_OPTIONS, AGE_RANGE_OPTIONS } from '../vacancy-form-schema';
import { TEXTAREA_CLS, READONLY_CLS } from './vacancyFormShared';
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

  const handleCaseChange = (val: string): void => {
    if (!val) return;
    // Comparação por STRING, não `Number(val)`: `val` já é `String(c.caseNumber)` (a
    // `SearchableSelect` recebe `value` cru — só o `label` leva o prefixo `EN`, formatado).
    // `Number()` sobre texto formatado (`"EN1234"`) dá `NaN`, e `NaN !== NaN` é sempre true —
    // clique sem efeito, sem erro.
    const found = cases.find((c) => String(c.caseNumber) === val);
    if (found) selectCase(found.caseNumber, found.patientId);
  };

  // Derive the displayed age-range bucket from the form's numeric values so the
  // dropdown stays in sync with edit-mode initial data and external resets.
  const ageRangeMin = useWatch({ control, name: 'age_range_min' });
  const ageRangeMax = useWatch({ control, name: 'age_range_max' });
  const selectedAgeKey =
    AGE_RANGE_OPTIONS.find(
      (o) => (o.min ?? null) === (ageRangeMin ?? null) && (o.max ?? null) === (ageRangeMax ?? null),
    )?.key ?? '';

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
      {/* Spec 014 (US-D6): título de seção — os 22 campos do formulário agrupados
          visualmente. */}
      <Heading level={4} weight="semibold" color="secondary">{tp('sectionCaseAndProfile')}</Heading>

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
              <div data-testid="case-select">
                <SearchableSelect
                  value={selectedCaseNumber != null ? String(selectedCaseNumber) : ''}
                  onChange={handleCaseChange}
                  options={cases.map((c) => ({
                    // `value` fica CRU (nunca o formatado) — é o que `handleCaseChange` compara
                    // de volta contra `String(c.caseNumber)`. Só o `label` leva o prefixo `EN`.
                    value: String(c.caseNumber),
                    label: t('admin.vacancyModal.caseSelectStep.caseOptionLabel', {
                      caseNumber: formatCaseNumber(c.caseNumber),
                    }),
                  }))}
                  placeholder={t('admin.vacancyModal.caseSelectStep.casePlaceholder')}
                  searchPlaceholder={t('common.search', 'Buscar...')}
                />
              </div>
            )
          ) : (
            <div className={READONLY_CLS} data-testid="case-number-display">
              {selectedCaseNumber != null ? `CASO ${formatCaseNumber(selectedCaseNumber)}` : '—'}
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

      {/* 3. Professional type — multi-select via inline checkboxes. The
          backend matches workers by `requiredProfessions.includes(occupation)`,
          so checking both AT and Cuidador naturally expresses "indistinto". */}
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
              <div
                className={`flex items-center gap-8 min-h-[60px] px-5 rounded-[10px] border-2 bg-white transition-colors ${
                  errors.required_professions ? 'border-red-500' : 'border-[#D9D9D9] focus-within:border-[#180149]'
                }`}
                data-testid="profession-checkboxes"
              >
                {PROFESSION_OPTIONS.map((p) => {
                  const checked = field.value?.includes(p) ?? false;
                  return (
                    <Checkbox
                      key={p}
                      id={`profession-${p}`}
                      label={tf(`professionOptions.${p}`)}
                      checked={checked}
                      onChange={() => {
                        const current = field.value ?? [];
                        field.onChange(
                          checked ? current.filter((v) => v !== p) : [...current, p],
                        );
                      }}
                      data-testid={`profession-checkbox-${p}`}
                    />
                  );
                })}
              </div>
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

      {/* 8. Age range — bucket select. All buckets respect the schema floor (min ≥ 18). */}
      <FormField label={tp('ageRange')}>
        <SelectField
          value={selectedAgeKey}
          onChange={(key) => {
            const opt = AGE_RANGE_OPTIONS.find((o) => o.key === key);
            setValue('age_range_min', opt?.min);
            setValue('age_range_max', opt?.max);
          }}
          options={AGE_RANGE_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
          placeholder="—"
          data-testid="age-range-select"
        />
      </FormField>

      {/* Spec 014 (US-D6): segunda seção da coluna esquerda. */}
      <Heading level={4} weight="semibold" color="secondary" className="pt-2 border-t border-slate-100">
        {tp('sectionScheduleAndDates')}
      </Heading>

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
