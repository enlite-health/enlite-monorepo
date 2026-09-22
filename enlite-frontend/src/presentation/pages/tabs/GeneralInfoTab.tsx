import { useState, useRef, memo } from 'react';
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
import { PhoneConflictModal } from '@presentation/components/shared/PhoneConflictModal/PhoneConflictModal';
import { WorkerApiService, AccountLinkLookupResponse } from '@infrastructure/http/WorkerApiService';

export const GeneralInfoTab = memo(function GeneralInfoTab(): JSX.Element {
  const { t } = useTranslation();
  const { saveGeneralInfo } = useWorkerApi();

  const data = useWorkerRegistrationStore((state) => state.data);
  const isFieldReadonly = useWorkerRegistrationStore((state) => state.isFieldReadonly);
  const hydrateFromServer = useWorkerRegistrationStore((state) => state.hydrateFromServer);
  // Spec 025 (opção A, 21/09): veredito FRESCO do backend, recalculado a cada
  // hydrateFromServer — ver comentário no store.
  const birthDateInvalid = useWorkerRegistrationStore((state) => state.birthDateInvalid);
  const [profilePhotoPreview, setProfilePhotoPreview] = useState<string | null>(data.generalInfo.profilePhoto || null);
  const showToast = useToast();

  // Vínculo self-service por colisão de telefone (409 PHONE_NOT_AVAILABLE).
  // Enquanto a modal está aberta, TODO toast do autosave é suprimido — no caso
  // Edith os toasts de sucesso dos outros campos abafavam o erro do telefone.
  const [phoneConflict, setPhoneConflict] = useState<{ phoneEntered: string; lookupData: AccountLinkLookupResponse } | null>(null);
  const phoneConflictOpenRef = useRef(false);
  phoneConflictOpenRef.current = phoneConflict !== null;

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
  // Assina o dirty-tracking do react-hook-form LENDO `dirtyFields` no render.
  // `formState` é um Proxy que só computa `dirtyFields` quando a propriedade é
  // acessada durante o render — sem esta leitura, `dirtyFields` fica sempre
  // vazio e o gate de `phone` no autosave nunca dispararia. Como o useAutoSave
  // invoca sempre o closure mais recente, este snapshot está sempre atualizado.
  const { dirtyFields } = form.formState;

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

  // Monta o payload do autosave.
  //
  // `phone` é CONDICIONAL e só entra quando o campo foi realmente editado
  // (`dirty`). Motivo: no backend, o `phone` é o ÚNICO campo gravado com
  // `COALESCE($n, phone)` — omiti-lo significa "mantém o número atual" e PULA a
  // verificação de unicidade (`resolvePhoneToPersist`). Enviar o telefone a cada
  // autosave de quem nem tocou no campo disparava `409 PHONE_NOT_AVAILABLE`
  // (round-trip do próprio número em formato diferente do gravado + duplicatas
  // reais de telefone em prod faziam a unicidade bater contra outro registro).
  //
  // Todos os OUTROS campos continuam sempre presentes de propósito: no backend
  // eles são overwrite direto (não COALESCE), então omitir qualquer um gravaria
  // NULL por cima — o data-loss de "campo some" que essa tela já sofreu. O store
  // é a fonte única e já está hidratado, então reenviar os valores atuais é
  // idempotente e seguro.
  const buildSavePayload = (formData: GeneralInfoFormData, includePhone: boolean) => ({
    firstName: formData.fullName?.split(' ')[0] || formData.fullName || '',
    lastName: formData.lastName || '',
    sex: formData.sex as 'male' | 'female',
    gender: formData.gender as 'male' | 'female' | 'other',
    birthDate: formData.birthDate ? parseDateToISO(formData.birthDate) : undefined,
    documentType: 'CUIL_CUIT',
    documentNumber: formData.cpf || '',
    ...(includePhone ? { phone: formData.phone || '' } : {}),
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

  // 409 no telefone → tenta abrir o fluxo de vínculo self-service via LOOKUP
  // (contrato v2: SEM SMS — o OTP só dispara no clique em "vincular"). Lookup
  // só sucede quando a dona é conta REAL e ACCOUNT_LINK_ENABLED está ligada;
  // 404 (flag OFF), USE_CLAIM ou erro → fallback pro comportamento atual (toast).
  const tryOpenPhoneConflict = async (): Promise<boolean> => {
    const phoneEntered = getValues().phone || '';
    if (!phoneEntered) return false;
    try {
      const lookupData = await WorkerApiService.lookupAccountLink(phoneEntered);
      setPhoneConflict({ phoneEntered, lookupData });
      return true;
    } catch {
      return false;
    }
  };

  const triggerSave = useAutoSave(
    async () => {
      const values = getValues();
      // Só envia `phone` quando o campo foi editado de fato. Ver buildSavePayload.
      const phoneDirty = Boolean(dirtyFields.phone);
      const saved = await saveGeneralInfo(buildSavePayload(values, phoneDirty));

      // O 200 desta rota tem DOIS ramos (contrato: `WorkerGeneralInfoOk200`).
      // O degradado — `{ message, missingFields: null }` — significa "gravei,
      // mas não consegui reler": vem SEM nenhum campo de perfil.
      //
      // 🔒 Entregar esse objeto ao hidratador autoritativo APAGA o cadastro:
      // campo ausente vira vazio, o store (persistido em localStorage) fica
      // zerado e, ao remontar a aba, o autosave grava o cadastro VAZIO no banco
      // — com toast verde. Medido pelo gate em 08/09/2026, e é pior que o bug
      // que este arquivo conserta. Autoritativo só sobre um PERFIL de verdade.
      const confirmado = typeof (saved as { id?: unknown }).id === 'string';

      if (confirmado) {
        // Sincroniza o store com o que o SERVIDOR gravou — nunca com o payload
        // que acabamos de mandar. Era essa a origem do defeito de 08/09/2026: o
        // cliente afirmava o próprio envio, o telefone que o backend não
        // persistiu seguia na tela (e no localStorage), e a prestadora via o
        // número dela enquanto o sistema recusava a postulação por falta dele.
        hydrateFromServer(saved, { authoritative: true });
        // Rebaselina o dirty com o que o SERVIDOR gravou, não com o que mandamos.
        // `keepValues: true` NÃO altera valor nenhum — só move o baseline de
        // "sujo". Se o backend NÃO persistiu o telefone, o baseline fica vazio,
        // o campo continua sujo e o próximo autosave o reenvia. Era o laço que
        // travou 129 cadastros.
        form.reset({ ...values, phone: saved.phone ?? '' }, { keepValues: true });

        // ⚠️ `reset` LIMPA o dirty-tracking, qualquer que seja o baseline que se
        // passe — descobrir isso custou um teste que reprovou o próprio
        // conserto. Então, se mandamos um telefone e o servidor NÃO o devolveu,
        // ele não foi persistido: remarcamos o campo como sujo à mão, para o
        // próximo autosave reenviá-lo. Sem isto o número nunca mais é mandado,
        // que é exatamente o laço que travou 129 cadastros.
        if (values.phone && !saved.phone) {
          form.setValue('phone', values.phone, { shouldDirty: true });
        }
      }
      // Escrita NÃO confirmada: não mexe no store nem no baseline. O que está na
      // tela continua sendo o que a pessoa digitou, e segue "sujo" para ser
      // reenviado — nunca afirmamos um estado que o servidor não confirmou.

      // Modal de vínculo aberta → suprime o toast (não abafar o fluxo).
      if (!phoneConflictOpenRef.current) {
        showToast(
          confirmado
            ? t('profile.saveSuccess', 'Información guardada con éxito')
            : t('profile.saveUnconfirmed', 'Guardado, pero no pudimos confirmar. Revisá los datos.'),
          confirmado ? 'success' : 'error',
          'profile-save',
        );
      }
    },
    500,
    (error) => {
      if (phoneConflictOpenRef.current) return; // modal aberta → sem toasts
      if (error instanceof ApiError && error.code === 'PHONE_NOT_AVAILABLE') {
        // Caminho novo: oferecer o vínculo. Só cai no toast se o start falhar
        // (flag OFF/404, dono importado, erro de rede).
        void tryOpenPhoneConflict().then((opened) => {
          if (!opened && !phoneConflictOpenRef.current) {
            showToast(resolveSaveErrorMessage(error), 'error', 'profile-save');
          }
        });
        return;
      }
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
    <>
      <form onSubmit={(e) => e.preventDefault()} onBlur={triggerSave} className="flex flex-col gap-6 w-full">
        <GeneralInfoFormFields
          form={form}
          isFieldReadonly={isFieldReadonly}
          triggerSave={triggerSave}
          profilePhotoElement={profilePhotoElement}
          birthDateInvalid={birthDateInvalid}
        />
      </form>

      {phoneConflict && (
        <PhoneConflictModal
          open
          phoneEntered={phoneConflict.phoneEntered}
          lookupData={phoneConflict.lookupData}
          onClose={() => setPhoneConflict(null)}
          onLinked={() => {
            // Merge concluído: o telefone agora vive na conta logada e o status
            // pode ter mudado (REGISTERED). Re-hydrata do servidor — fonte única.
            void WorkerApiService.getProgress()
              .then((progress) => hydrateFromServer(progress))
              .catch(() => { /* resumo já informa o resultado; hydrate é best-effort */ });
          }}
        />
      )}
    </>
  );
});
