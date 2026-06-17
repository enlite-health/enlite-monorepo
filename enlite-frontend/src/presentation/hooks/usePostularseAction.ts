import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@presentation/hooks/useAuth';
import { WorkerApiService, WorkerProgressResponse, AvailabilitySlotResponse } from '@infrastructure/http/WorkerApiService';
import { DocumentApiService, WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { getRequiredDocFields } from '@presentation/utils/workerDocumentRequirements';

const SESSION_KEY_UTM = 'enlite_utm_source';
const SESSION_KEY_RETURN_URL = 'enlite_vacancy_return_url';

type PostularseState = 'idle' | 'loading' | 'unauthenticated' | 'incomplete' | 'ready' | 'not_available';

/** Each key maps to a i18n label; value = true means completed */
export interface MissingFields {
  registration: Record<string, boolean>;
  documents: Record<string, boolean>;
}

export interface UsePostularseActionResult {
  state: PostularseState;
  missingFields: MissingFields | null;
  postularse: () => Promise<void>;
  dismissModal: () => void;
  confirmRegister: () => void;
}

function detectRegistrationFields(
  data: WorkerProgressResponse,
  availabilitySlots: AvailabilitySlotResponse[],
): Record<string, boolean> {
  return {
    firstName: !!data.firstName,
    lastName: !!data.lastName,
    birthDate: !!data.birthDate,
    sex: !!data.sex,
    gender: !!data.gender,
    documentType: !!data.documentType,
    documentNumber: !!data.documentNumber,
    languages: !!(data.languages && data.languages.length > 0),
    profession: !!data.profession,
    knowledgeLevel: !!data.knowledgeLevel,
    experienceTypes: !!(data.experienceTypes && data.experienceTypes.length > 0),
    yearsExperience: !!data.yearsExperience,
    preferredTypes: !!(data.preferredTypes && data.preferredTypes.length > 0),
    preferredAgeRange: !!(data.preferredAgeRange && data.preferredAgeRange.length > 0),
    serviceAddress: !!data.serviceAddress,
    serviceRadiusKm: !!data.serviceRadiusKm,
    availability: availabilitySlots.length > 0,
  };
}

/**
 * Detecta quais documentos obrigatórios estão presentes, de acordo com a profissão.
 * Usa getRequiredDocFields (workerDocumentRequirements) como fonte única da política.
 */
function detectDocumentFields(
  data: WorkerDocumentsResponse | null,
  profession?: string | null,
): Record<string, boolean> {
  const requiredFields = getRequiredDocFields(profession);
  const result: Record<string, boolean> = {};
  for (const field of requiredFields) {
    // Converte camelCase (ex: resumeCvUrl) → chave sem "Url" no sufixo (ex: resumeCv)
    const key = (field as string).replace(/Url$/, '');
    result[key] = !!data?.[field];
  }
  return result;
}

async function fetchWorkerSnapshot(): Promise<{
  workerData: WorkerProgressResponse;
  documentsData: WorkerDocumentsResponse | null;
  availabilityData: AvailabilitySlotResponse[];
}> {
  const [workerData, documentsData, availabilityData] = await Promise.all([
    WorkerApiService.getProgress(),
    DocumentApiService.getDocuments(),
    WorkerApiService.getAvailability(),
  ]);
  return { workerData, documentsData, availabilityData };
}

export function usePostularseAction(
  whatsappUrl: string | null,
  jobPostingId: string | null = null,
): UsePostularseActionResult {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<PostularseState>('idle');
  const [missingFields, setMissingFields] = useState<MissingFields | null>(null);

  const postularse = useCallback(async () => {
    if (!whatsappUrl) {
      setState('not_available');
      return;
    }

    if (!isAuthenticated) {
      setState('unauthenticated');
      return;
    }

    setState('loading');

    try {
      const { workerData, documentsData, availabilityData } = await fetchWorkerSnapshot();

      const registration = detectRegistrationFields(workerData, availabilityData);
      const documents = detectDocumentFields(documentsData, workerData.profession);
      const allRegistrationComplete = Object.values(registration).every(Boolean);
      const allDocsComplete = Object.values(documents).every(Boolean);

      if (jobPostingId) {
        // Sempre registra a tentativa no backend quando há jobPostingId.
        // O backend é a fonte de verdade sobre elegibilidade (grava
        // worker_blocked_applications + incrementa attempt_count).
        // channel é opcional: direto/bookmark não tem UTM.
        const channel = sessionStorage.getItem(SESSION_KEY_UTM);
        try {
          await WorkerApiService.trackAcquisitionChannel(jobPostingId, channel);
          // Backend confirmou elegibilidade — limpa UTM e abre WhatsApp.
          sessionStorage.removeItem(SESSION_KEY_UTM);
          window.open(whatsappUrl, '_blank');
          setState('idle');
          return;
        } catch (trackErr) {
          if (trackErr instanceof ApiError && trackErr.code === 'WORKER_NOT_ELIGIBLE') {
            // Backend rejeitou: re-fetch para dados frescos e exibe modal.
            const { workerData: wd2, documentsData: dd2, availabilityData: ad2 } =
              await fetchWorkerSnapshot();
            setMissingFields({
              registration: detectRegistrationFields(wd2, ad2),
              documents: detectDocumentFields(dd2, wd2.profession),
            });
            setState('incomplete');
            return;
          }
          // Falha de rede ou erro inesperado: instrumentação best-effort.
          // Não interrompe o fluxo — cai no fallback client-side abaixo.
        }
      }

      // Fallback client-side: usado quando não há jobPostingId, ou quando
      // o track falhou por motivo que não é WORKER_NOT_ELIGIBLE (rede etc.).
      if (!allRegistrationComplete || !allDocsComplete) {
        setMissingFields({ registration, documents });
        setState('incomplete');
        return;
      }

      window.open(whatsappUrl, '_blank');
      setState('idle');
    } catch {
      setMissingFields(null);
      setState('incomplete');
    }
  }, [whatsappUrl, isAuthenticated, jobPostingId]);

  const dismissModal = useCallback(() => {
    setState('idle');
    setMissingFields(null);
  }, []);

  const confirmRegister = useCallback(() => {
    const returnUrl = sessionStorage.getItem(SESSION_KEY_RETURN_URL);
    navigate('/register', { state: { returnUrl } });
  }, [navigate]);

  return { state, missingFields, postularse, dismissModal, confirmRegister };
}
