import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import { ClaimErrorCode } from '@infrastructure/http/AuthClaimApiService';
import { useClaimConfirm } from '@presentation/hooks/useClaimConfirm';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { Button } from '@presentation/components/atoms/Button';

// ── Props ──────────────────────────────────────────────────────────────────

export interface ClaimOtpModalProps {
  open: boolean;
  phoneMasked: string;
  verificationSid: string;
  candidateWorkerId: string;
  authUid: string;
  email: string;
  onConfirmed: (worker: WorkerProgressResponse) => void;
  onClose: () => void;
}

// ── Error message map ──────────────────────────────────────────────────────

const ERROR_KEY_MAP: Record<ClaimErrorCode, string> = {
  INVALID_OTP: 'claim.otpModal.errorInvalid',
  EXPIRED_OTP: 'claim.otpModal.errorExpired',
  CANDIDATE_NOT_FOUND: 'claim.otpModal.errorNotFound',
  NOT_IMPORTABLE: 'claim.otpModal.errorNotFound',
};

// ── Component ──────────────────────────────────────────────────────────────

/**
 * Modal shown when POST /api/workers/init or POST /api/auth/claim/start
 * returns status 'claim_pending'. The user must confirm WhatsApp ownership
 * via a 6-digit OTP before the candidate worker record is merged.
 *
 * Onda 2 design decision: no "skip" — forces the user to confirm or cancel
 * (go back to the register form). This avoids backend complexity of forceCreate.
 */
export function ClaimOtpModal({
  open,
  phoneMasked,
  verificationSid,
  candidateWorkerId,
  authUid,
  email,
  onConfirmed,
  onClose,
}: ClaimOtpModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const [otp, setOtp] = useState('');

  const { isLoading, errorCode, confirm, clearError } = useClaimConfirm(
    verificationSid,
    candidateWorkerId,
    authUid,
    email,
  );

  if (!open) return null;

  const handleOtpChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
    setOtp(digits);
    if (errorCode) clearError();
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (otp.length < 6 || isLoading) return;

    const worker = await confirm(otp);
    if (worker) {
      onConfirmed(worker);
    }
  };

  const errorMessage = errorCode ? t(ERROR_KEY_MAP[errorCode]) : null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-otp-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-[440px] p-6 sm:p-8 flex flex-col gap-6">
          {/* Header */}
          <div className="flex flex-col gap-2">
            <Heading level={2} weight="semibold" color="primary" id="claim-otp-title">
              {t('claim.otpModal.title')}
            </Heading>
            <Text size="sm" color="secondary">
              {t('claim.otpModal.subtitle', { phoneMasked })}
            </Text>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="otp-input">
                {t('claim.otpModal.inputLabel')}
              </Label>

              <input
                id="otp-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otp}
                onChange={handleOtpChange}
                maxLength={6}
                placeholder="000000"
                disabled={isLoading}
                className={[
                  'w-full h-14 px-4 rounded-xl border-[1.5px] outline-none',
                  'font-lexend text-base tracking-[0.3em] text-center text-primary',
                  'transition-colors duration-150',
                  errorCode
                    ? 'border-red-400 bg-red-50 focus:border-red-500'
                    : 'border-gray-300 focus:border-primary',
                  isLoading ? 'opacity-60 cursor-not-allowed' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-testid="otp-input"
              />

              {errorMessage && (
                <Text as="span" size="sm" color="inherit" className="text-red-600">
                  {errorMessage}
                </Text>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-3">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                isLoading={isLoading}
                disabled={otp.length < 6 || isLoading}
              >
                {t('claim.otpModal.confirmButton')}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="md"
                fullWidth
                onClick={onClose}
                disabled={isLoading}
              >
                {t('claim.otpModal.cancelButton')}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
