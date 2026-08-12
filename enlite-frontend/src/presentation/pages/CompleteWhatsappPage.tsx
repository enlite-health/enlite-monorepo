import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@presentation/hooks/useAuth';
import { AuthClaimApiService, StartClaimResponse } from '@infrastructure/http/AuthClaimApiService';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { AuthNavbar } from '@presentation/components/organisms/AuthNavbar';
import { PhoneInputIntl } from '@presentation/components/shared/PhoneInputIntl';
import { ClaimOtpModal } from '@presentation/components/features/auth/ClaimOtpModal';

// ── Claim pending state ────────────────────────────────────────────────────

interface ClaimPendingState {
  candidateWorkerId: string;
  phoneMasked: string;
  verificationSid: string;
}

// ── Component ──────────────────────────────────────────────────────────────

/**
 * Shown after Google login (Onda 2).
 * Collects the WhatsApp number so it can be sent to POST /api/auth/claim/start.
 * If a candidate worker matches the phone, opens ClaimOtpModal.
 * If no candidate (noCandidate: true), navigates to /.
 */
export function CompleteWhatsappPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();

  const [phone, setPhone] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimPending, setClaimPending] = useState<ClaimPendingState | null>(null);

  // Guard: if not authenticated, redirect to /login
  if (!isAuthenticated) {
    navigate('/login');
    return <></>;
  }

  const handleContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone || !user) return;

    setIsLoading(true);
    setError(null);

    try {
      const response: StartClaimResponse = await AuthClaimApiService.startClaim({
        authUid: user.id,
        email: user.email,
        phone,
      });

      if ('noCandidate' in response && response.noCandidate) {
        // No pre-existing ficha — proceed to home (worker was already created on Google login)
        navigate('/');
        return;
      }

      // Candidate found — show OTP modal
      const claimResponse = response as Exclude<StartClaimResponse, { noCandidate: true }>;
      setClaimPending({
        candidateWorkerId: claimResponse.candidateWorkerId,
        phoneMasked: claimResponse.phoneMasked,
        verificationSid: claimResponse.verificationSid,
      });
    } catch (err) {
      console.error('[CompleteWhatsapp] startClaim failed:', err);
      setError(t('completeWhatsapp.startError'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSkip = () => {
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-background flex flex-col px-4 sm:px-10 md:px-16 lg:px-20 xl:px-[120px] pt-8 pb-20 sm:pb-24 lg:pb-[138px] gap-8 sm:gap-10 lg:gap-12">
      <AuthNavbar className="px-4" />

      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center w-full max-w-[1200px] self-center flex-1 gap-8 md:gap-10 lg:gap-12">
        <div className="flex flex-col justify-center gap-6 w-full lg:w-[456px]">
          <div className="flex flex-col gap-2">
            <Heading level={1} weight="semibold" color="primary">
              {t('completeWhatsapp.title')}
            </Heading>
            <Text size="sm" color="secondary" className="max-w-[456px]">
              {t('completeWhatsapp.subtitle')}
            </Text>
          </div>

          <form onSubmit={handleContinue} className="flex flex-col gap-5 w-full">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
                <Text as="span" size="sm" color="inherit">{error}</Text>
              </div>
            )}

            <PhoneInputIntl
              value={phone}
              onChange={setPhone}
              disabled={isLoading}
            />

            <div className="flex flex-col gap-3">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                isLoading={isLoading}
                disabled={!phone || isLoading}
              >
                {t('completeWhatsapp.continueButton')}
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="md"
                fullWidth
                onClick={handleSkip}
                disabled={isLoading}
              >
                {t('completeWhatsapp.skipButton')}
              </Button>
            </div>
          </form>
        </div>

        <div className="hidden lg:flex shrink-0 w-[400px] xl:w-[700px] h-[400px] xl:h-[760px] overflow-hidden rounded-[16px]">
          <img
            src="https://api.builder.io/api/v1/image/assets/TEMP/204e5b41cf4b024bf575ab2f43cda6fd3787b71f?width=1400"
            alt="Enlite care moments"
            className="w-full h-full object-cover"
          />
        </div>
      </div>

      {/* OTP claim modal — shown when startClaim returns a candidate match */}
      {claimPending && user && (
        <ClaimOtpModal
          open={true}
          phoneMasked={claimPending.phoneMasked}
          verificationSid={claimPending.verificationSid}
          candidateWorkerId={claimPending.candidateWorkerId}
          authUid={user.id}
          email={user.email}
          onConfirmed={() => navigate('/')}
          onClose={() => setClaimPending(null)}
        />
      )}
    </div>
  );
}
