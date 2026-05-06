/**
 * GeneralInfoFormFields
 *
 * Extracted sub-component — renders the grid of form inputs for GeneralInfoTab.
 * Keeps GeneralInfoTab.tsx under 400 lines.
 */

import { Controller } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { PhoneInputIntl } from '@presentation/components/shared/PhoneInputIntl';
import { MultiSelect } from '@presentation/components/molecules/MultiSelect';
import { maskDate, maskCuilCuit } from '@presentation/hooks/useMask';
import { FormField, InputWithIcon, SelectField } from '@presentation/components/molecules';
import type { UseFormReturn } from 'react-hook-form';
import type { GeneralInfoFormData } from '@presentation/validation/workerRegistrationSchemas';

interface Props {
  form: UseFormReturn<GeneralInfoFormData>;
  isFieldReadonly: (field: string) => boolean;
  triggerSave: () => void;
  profilePhotoElement: React.ReactNode;
}

const PROFESSION_OPTIONS = [
  { value: 'AT', label: 'Acompañante Terapéutico' },
  { value: 'CAREGIVER', label: 'Cuidador(a)' },
  { value: 'NURSE', label: 'Enfermera(o)' },
  { value: 'KINESIOLOGIST', label: 'Kinesióloga(o)' },
  { value: 'PSYCHOLOGIST', label: 'Psicóloga(o)' },
];

const KNOWLEDGE_OPTIONS = [
  { value: 'SECONDARY', label: 'Secundario' },
  { value: 'TERTIARY', label: 'Terciario' },
  { value: 'TECNICATURA', label: 'Tecnicatura' },
  { value: 'BACHELOR', label: 'Licenciatura' },
  { value: 'POSTGRADUATE', label: 'Posgrado' },
  { value: 'MASTERS', label: 'Maestría' },
  { value: 'DOCTORATE', label: 'Doctorado' },
];

const TRASTORNO_OPTIONS = [
  { value: 'adicciones', label: 'Adicciones' },
  { value: 'psicosis', label: 'Psicosis' },
  { value: 'trastorno_alimentar', label: 'Trastorno Alimentar' },
  { value: 'trastorno_bipolaridad', label: 'Trastorno Bipolaridad' },
  { value: 'trastorno_ansiedad', label: 'Trastorno de Ansiedad' },
  { value: 'trastorno_discapacidad_intelectual', label: 'Trastorno de Discapacidad Intelectual' },
  { value: 'trastorno_depresivo', label: 'Trastorno Depresivo' },
  { value: 'trastorno_neurologico', label: 'Trastorno Neurológico' },
  { value: 'trastorno_opositor_desafiante', label: 'Trastorno Opositor Desafiante' },
  { value: 'trastorno_psicologico', label: 'Trastorno Psicológico' },
  { value: 'trastorno_psiquiatrico', label: 'Trastorno Psiquiátrico' },
];

export function GeneralInfoFormFields({ form, isFieldReadonly, triggerSave, profilePhotoElement }: Props) {
  const { t } = useTranslation();
  const { register, control, setValue, formState: { errors } } = form;

  const applyDocumentMask = (value: string) => maskCuilCuit(value);

  return (
    <>
      {/* Profile Photo */}
      <div className="flex flex-col items-center gap-3">
        {profilePhotoElement}
      </div>

      {/* Form Fields Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Email */}
        <FormField label={t('workerRegistration.generalInfo.email')} htmlFor="email" error={errors.email?.message}>
          <InputWithIcon id="email" type="email" {...register('email')}
            readOnly={isFieldReadonly('email')} className={isFieldReadonly('email') ? 'bg-gray-200' : ''}
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17 21.25H7C3.35 21.25 1.25 19.15 1.25 15.5V8.5C1.25 4.85 3.35 2.75 7 2.75H17C20.65 2.75 22.75 4.85 22.75 8.5V15.5C22.75 19.15 20.65 21.25 17 21.25ZM7 4.25C4.14 4.25 2.75 5.64 2.75 8.5V15.5C2.75 18.36 4.14 19.75 7 19.75H17C19.86 19.75 21.25 18.36 21.25 15.5V8.5C21.25 5.64 19.86 4.25 17 4.25H7Z" fill="#180149"/><path d="M12.003 12.868C11.163 12.868 10.313 12.608 9.663 12.078L6.533 9.57802C6.213 9.31802 6.153 8.84802 6.413 8.52802C6.673 8.20802 7.143 8.14802 7.463 8.40802L10.593 10.908C11.353 11.518 12.643 11.518 13.403 10.908L16.533 8.40802C16.853 8.14802 17.333 8.19802 17.583 8.52802C17.843 8.84802 17.793 9.32802 17.463 9.57802L14.333 12.078C13.693 12.608 12.843 12.868 12.003 12.868Z" fill="#180149"/></svg>}
          />
        </FormField>

        {/* Languages */}
        <Controller name="languages" control={control} render={({ field }) => (
          <MultiSelect testId="languages" label={t('workerRegistration.generalInfo.languages')}
            options={[
              { value: 'pt', label: t('workerRegistration.generalInfo.portuguese') },
              { value: 'es', label: t('workerRegistration.generalInfo.spanish') },
              { value: 'en', label: t('workerRegistration.generalInfo.english') },
            ]}
            value={field.value} onChange={(val) => { field.onChange(val); triggerSave(); }}
            placeholder={t('workerRegistration.generalInfo.select')} error={errors.languages?.message}
          />
        )} />

        {/* First Name */}
        <FormField label={t('workerRegistration.generalInfo.firstName')} htmlFor="fullName" error={errors.fullName?.message}>
          <InputWithIcon id="fullName" type="text" {...register('fullName')} />
        </FormField>

        {/* Last Name */}
        <FormField label={t('workerRegistration.generalInfo.lastName')} htmlFor="lastName" error={errors.lastName?.message}>
          <InputWithIcon id="lastName" type="text" {...register('lastName')} />
        </FormField>

        {/* Sex */}
        <Controller name="sex" control={control} render={({ field }) => (
          <FormField label={t('workerRegistration.generalInfo.sex')} htmlFor="sex" error={errors.sex?.message}>
            <SelectField id="sex"
              options={[
                { value: 'male', label: t('workerRegistration.generalInfo.male') },
                { value: 'female', label: t('workerRegistration.generalInfo.female') },
              ]}
              placeholder={t('workerRegistration.generalInfo.select')} value={field.value} onChange={field.onChange}
            />
          </FormField>
        )} />

        {/* Gender */}
        <Controller name="gender" control={control} render={({ field }) => (
          <FormField label={t('workerRegistration.generalInfo.gender')} htmlFor="gender">
            <SelectField id="gender"
              options={[
                { value: 'male', label: t('workerRegistration.generalInfo.male') },
                { value: 'female', label: t('workerRegistration.generalInfo.female') },
                { value: 'other', label: t('workerRegistration.generalInfo.other') },
              ]}
              placeholder={t('workerRegistration.generalInfo.select')} value={field.value} onChange={field.onChange}
            />
          </FormField>
        )} />

        {/* CUIL/CUIT */}
        <FormField label="CUIL/CUIT" htmlFor="cpf" error={errors.cpf?.message}>
          <InputWithIcon id="cpf" type="text" {...register('cpf')}
            readOnly={isFieldReadonly('cpf')} className={isFieldReadonly('cpf') ? 'bg-gray-200' : ''}
            placeholder="00-00000000-0" maxLength={13}
            onChange={(e) => { setValue('cpf', applyDocumentMask(e.target.value), { shouldValidate: true }); }}
          />
        </FormField>

        {/* Birth Date */}
        <FormField label={t('workerRegistration.generalInfo.birthDate')} htmlFor="birthDate" error={errors.birthDate?.message}>
          <InputWithIcon id="birthDate" type="text" {...register('birthDate')}
            placeholder={t('workerRegistration.generalInfo.birthDatePlaceholder')} maxLength={10}
            onChange={(e) => { setValue('birthDate', maskDate(e.target.value), { shouldValidate: true }); }}
          />
        </FormField>

        {/* Phone */}
        <FormField label={t('workerRegistration.generalInfo.phone')} htmlFor="phone" error={errors.phone?.message}>
          <Controller name="phone" control={control} render={({ field }) => (
            <PhoneInputIntl value={field.value} onChange={field.onChange}
              placeholder={t('workerRegistration.generalInfo.phonePlaceholder')}
              readOnly={isFieldReadonly('phone')} className="border-gray-600 focus-within:border-primary"
            />
          )} />
        </FormField>

        {/* Profession */}
        <Controller name="profession" control={control} render={({ field }) => (
          <FormField label={t('workerRegistration.generalInfo.profession')} htmlFor="profession">
            <SelectField id="profession" options={PROFESSION_OPTIONS}
              placeholder={t('workerRegistration.generalInfo.select')} value={field.value} onChange={field.onChange}
            />
          </FormField>
        )} />

        {/* Knowledge Level */}
        <Controller name="knowledgeLevel" control={control} render={({ field }) => (
          <FormField label={t('workerRegistration.generalInfo.knowledgeLevel')} htmlFor="knowledgeLevel" error={errors.knowledgeLevel?.message}>
            <SelectField id="knowledgeLevel" options={KNOWLEDGE_OPTIONS}
              placeholder={t('workerRegistration.generalInfo.select')} value={field.value} onChange={field.onChange}
            />
          </FormField>
        )} />

        {/* Professional License */}
        <FormField label={t('workerRegistration.generalInfo.professionalLicense')} htmlFor="professionalLicense" error={errors.professionalLicense?.message}>
          <InputWithIcon id="professionalLicense" type="text" {...register('professionalLicense')}
            readOnly={isFieldReadonly('professionalLicense')}
            placeholder={t('workerRegistration.generalInfo.professionalLicensePlaceholder')}
            className={isFieldReadonly('professionalLicense') ? 'bg-gray-200' : ''}
          />
        </FormField>

        {/* Experience Types */}
        <Controller name="experienceTypes" control={control} render={({ field }) => (
          <MultiSelect testId="experience-types" label={t('workerRegistration.generalInfo.experienceTypes')}
            options={TRASTORNO_OPTIONS} value={field.value}
            onChange={(val) => { field.onChange(val); triggerSave(); }}
            placeholder={t('workerRegistration.generalInfo.select')} error={errors.experienceTypes?.message}
          />
        )} />

        {/* Years Experience */}
        <Controller name="yearsExperience" control={control} render={({ field }) => (
          <FormField label={t('workerRegistration.generalInfo.yearsExperience')} htmlFor="yearsExperience" error={errors.yearsExperience?.message}>
            <SelectField id="yearsExperience"
              options={[
                { value: '0_2', label: t('workerRegistration.generalInfo.years0to2') },
                { value: '3_5', label: t('workerRegistration.generalInfo.years3to5') },
                { value: '6_10', label: t('workerRegistration.generalInfo.years6to10') },
                { value: '10_plus', label: t('workerRegistration.generalInfo.years10plus') },
              ]}
              placeholder={t('workerRegistration.generalInfo.select')} value={field.value} onChange={field.onChange}
            />
          </FormField>
        )} />

        {/* Preferred Types */}
        <Controller name="preferredTypes" control={control} render={({ field }) => (
          <MultiSelect testId="preferred-types" label="¿Con que tipos de pacientes te gustaria acompañar?"
            options={TRASTORNO_OPTIONS} value={field.value}
            onChange={(val) => { field.onChange(val); triggerSave(); }}
            placeholder={t('workerRegistration.generalInfo.select')} error={errors.preferredTypes?.message}
          />
        )} />

        {/* Preferred Age Range */}
        <Controller name="preferredAgeRange" control={control} render={({ field }) => (
          <MultiSelect testId="preferred-age-range" label={t('workerRegistration.generalInfo.preferredAgeRange')}
            options={[
              { value: 'children', label: t('workerRegistration.generalInfo.ageRangeChildren') },
              { value: 'adolescents', label: t('workerRegistration.generalInfo.ageRangeAdolescents') },
              { value: 'adults', label: t('workerRegistration.generalInfo.ageRangeAdults') },
              { value: 'elderly', label: t('workerRegistration.generalInfo.ageRangeElderly') },
            ]}
            value={field.value}
            onChange={(val) => { field.onChange(val); triggerSave(); }}
            placeholder={t('workerRegistration.generalInfo.select')} error={errors.preferredAgeRange?.message}
          />
        )} />
      </div>
    </>
  );
}
