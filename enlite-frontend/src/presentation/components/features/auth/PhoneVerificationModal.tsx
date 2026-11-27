import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { PhoneInputIntl } from '@presentation/components/shared/PhoneInputIntl';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { Button } from '@presentation/components/atoms/Button';

// ── Props ──────────────────────────────────────────────────────────────────

export interface PhoneVerificationModalProps {
  open: boolean;
  /**
   * `verify`: confirma o número que a ficha já tem (campo só leitura).
   * `change`: pede o número NOVO; o código vai para ele (emenda 077 §6).
   */
  mode: 'verify' | 'change';
  /** Número atual da ficha (modo `verify`). */
  currentPhone?: string;
  /** Código `VERIFIED` do servidor: quem chama relê o perfil (`GET /api/workers/me`) e mostra o selo. */
  onVerified: () => void;
  /** `PHONE_IN_USE`: o número é de uma conta real; quem chama abre o unir contas. */
  onPhoneInUse: (phone: string) => void;
  onClose: () => void;
}

type Step = 'phone' | 'code';

// ── Código estável do servidor → chave i18n (nunca a mensagem crua) ─────────

const ERROR_KEY_MAP: Record<string, string> = {
  INVALID_PHONE: 'phoneVerification.modal.errorInvalidPhone',
  INVALID_OTP: 'phoneVerification.modal.errorInvalidOtp',
  EXPIRED_OTP: 'phoneVerification.modal.errorExpired',
  OTP_ALREADY_USED: 'phoneVerification.modal.errorUsed',
  RATE_LIMITED: 'phoneVerification.modal.errorRateLimited',
  OTP_CHANNEL_UNAVAILABLE: 'phoneVerification.modal.errorChannel',
  PHONE_COUNTRY_NOT_SUPPORTED: 'phoneVerification.modal.errorCountryNotSupported',
};

const GENERIC_ERROR_KEY = 'phoneVerification.modal.errorGeneric';

/** O link vem pronto do servidor; o cliente só o abre se for http(s). */
function isHttpUrl(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url);
}

// ── Component ──────────────────────────────────────────────────────────────

/**
 * Modal do código do celular (web). Mesmo visual do `ClaimOtpModal`; chama
 * `phone-verification/start` e `/confirm` (emenda 077 §2.4). O telefone nunca vai
 * para log e o `handoffUrl` do conflito é o que o servidor devolveu, sem montar URL aqui.
 */
export function PhoneVerificationModal({
  open,
  mode,
  currentPhone,
  onVerified,
  onPhoneInUse,
  onClose,
}: PhoneVerificationModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState(mode === 'verify' ? currentPhone ?? '' : '');
  const [challengeId, setChallengeId] = useState('');
  const [phoneMasked, setPhoneMasked] = useState('');
  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [conflict, setConflict] = useState<{ handoffUrl: string | null } | null>(null);

  if (!open) return null;

  const failWith = (error: unknown): void => {
    const apiCode = error instanceof ApiError ? error.code : undefined;
    if (apiCode === 'PHONE_IN_USE') {
      onPhoneInUse(phone);
      return;
    }
    if (apiCode === 'CLAIM_CONFLICT') {
      setConflict({ handoffUrl: error instanceof ApiError ? error.handoffUrl ?? null : null });
      return;
    }
    setExpired(apiCode === 'EXPIRED_OTP');
    setErrorKey((apiCode && ERROR_KEY_MAP[apiCode]) || GENERIC_ERROR_KEY);
  };

  const handleSend = async (): Promise<void> => {
    if (!phone || isLoading) return;
    setIsLoading(true);
    setErrorKey(null);
    setExpired(false);
    try {
      const started = await WorkerApiService.startPhoneVerification(phone);
      if (started.status === 'ALREADY_VERIFIED') {
        onVerified();
        return;
      }
      setChallengeId(started.challengeId);
      setPhoneMasked(started.phoneMasked);
      setCode('');
      setStep('code');
    } catch (error) {
      failWith(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (code.length < 6 || isLoading) return;
    setIsLoading(true);
    setErrorKey(null);
    try {
      await WorkerApiService.confirmPhoneVerification({ phone, challengeId, code });
      onVerified();
    } catch (error) {
      setCode('');
      failWith(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
    if (errorKey) setErrorKey(null);
  };

  const errorMessage = errorKey ? t(errorKey) : null;
  const title = t(mode === 'verify' ? 'phoneVerification.modal.titleVerify' : 'phoneVerification.modal.titleChange');

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" aria-hidden="true" onClick={onClose} />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="phone-verification-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-[440px] p-6 sm:p-8 flex flex-col gap-6">
          {conflict ? (
            <div className="flex flex-col gap-4" data-testid="phone-verification-conflict">
              <Heading level={2} weight="semibold" color="primary" id="phone-verification-title">
                {t('phoneVerification.modal.conflictTitle')}
              </Heading>
              <Text size="sm" color="secondary">
                {t('phoneVerification.modal.conflictBody')}
              </Text>
              {isHttpUrl(conflict.handoffUrl) && (
                <a
                  href={conflict.handoffUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="phone-verification-team-link"
                  className="inline-flex h-12 items-center justify-center rounded-pill bg-primary px-6 font-lexend text-sm font-medium text-white hover:bg-primary/90"
                >
                  {t('phoneVerification.modal.teamButton')}
                </a>
              )}
              <Button type="button" variant="ghost" size="md" fullWidth onClick={onClose}>
                {t('phoneVerification.modal.cancelButton')}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Heading level={2} weight="semibold" color="primary" id="phone-verification-title">
                  {title}
                </Heading>
                <Text size="sm" color="secondary">
                  {step === 'code'
                    ? t('phoneVerification.modal.codeSubtitle', { phoneMasked })
                    : t('phoneVerification.modal.phoneHint')}
                </Text>
              </div>

              {step === 'phone' ? (
                <div className="flex flex-col gap-5">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="phone-verification-phone">{t('phoneVerification.modal.phoneLabel')}</Label>
                    {mode === 'verify' ? (
                      <Text size="base" weight="medium" color="primary" data-testid="phone-verification-phone">
                        {phone}
                      </Text>
                    ) : (
                      <PhoneInputIntl
                        inputSize="compact"
                        value={phone}
                        onChange={setPhone}
                        placeholder={t('workerRegistration.generalInfo.phonePlaceholder')}
                        className="border-gray-600 focus-within:border-primary"
                      />
                    )}
                    {errorMessage && (
                      <Text as="span" size="sm" color="inherit" className="text-red-600" data-testid="phone-verification-error">
                        {errorMessage}
                      </Text>
                    )}
                  </div>
                  <div className="flex flex-col gap-3">
                    <Button
                      type="button"
                      variant="primary"
                      size="lg"
                      fullWidth
                      isLoading={isLoading}
                      disabled={!phone || isLoading}
                      onClick={handleSend}
                      data-testid="phone-verification-send"
                    >
                      {t('phoneVerification.modal.sendButton')}
                    </Button>
                    <Button type="button" variant="ghost" size="md" fullWidth onClick={onClose} disabled={isLoading}>
                      {t('phoneVerification.modal.cancelButton')}
                    </Button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleConfirm} className="flex flex-col gap-5">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="phone-verification-code">{t('phoneVerification.modal.codeLabel')}</Label>
                    <input
                      id="phone-verification-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={handleCodeChange}
                      maxLength={6}
                      placeholder="000000"
                      disabled={isLoading}
                      className={[
                        'w-full h-14 px-4 rounded-xl border-[1.5px] outline-none',
                        'font-lexend text-base tracking-[0.3em] text-center text-primary',
                        'transition-colors duration-150',
                        errorKey ? 'border-red-400 bg-red-50 focus:border-red-500' : 'border-gray-300 focus:border-primary',
                        isLoading ? 'opacity-60 cursor-not-allowed' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      data-testid="phone-verification-code"
                    />
                    {errorMessage && (
                      <Text as="span" size="sm" color="inherit" className="text-red-600" data-testid="phone-verification-error">
                        {errorMessage}
                      </Text>
                    )}
                  </div>
                  <div className="flex flex-col gap-3">
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      fullWidth
                      isLoading={isLoading}
                      disabled={code.length < 6 || isLoading}
                      data-testid="phone-verification-confirm"
                    >
                      {t('phoneVerification.modal.confirmButton')}
                    </Button>
                    {expired && (
                      <Button
                        type="button"
                        variant="outline"
                        size="md"
                        fullWidth
                        onClick={handleSend}
                        disabled={isLoading}
                        data-testid="phone-verification-resend"
                      >
                        {t('phoneVerification.modal.resendButton')}
                      </Button>
                    )}
                    <Button type="button" variant="ghost" size="md" fullWidth onClick={onClose} disabled={isLoading}>
                      {t('phoneVerification.modal.cancelButton')}
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
