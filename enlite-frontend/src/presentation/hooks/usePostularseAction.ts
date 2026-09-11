import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@presentation/hooks/useAuth';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
import { ApiError } from '@infrastructure/http/ApiError';

const SESSION_KEY_UTM = 'enlite_utm_source';
const SESSION_KEY_RETURN_URL = 'enlite_vacancy_return_url';

type PostularseState =
  | 'idle'
  | 'loading'
  | 'unauthenticated'
  | 'incomplete'
  | 'ready'
  | 'not_available'
  | 'error';

/**
 * Missing fields as a plain string[] of snake_case tokens returned by the
 * backend 403 WORKER_NOT_ELIGIBLE response. The backend is the sole source of
 * truth — no client-side recalculation.
 */
export type MissingFields = string[];

export interface UsePostularseActionResult {
  state: PostularseState;
  missingFields: MissingFields | null;
  postularse: () => Promise<void>;
  dismissModal: () => void;
  confirmRegister: () => void;
}

export function usePostularseAction(
  whatsappUrl: string | null,
  jobPostingId: string | null = null,
  /**
   * Overrides the sessionStorage-UTM channel read below with a caller-fixed
   * value (e.g. 'site' for the home — it's not a UTM click-through, so there
   * is no UTM to read). Undefined (default, every existing caller) preserves
   * /vacantes/:id's exact behavior — regression-tested.
   */
  fixedChannel?: string,
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

    if (!jobPostingId) {
      // No jobPostingId → backend cannot be consulted; conservative path.
      setState('not_available');
      return;
    }

    setState('loading');

    try {
      const channel = fixedChannel ?? sessionStorage.getItem(SESSION_KEY_UTM);
      try {
        await WorkerApiService.trackAcquisitionChannel(jobPostingId, channel);
        // Backend confirmed eligibility — ONLY here do we open WhatsApp.
        sessionStorage.removeItem(SESSION_KEY_UTM);
        window.open(whatsappUrl, '_blank');
        setState('idle');
        return;
      } catch (trackErr) {
        // FAIL-CLOSED (ClickUp 86ajfkwf7): the pre-screening WhatsApp must never
        // open unless the backend explicitly confirmed the worker is eligible.
        // We never fall back to opening WhatsApp on error. UTM is preserved so a
        // retry after completing registration keeps the acquisition attribution.
        if (trackErr instanceof ApiError && trackErr.code === 'WORKER_NOT_ELIGIBLE') {
          // Backend is the sole source of truth — use missingFields from the 403.
          setMissingFields(trackErr.missingFields ?? []);
          setState('incomplete');
          return;
        }
        // Any other outcome (404 not found, 401, 500, network) → block, do NOT
        // open WhatsApp. The worker is not verified as eligible.
        setMissingFields(null);
        setState('error');
      }
    } catch {
      setMissingFields(null);
      setState('error');
    }
  }, [whatsappUrl, isAuthenticated, jobPostingId, fixedChannel]);

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
