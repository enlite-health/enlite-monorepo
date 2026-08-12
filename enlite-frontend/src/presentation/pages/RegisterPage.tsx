import { useState, useCallback } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { FirebaseError } from 'firebase/app';
import { useRegisterUser } from '@presentation/hooks/useRegisterUser';
import { useWorkerEmailLookup } from '@presentation/hooks/useWorkerEmailLookup';
import { WorkerApiService, InitWorkerResponse } from '@infrastructure/http/WorkerApiService';
import { PhoneInputIntl } from '@presentation/components/shared/PhoneInputIntl';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField, InputWithIcon, PasswordInput } from '@presentation/components/molecules';
import { Button } from '@presentation/components/atoms/Button';
import { Checkbox, Divider } from '@presentation/components/atoms';
import { AuthNavbar } from '@presentation/components/organisms/AuthNavbar';
import { GoogleLoginButton } from '@presentation/components/features/auth/GoogleLoginButton';
import { ClaimOtpModal } from '@presentation/components/features/auth/ClaimOtpModal';
import { getAuthErrorMessage } from '@presentation/utils/authErrorMapper';

const registerSchema = z.object({
  email: z.string().min(1, 'login.emailRequired').email('register.invalidEmail'),
  password: z.string().min(6, 'register.passwordTooShort'),
  confirmPassword: z.string().min(1, 'login.passwordRequired'),
  whatsapp: z.string().optional(),
  lgpdOptIn: z.boolean().refine((v) => v === true, 'register.lgpdRequired'),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'register.passwordMismatch',
  path: ['confirmPassword'],
});

// ── ClaimPending state ─────────────────────────────────────────────────────

interface ClaimPendingState {
  candidateWorkerId: string;
  phoneMasked: string;
  verificationSid: string;
  authUid: string;
  email: string;
}

// ── Component ──────────────────────────────────────────────────────────────

export function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const returnUrl = (location.state as { returnUrl?: string } | null)?.returnUrl
    ?? sessionStorage.getItem('enlite_vacancy_return_url')
    ?? null;
  const { register, isLoading: isRegistering } = useRegisterUser();
  const { lookup, reset: resetLookup, isLoading: isLookingUp, found: workerFound, phoneMasked } = useWorkerEmailLookup();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [lgpdOptIn, setLgpdOptIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lgpdError, setLgpdError] = useState<string | null>(null);
  const [claimPending, setClaimPending] = useState<ClaimPendingState | null>(null);

  const phoneDisabled = workerFound === true && !!phoneMasked;

  const handleEmailBlur = useCallback(async () => {
    await lookup(email);
  }, [email, lookup]);

  const handleEmailChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    resetLookup();
    setWhatsapp('');
  }, [resetLookup]);

  /**
   * Centralised navigation after a successful worker init.
   * Extracted so both the email/password flow and OTP-confirmed flow can reuse it.
   */
  const navigateAfterInit = useCallback(() => {
    navigate(returnUrl ?? '/');
  }, [navigate, returnUrl]);

  /**
   * Handles the InitWorkerResponse discriminated union.
   * - 'ok' → navigate immediately
   * - 'claim_pending' → open OTP modal
   */
  const handleInitResponse = useCallback(
    (response: InitWorkerResponse, uid: string, userEmail: string) => {
      if (response.status === 'ok') {
        navigateAfterInit();
        return;
      }
      // claim_pending
      setClaimPending({
        candidateWorkerId: response.candidateWorkerId,
        phoneMasked: response.phoneMasked,
        verificationSid: response.verificationSid,
        authUid: uid,
        email: userEmail,
      });
    },
    [navigateAfterInit],
  );

  /**
   * Handles success for the email/password registration flow.
   * Receives the registered user explicitly so we never depend on stale React state.
   */
  const handleSuccess = async (registeredUser: { id: string; email: string }) => {
    try {
      const response = await WorkerApiService.initWorker({
        authUid: registeredUser.id,
        email: registeredUser.email,
        phone: whatsapp || undefined,
        whatsappPhone: whatsapp || undefined,
        lgpdOptIn,
        country: 'AR',
      });
      handleInitResponse(response, registeredUser.id, registeredUser.email);
    } catch (err) {
      console.error('[Register] Worker init failed:', err);
      // Non-blocking: worker init failing shouldn't prevent redirect
      navigateAfterInit();
    }
  };

  const handleError = (err: Error) => {
    // If Firebase says email already in use and worker existed → redirect to login
    if (err instanceof FirebaseError && err.code === 'auth/email-already-in-use' && workerFound) {
      navigate('/login', { state: { returnUrl, email } });
      return;
    }
    console.error('Registration failed:', err);
    const translatedError = getAuthErrorMessage(err, t);
    setError(translatedError);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLgpdError(null);

    const result = registerSchema.safeParse({ email, password, confirmPassword, whatsapp, lgpdOptIn });
    if (!result.success) {
      const lgpdIssue = result.error.errors.find((e) => e.path.includes('lgpdOptIn'));
      if (lgpdIssue) {
        setLgpdError(t(lgpdIssue.message));
      }
      const firstNonLgpd = result.error.errors.find((e) => !e.path.includes('lgpdOptIn'));
      if (firstNonLgpd) {
        setError(t(firstNonLgpd.message));
      }
      if (!firstNonLgpd && lgpdIssue) {
        return;
      }
      return;
    }

    try {
      const registeredUser = await register({
        email,
        password,
        whatsapp: whatsapp || undefined,
        lgpdOptIn,
      });
      await handleSuccess({ id: registeredUser.id, email: registeredUser.email });
    } catch (err) {
      handleError(err instanceof Error ? err : new Error('Registration failed'));
    }
  };

  /**
   * Google login success → navigate to /complete-whatsapp so the user can
   * provide their WhatsApp number for claim reconciliation.
   */
  const handleGoogleSuccess = () => {
    navigate('/complete-whatsapp');
  };

  return (
    <div className="min-h-screen bg-background flex flex-col px-4 sm:px-10 md:px-16 lg:px-20 xl:px-[120px] pt-8 pb-20 sm:pb-24 lg:pb-[138px] gap-8 sm:gap-10 lg:gap-12">
      <AuthNavbar
        className="px-4"
        actions={
          <Button
            variant="outline"
            size="md"
            onClick={() => navigate('/login')}
          >
            {t('register.loginButtonNav')}
          </Button>
        }
      />

      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center w-full max-w-[1200px] self-center flex-1 gap-8 md:gap-10 lg:gap-12">
        <div className="flex flex-col justify-center gap-5 w-full lg:w-[456px]">
          <div className="flex flex-col gap-2">
            <Heading level={1} weight="semibold" color="primary">
              {t('register.title')}
            </Heading>
            <Text size="sm" color="primary" className="max-w-[456px]">
              {t('register.description')}
            </Text>
          </div>

          <form className="flex flex-col gap-5 w-full" onSubmit={handleSubmit}>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
                <Text as="span" size="sm" color="inherit">{error}</Text>
              </div>
            )}
            <div className="flex flex-col gap-3 w-full">
              <FormField label={t('common.email')} htmlFor="email">
                <InputWithIcon
                  id="email"
                  type="email"
                  placeholder={t('common.emailPlaceholder')}
                  value={email}
                  onChange={handleEmailChange}
                  onBlur={handleEmailBlur}
                  icon={
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M17 21.25H7C3.35 21.25 1.25 19.15 1.25 15.5V8.5C1.25 4.85 3.35 2.75 7 2.75H17C20.65 2.75 22.75 4.85 22.75 8.5V15.5C22.75 19.15 20.65 21.25 17 21.25ZM7 4.25C4.14 4.25 2.75 5.64 2.75 8.5V15.5C2.75 18.36 4.14 19.75 7 19.75H17C19.86 19.75 21.25 18.36 21.25 15.5V8.5C21.25 5.64 19.86 4.25 17 4.25H7Z" fill="#180149"/>
                      <path d="M12.003 12.868C11.163 12.868 10.313 12.608 9.663 12.078L6.533 9.57802C6.213 9.31802 6.153 8.84802 6.413 8.52802C6.673 8.20802 7.143 8.14802 7.463 8.40802L10.593 10.908C11.353 11.518 12.643 11.518 13.403 10.908L16.533 8.40802C16.853 8.14802 17.333 8.19802 17.583 8.52802C17.843 8.84802 17.793 9.32802 17.463 9.57802L14.333 12.078C13.693 12.608 12.843 12.868 12.003 12.868Z" fill="#180149"/>
                    </svg>
                  }
                />
              </FormField>

              <FormField label={t('common.password')} htmlFor="password">
                <PasswordInput
                  id="password"
                  placeholder={t('common.passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </FormField>

              <FormField label={t('common.confirmPassword')} htmlFor="confirmPassword">
                <PasswordInput
                  id="confirmPassword"
                  placeholder={t('common.confirmPasswordPlaceholder')}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </FormField>

              <FormField
                label={t('register.whatsapp')}
                htmlFor="whatsapp"
                optional={!phoneDisabled}
              >
                {phoneDisabled ? (
                  <InputWithIcon
                    id="whatsapp"
                    type="text"
                    value={phoneMasked!}
                    disabled
                    readOnly
                    className="opacity-60 cursor-not-allowed"
                    icon={
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" fill="#180149"/>
                        <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.948-1.42A9.956 9.956 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a7.946 7.946 0 01-4.076-1.124l-.292-.174-3.037.872.855-3.126-.19-.31A7.96 7.96 0 014 12c0-4.418 3.582-8 8-8s8 3.582 8 8-3.582 8-8 8z" fill="#180149"/>
                      </svg>
                    }
                  />
                ) : (
                  <PhoneInputIntl
                    value={whatsapp}
                    onChange={setWhatsapp}
                    disabled={isLookingUp}
                    icon={
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" fill="#180149"/>
                        <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.948-1.42A9.956 9.956 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a7.946 7.946 0 01-4.076-1.124l-.292-.174-3.037.872.855-3.126-.19-.31A7.96 7.96 0 014 12c0-4.418 3.582-8 8-8s8 3.582 8 8-3.582 8-8 8z" fill="#180149"/>
                      </svg>
                    }
                  />
                )}
                {phoneDisabled && (
                  <Text as="span" size="xs" color="secondary" className="mt-1">
                    {t('register.phonePrefilledHint')}
                  </Text>
                )}
              </FormField>
            </div>

            <Checkbox
              id="lgpdOptIn"
              labelContent={
                <div className="flex flex-col gap-0.5">
                  <Text as="span" size="sm" weight="semibold" color="inherit">{t('register.lgpdOptIn')}</Text>
                  <Text as="span" size="sm" color="secondary">{t('register.lgpdSubtitle')}</Text>
                  <Text as="span" size="xs" color="secondary">
                    {t('register.lgpdBody')
                      .split('{termsLink}')
                      .flatMap((partBeforeTerms, i) => {
                        if (i > 0) return [partBeforeTerms];
                        return [
                          partBeforeTerms,
                          <a
                            key="terms"
                            href="https://enlite.health/es/politica-de-privacidad-enlite-health-solutions/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline text-primary"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {t('register.lgpdTermsLinkText')}
                          </a>,
                        ];
                      })
                      .flatMap((part, i) => {
                        if (typeof part !== 'string') return [part];
                        const segments = part.split('{emailLink}');
                        if (segments.length === 1) return [part];
                        return [
                          segments[0],
                          <a
                            key={`email-${i}`}
                            href="mailto:enlite@enlite.health"
                            className="underline text-primary"
                            onClick={(e) => e.stopPropagation()}
                          >
                            enlite@enlite.health
                          </a>,
                          segments[1],
                        ];
                      })}
                  </Text>
                </div>
              }
              checked={lgpdOptIn}
              onChange={(e) => {
                setLgpdOptIn(e.target.checked);
                if (e.target.checked) setLgpdError(null);
              }}
              error={lgpdError || undefined}
            />

            <Text size="sm" color="secondary" className="text-left">
              {t('register.hasAccount')}{' '}
              <Link to="/login" className="font-medium text-primary underline">
                {t('register.loginHere')}
              </Link>
            </Text>

            <div className="flex flex-col gap-3">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                isLoading={isRegistering}
              >
                {t('register.registerButton')}
              </Button>

              <Divider text={t('register.orRegisterWith')} />

              <GoogleLoginButton
                variant="register"
                onSuccess={handleGoogleSuccess}
              />
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

      {/* OTP claim modal — shown when initWorker returns claim_pending */}
      {claimPending && (
        <ClaimOtpModal
          open={true}
          phoneMasked={claimPending.phoneMasked}
          verificationSid={claimPending.verificationSid}
          candidateWorkerId={claimPending.candidateWorkerId}
          authUid={claimPending.authUid}
          email={claimPending.email}
          onConfirmed={() => navigateAfterInit()}
          onClose={() => setClaimPending(null)}
        />
      )}
    </div>
  );
}
