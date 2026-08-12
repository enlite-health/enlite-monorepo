import { useState, useCallback } from 'react';
import {
  AuthClaimApiService,
  ClaimErrorCode,
  ConfirmClaimInput,
} from '@infrastructure/http/AuthClaimApiService';
import { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';

interface UseClaimConfirmState {
  isLoading: boolean;
  errorCode: ClaimErrorCode | null;
}

interface UseClaimConfirmReturn extends UseClaimConfirmState {
  /** Submit the OTP for confirmation. Returns the worker on success, null on error. */
  confirm: (otp: string) => Promise<WorkerProgressResponse | null>;
  /** Reset error state. */
  clearError: () => void;
}

/**
 * Encapsulates the POST /api/auth/claim/confirm call.
 * Bound to a specific (verificationSid, candidateWorkerId, authUid, email) tuple
 * so the modal doesn't need to pass them on every submit.
 */
export function useClaimConfirm(
  verificationSid: string,
  candidateWorkerId: string,
  authUid: string,
  email: string,
): UseClaimConfirmReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<ClaimErrorCode | null>(null);

  const clearError = useCallback(() => setErrorCode(null), []);

  const confirm = useCallback(
    async (otp: string): Promise<WorkerProgressResponse | null> => {
      setIsLoading(true);
      setErrorCode(null);

      const input: ConfirmClaimInput = {
        verificationSid,
        otp: otp.trim(),
        authUid,
        email,
        candidateWorkerId,
      };

      try {
        const response = await AuthClaimApiService.confirmClaim(input);

        if (!response.success) {
          setErrorCode(response.error);
          return null;
        }

        return response.worker;
      } catch {
        setErrorCode('CANDIDATE_NOT_FOUND');
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [verificationSid, candidateWorkerId, authUid, email],
  );

  return { isLoading, errorCode, confirm, clearError };
}
