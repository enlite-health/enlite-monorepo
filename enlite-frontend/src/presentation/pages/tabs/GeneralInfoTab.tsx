import { useState, memo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { generalInfoSchema, GeneralInfoFormData } from '@presentation/validation/workerRegistrationSchemas';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { ApiError } from '@infrastructure/http/ApiError';
import { compressImage } from '@presentation/utils/imageCompression';
import { formatDateFromISO, parseDateToISO } from '@presentation/hooks/useMask';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { useToast } from '@presentation/hooks/useToast';
import { GeneralInfoFormFields } from './GeneralInfoFormFields';

export const GeneralInfoTab = memo(function GeneralInfoTab(): JSX.Element {
  const { t } = useTranslation();
  const { saveGeneralInfo } = useWorkerApi();

  const data = useWorkerRegistrationStore((state) => state.data);
  const isFieldReadonly = useWorkerRegistrationStore((state) => state.isFieldReadonly);
  const updateGeneralInfo = useWorkerRegistrationStore((state) => state.updateGeneralInfo);
  const [profilePhotoPreview, setProfilePhotoPreview] = useState<string | null>(data.generalInfo.profilePhoto || null);
  const showToast = useToast();

  const form = useForm<GeneralInfoFormData>({
    resolver: zodResolver(generalInfoSchema) as import('react-hook-form').Resolver<GeneralInfoFormData>,
    defaultValues: {
      fullName: data.generalInfo.fullName || '',
      lastName: data.generalInfo.lastName || '',
      cpf: data.generalInfo.cpf || '',
      phone: data.generalInfo.phone || '',
      email: data.generalInfo.email || '',
      birthDate: formatDateFromISO(data.generalInfo.birthDate || '') || '',
      sex: (data.generalInfo.sex?.toLowerCase() as 'male' | 'female' | undefined) || undefined,
      gender: (data.generalInfo.gender?.toLowerCase() as 'male' | 'female' | 'other' | undefined) || undefined,
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
    // on-blur: valida quando o campo perde o foco (e re-valida ao digitar
    // depois disso). Evita "erro no 1º caractere" de Nombre/CUIL durante a
    // digitação — ver docs/features/worker-registration-ux/ux-review-2026-06-28.md.
    mode: 'onTouched',
  });

  const { getValues } = form;

  // O formulário é populado pelos `defaultValues` acima, que leem do store
  // (Zustand). A WorkerProfilePage já fez `getProgress()` + `hydrateFromServer()`
  // ANTES de renderizar esta aba, e o hydrate PRESERVA o valor local quando o
  // backend devolve null (`serverData.firstName || store.fullName`).
  //
  // IMPORTANTE: NÃO refazer aqui um `getProgress()` + `reset()`. A versão
  // anterior fazia `reset({ fullName: workerData.firstName || '' })`, o que
  // SOBRESCREVIA com '' o nome que o hydrate tinha preservado — era exatamente
  // o "campo aparece e some" (reproduzido em prod, 2026-06-29). O store é a
  // fonte única; o reset duplicado só reintroduzia a corrida e o data-loss.

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

  // Traduz o erro de salvamento para uma mensagem amigável.
  // Erros com código conhecido (ex.: PHONE_NOT_AVAILABLE) viram mensagem
  // localizada — nunca expomos a mensagem crua do backend (que pode conter
  // detalhes de SQL/constraint) diretamente ao worker.
  const resolveSaveErrorMessage = (error: unknown): string => {
    if (error instanceof ApiError && error.code === 'PHONE_NOT_AVAILABLE') {
      return t(
        'workerRegistration.generalInfo.phoneNotAvailable',
        'El teléfono ingresado no puede ser utilizado.',
      );
    }
    return error instanceof Error ? error.message : t('workerRegistration.generalInfo.saveError');
  };

  const triggerSave = useAutoSave(
    async () => {
      const values = getValues();
      await saveGeneralInfo(buildSavePayload(values));
      // Mantém o store (fonte única) em sincronia com o que foi salvo, para que
      // trocar de aba e voltar mostre o valor atual — sem re-fetch e sem o
      // reset que zerava os campos.
      updateGeneralInfo({
        ...values,
        birthDate: values.birthDate ? parseDateToISO(values.birthDate) : '',
      });
      showToast(t('profile.saveSuccess', 'Información guardada con éxito'), 'success', 'profile-save');
    },
    500,
    (error) => {
      showToast(resolveSaveErrorMessage(error), 'error', 'profile-save');
    },
  );

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
    <form onSubmit={(e) => e.preventDefault()} onBlur={triggerSave} className="flex flex-col gap-6 w-full">
      <GeneralInfoFormFields
        form={form}
        isFieldReadonly={isFieldReadonly}
        triggerSave={triggerSave}
        profilePhotoElement={profilePhotoElement}
      />
    </form>
  );
});
