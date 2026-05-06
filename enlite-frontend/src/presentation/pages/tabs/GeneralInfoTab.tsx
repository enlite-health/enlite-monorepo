import { useState, memo, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { generalInfoSchema, GeneralInfoFormData } from '@presentation/validation/workerRegistrationSchemas';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { compressImage } from '@presentation/utils/imageCompression';
import { formatDateFromISO, parseDateToISO } from '@presentation/hooks/useMask';
import { Button } from '@presentation/components/atoms/Button';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { GeneralInfoFormFields } from './GeneralInfoFormFields';

export const GeneralInfoTab = memo(function GeneralInfoTab(): JSX.Element {
  const { t } = useTranslation();
  const { saveGeneralInfo, getProgress } = useWorkerApi();

  const data = useWorkerRegistrationStore((state) => state.data);
  const isFieldReadonly = useWorkerRegistrationStore((state) => state.isFieldReadonly);
  const [profilePhotoPreview, setProfilePhotoPreview] = useState<string | null>(data.generalInfo.profilePhoto || null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const form = useForm<GeneralInfoFormData>({
    resolver: zodResolver(generalInfoSchema) as import('react-hook-form').Resolver<GeneralInfoFormData>,
    defaultValues: {
      fullName: data.generalInfo.fullName || '',
      lastName: data.generalInfo.lastName || '',
      cpf: data.generalInfo.cpf || '',
      phone: data.generalInfo.phone || '',
      email: data.generalInfo.email || '',
      birthDate: data.generalInfo.birthDate || '',
      sex: (data.generalInfo.sex as 'male' | 'female' | undefined) || undefined,
      gender: (data.generalInfo.gender as 'male' | 'female' | 'other' | undefined) || undefined,
      documentType: (data.generalInfo.documentType as 'CUIL_CUIT' | 'CPF' | 'RG' | 'CNH') || 'CUIL_CUIT',
      professionalLicense: data.generalInfo.professionalLicense || '',
      languages: data.generalInfo.languages?.length ? (data.generalInfo.languages as Array<'pt' | 'es' | 'en'>) : [],
      profession: (data.generalInfo.profession as 'AT' | 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST' | undefined) || undefined,
      knowledgeLevel: (data.generalInfo.knowledgeLevel as 'SECONDARY' | 'TERTIARY' | 'TECNICATURA' | 'BACHELOR' | 'POSTGRADUATE' | 'MASTERS' | 'DOCTORATE' | undefined) || undefined,
      experienceTypes: data.generalInfo.experienceTypes?.length ? (data.generalInfo.experienceTypes as Array<'adicciones' | 'psicosis' | 'trastorno_alimentar' | 'trastorno_bipolaridad' | 'trastorno_ansiedad' | 'trastorno_discapacidad_intelectual' | 'trastorno_depresivo' | 'trastorno_neurologico' | 'trastorno_opositor_desafiante' | 'trastorno_psicologico' | 'trastorno_psiquiatrico'>) : [],
      yearsExperience: (data.generalInfo.yearsExperience as '0_2' | '3_5' | '6_10' | '10_plus' | undefined) || undefined,
      preferredTypes: data.generalInfo.preferredTypes?.length ? (data.generalInfo.preferredTypes as Array<'adicciones' | 'psicosis' | 'trastorno_alimentar' | 'trastorno_bipolaridad' | 'trastorno_ansiedad' | 'trastorno_discapacidad_intelectual' | 'trastorno_depresivo' | 'trastorno_neurologico' | 'trastorno_opositor_desafiante' | 'trastorno_psicologico' | 'trastorno_psiquiatrico'>) : [],
      preferredAgeRange: data.generalInfo.preferredAgeRange?.length ? (data.generalInfo.preferredAgeRange as Array<'children' | 'adolescents' | 'adults' | 'elderly'>) : [],
      profilePhoto: data.generalInfo.profilePhoto || null,
    },
    mode: 'onChange',
  });

  const { handleSubmit, reset, getValues } = form;

  // Fetch real worker data from backend and populate form
  useEffect(() => {
    const fetchWorkerData = async () => {
      try {
        const workerData = await getProgress();

        reset({
          fullName: workerData.firstName || '',
          lastName: workerData.lastName || '',
          cpf: workerData.documentNumber || '',
          phone: workerData.phone || '',
          email: workerData.email || '',
          birthDate: formatDateFromISO(workerData.birthDate || '') || '',
          sex: (workerData.sex?.toLowerCase() as 'male' | 'female') || undefined,
          gender: (workerData.gender?.toLowerCase() as 'male' | 'female' | 'other') || undefined,
          documentType: (workerData.documentType as 'CUIL_CUIT' | 'CPF' | 'RG' | 'CNH') || 'CUIL_CUIT',
          professionalLicense: workerData.titleCertificate || '',
          languages: (workerData.languages as Array<'pt' | 'es' | 'en'>) || [],
          profession: (workerData.profession as 'AT' | 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST') || undefined,
          knowledgeLevel: (workerData.knowledgeLevel as 'SECONDARY' | 'TERTIARY' | 'TECNICATURA' | 'BACHELOR' | 'POSTGRADUATE' | 'MASTERS' | 'DOCTORATE') || undefined,
          experienceTypes: (workerData.experienceTypes as Array<'adicciones' | 'psicosis' | 'trastorno_alimentar' | 'trastorno_bipolaridad' | 'trastorno_ansiedad' | 'trastorno_discapacidad_intelectual' | 'trastorno_depresivo' | 'trastorno_neurologico' | 'trastorno_opositor_desafiante' | 'trastorno_psicologico' | 'trastorno_psiquiatrico'>) || [],
          yearsExperience: (workerData.yearsExperience as '0_2' | '3_5' | '6_10' | '10_plus') || undefined,
          preferredTypes: (workerData.preferredTypes as Array<'adicciones' | 'psicosis' | 'trastorno_alimentar' | 'trastorno_bipolaridad' | 'trastorno_ansiedad' | 'trastorno_discapacidad_intelectual' | 'trastorno_depresivo' | 'trastorno_neurologico' | 'trastorno_opositor_desafiante' | 'trastorno_psicologico' | 'trastorno_psiquiatrico'>) || [],
          preferredAgeRange: Array.isArray(workerData.preferredAgeRange)
            ? (workerData.preferredAgeRange as Array<'children' | 'adolescents' | 'adults' | 'elderly'>)
            : workerData.preferredAgeRange ? [workerData.preferredAgeRange as 'children' | 'adolescents' | 'adults' | 'elderly'] : [],
          profilePhoto: workerData.profilePhotoUrl || null,
        });

        if (workerData.profilePhotoUrl) {
          setProfilePhotoPreview(workerData.profilePhotoUrl);
        }
      } catch (error) {
        console.error('Failed to fetch worker data:', error);
      }
    };

    fetchWorkerData();
  }, [getProgress, reset]);

  const buildSavePayload = (formData: GeneralInfoFormData) => ({
    firstName: formData.fullName?.split(' ')[0] || formData.fullName || '',
    lastName: formData.lastName || '',
    sex: formData.sex as 'male' | 'female',
    gender: formData.gender as 'male' | 'female' | 'other',
    birthDate: formData.birthDate ? parseDateToISO(formData.birthDate) : undefined,
    documentType: 'CUIL_CUIT',
    documentNumber: formData.cpf || '',
    phone: formData.phone || '',
    profilePhotoUrl: formData.profilePhoto || undefined,
    languages: formData.languages || [],
    profession: formData.profession as 'AT' | 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST',
    knowledgeLevel: formData.knowledgeLevel as 'SECONDARY' | 'TERTIARY' | 'TECNICATURA' | 'BACHELOR' | 'POSTGRADUATE' | 'MASTERS' | 'DOCTORATE',
    titleCertificate: formData.professionalLicense || '',
    experienceTypes: formData.experienceTypes || [],
    yearsExperience: formData.yearsExperience as '0_2' | '3_5' | '6_10' | '10_plus',
    preferredTypes: formData.preferredTypes || [],
    preferredAgeRange: formData.preferredAgeRange || [],
    termsAccepted: true,
    privacyAccepted: true,
  });

  const triggerSave = useAutoSave(
    async () => {
      await saveGeneralInfo(buildSavePayload(getValues()));
    },
    500,
    (error) => {
      setSaveError(error instanceof Error ? error.message : t('workerRegistration.generalInfo.saveError'));
    },
  );

  const onSubmit = async (formData: GeneralInfoFormData): Promise<void> => {
    setSaveError(null);
    setSaveSuccess(false);
    setIsSaving(true);
    try {
      await saveGeneralInfo(buildSavePayload(formData));
      setSaveSuccess(true);
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('workerRegistration.generalInfo.saveError'));
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleProfilePhotoUpload = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = async () => {
      try {
        const result = reader.result as string;
        const compressed = await compressImage(result, 400, 400, 0.8);
        setProfilePhotoPreview(compressed);
        form.setValue('profilePhoto', compressed);
        triggerSave();
      } catch {
        const result = reader.result as string;
        setProfilePhotoPreview(result);
        form.setValue('profilePhoto', result);
        triggerSave();
      }
    };
    reader.readAsDataURL(file);
  };

  const profilePhotoElement = (
    <>
      <div className="w-16 h-16 relative flex items-center justify-center overflow-hidden rounded-full">
        {profilePhotoPreview ? (
          <img src={profilePhotoPreview} alt="Profile" className="w-full h-full object-cover" />
        ) : (
          <div className="w-16 h-16 bg-gray-300 rounded-full flex items-center justify-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className="text-gray-400">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="currentColor" />
            </svg>
          </div>
        )}
      </div>
      <label className="px-4 py-2 bg-primary text-white rounded-pill font-lexend font-medium text-sm hover:bg-primary/90 transition-colors cursor-pointer">
        {t('workerRegistration.generalInfo.addProfilePhoto')}
        <input type="file" accept="image/*" onChange={handleProfilePhotoUpload} className="hidden" />
      </label>
    </>
  );

  return (
    <form ref={formRef} onSubmit={handleSubmit(onSubmit)} onBlur={triggerSave} className="flex flex-col gap-6 w-full">
      {saveSuccess && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-input font-lexend text-sm text-green-700">
          {t('profile.saveSuccess', 'Informações salvas com sucesso!')}
        </div>
      )}
      {saveError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-input font-lexend text-sm text-red-700">
          {saveError}
        </div>
      )}

      <GeneralInfoFormFields
        form={form}
        isFieldReadonly={isFieldReadonly}
        triggerSave={triggerSave}
        profilePhotoElement={profilePhotoElement}
      />

      <div className="flex justify-end pt-4">
        <Button type="submit" variant="primary" size="md" isLoading={isSaving}>
          {t('profile.save', 'Salvar')}
        </Button>
      </div>
    </form>
  );
});
