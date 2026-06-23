import { Controller, type Control, type UseFormRegister } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import {
  WORKER_OCCUPATIONS,
  WORKER_KNOWLEDGE_LEVELS,
  WORKER_YEARS_EXPERIENCE,
  WORKER_AGE_RANGES,
  WORKER_LANGUAGES,
  WORKER_TRASTORNO_TYPES,
} from '@domain/entities/Worker';
import { Text } from '@presentation/components/atoms/Text';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import {
  getKnowledgeLevelLabel,
  getYearsExperienceLabel,
  getAgeRangeLabel,
  getLanguageLabel,
  getExperienceTypeLabel,
} from './workerDetailLabels';
import type { WorkerEditFormValues } from './WorkerEditModal';

interface Props {
  control: Control<WorkerEditFormValues>;
  register: UseFormRegister<WorkerEditFormValues>;
}

/**
 * Professional-data section of the worker edit drawer. Compact DS fields:
 * SelectField for single enums, MultiSelect for arrays, InputWithIcon for text.
 * Option labels reuse the existing workerDetailLabels resolvers.
 */
export function WorkerEditProfessionalFields({ control, register }: Props): JSX.Element {
  const { t } = useTranslation();
  const tm = (k: string, def: string) => t(`admin.workerDetail.editModal.${k}`, { defaultValue: def });

  const occupationOpts: SelectOption[] = WORKER_OCCUPATIONS.map((v) => ({
    value: v, label: t(`admin.workerDetail.occupationValue.${v}`, { defaultValue: v }),
  }));
  const knowledgeOpts: SelectOption[] = WORKER_KNOWLEDGE_LEVELS.map((v) => ({ value: v, label: getKnowledgeLevelLabel(t, v) ?? v }));
  const yearsOpts: SelectOption[] = WORKER_YEARS_EXPERIENCE.map((v) => ({ value: v, label: getYearsExperienceLabel(t, v) ?? v }));
  const ageOpts: SelectOption[] = WORKER_AGE_RANGES.map((v) => ({ value: v, label: getAgeRangeLabel(t, v) }));
  const langOpts: SelectOption[] = WORKER_LANGUAGES.map((v) => ({ value: v, label: getLanguageLabel(t, v) }));
  const trastornoOpts: SelectOption[] = WORKER_TRASTORNO_TYPES.map((v) => ({ value: v, label: getExperienceTypeLabel(t, v) }));

  return (
    <div className="flex flex-col gap-4 pt-2 border-t border-slate-100">
      <Text size="sm" weight="semibold" color="secondary">
        {tm('professionalSection', 'Datos profesionales')}
      </Text>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label={t('admin.workerDetail.occupation')} htmlFor="we-occupation">
          <Controller control={control} name="occupation" render={({ field }) => (
            <SelectField inputSize="compact" options={occupationOpts} placeholder={tm('unset', '—')} value={field.value} onChange={field.onChange} data-testid="we-occupation" />
          )} />
        </FormField>
        <FormField label={t('admin.workerDetail.knowledgeLevel')} htmlFor="we-knowledge">
          <Controller control={control} name="knowledgeLevel" render={({ field }) => (
            <SelectField inputSize="compact" options={knowledgeOpts} placeholder={tm('unset', '—')} value={field.value} onChange={field.onChange} data-testid="we-knowledge" />
          )} />
        </FormField>
        <FormField label={t('admin.workerDetail.yearsExperience')} htmlFor="we-years">
          <Controller control={control} name="yearsExperience" render={({ field }) => (
            <SelectField inputSize="compact" options={yearsOpts} placeholder={tm('unset', '—')} value={field.value} onChange={field.onChange} data-testid="we-years" />
          )} />
        </FormField>
        <FormField label={t('admin.workerDetail.titleCertificate')} htmlFor="we-title">
          <InputWithIcon id="we-title" inputSize="compact" data-testid="we-title" {...register('titleCertificate')} />
        </FormField>
      </div>

      <FormField label={t('admin.workerDetail.experienceTypes')}>
        <Controller control={control} name="experienceTypes" render={({ field }) => (
          <MultiSelect options={trastornoOpts} value={field.value} onChange={field.onChange} placeholder={tm('unset', '—')} id="we-experienceTypes" />
        )} />
      </FormField>
      <FormField label={t('admin.workerDetail.preferredTypes')}>
        <Controller control={control} name="preferredTypes" render={({ field }) => (
          <MultiSelect options={trastornoOpts} value={field.value} onChange={field.onChange} placeholder={tm('unset', '—')} id="we-preferredTypes" />
        )} />
      </FormField>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <FormField label={t('admin.workerDetail.preferredAgeRange')}>
          <Controller control={control} name="preferredAgeRange" render={({ field }) => (
            <MultiSelect options={ageOpts} value={field.value} onChange={field.onChange} placeholder={tm('unset', '—')} id="we-ageRange" />
          )} />
        </FormField>
        <FormField label={t('admin.workerDetail.languages')}>
          <Controller control={control} name="languages" render={({ field }) => (
            <MultiSelect options={langOpts} value={field.value} onChange={field.onChange} placeholder={tm('unset', '—')} id="we-languages" />
          )} />
        </FormField>
      </div>
      <FormField label={t('admin.workerDetail.linkedin', { defaultValue: 'LinkedIn' })} htmlFor="we-linkedin">
        <InputWithIcon id="we-linkedin" inputSize="compact" data-testid="we-linkedin" {...register('linkedinUrl')} />
      </FormField>
    </div>
  );
}
