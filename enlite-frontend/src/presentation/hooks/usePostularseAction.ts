import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@presentation/hooks/useAuth';
import { WorkerApiService, WorkerProgressResponse, AvailabilitySlotResponse } from '@infrastructure/http/WorkerApiService';
import { DocumentApiService, WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';
import { ApiError } from '@infrastructure/http/ApiError';

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

function detectDocumentFields(data: WorkerDocumentsResponse | null): Record<string, boolean> {
  return {
    resumeCv: !!data?.resumeCvUrl,
    identityDocument: !!data?.identityDocumentUrl,
    criminalRecord: !!data?.criminalRecordUrl,
    professionalRegistration: !!data?.professionalRegistrationUrl,
    liabilityInsurance: !!data?.liabilityInsuranceUrl,
  };
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
      const [workerData, documentsData, availabilityData] = await Promise.all([
        WorkerApiService.getProgress(),
        DocumentApiService.getDocuments(),
        WorkerApiService.getAvailability(),
      ]);

      const registration = detectRegistrationFields(workerData, availabilityData);
      const documents = detectDocumentFields(documentsData);

      const allRegistrationComplete = Object.values(registration).every(Boolean);
      const allDocsComplete = Object.values(documents).every(Boolean);

      if (!allRegistrationComplete || !allDocsComplete) {
        setMissingFields({ registration, documents });
        setState('incomplete');
        return;
      }

      // Track acquisition channel — blocking. Se o backend bloquear (403 com
      // code='WORKER_NOT_ELIGIBLE'), reabre o modal com missing fields atualizados
      // ao invés de mandar pro WhatsApp. Cobre race-condition: o status do worker
      // pode ter mudado entre o client-side check acima e o submit ao backend.
      const channel = sessionStorage.getItem(SESSION_KEY_UTM);
      if (channel && jobPostingId) {
        try {
          await WorkerApiService.trackAcquisitionChannel(jobPostingId, channel);
          sessionStorage.removeItem(SESSION_KEY_UTM);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'WORKER_NOT_ELIGIBLE') {
            // Re-fetch progresso/docs/availability pra mostrar campos faltantes no modal
            const [workerData2, documentsData2, availabilityData2] = await Promise.all([
              WorkerApiService.getProgress(),
              DocumentApiService.getDocuments(),
              WorkerApiService.getAvailability(),
            ]);
            setMissingFields({
              registration: detectRegistrationFields(workerData2, availabilityData2),
              documents: detectDocumentFields(documentsData2),
            });
            setState('incomplete');
            return;
          }
          console.warn('[usePostularseAction] trackAcquisitionChannel failed:', err);
        }
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
