import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import type { WorkerInitOutcome } from '@presentation/utils/workerInitOutcome';
import { ClaimOtpModal } from '@presentation/components/features/auth/ClaimOtpModal';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

const authService = new FirebaseAuthService();

export interface WorkerInitOutcomePanelProps {
  outcome: Exclude<WorkerInitOutcome, { kind: 'ok' }>;
  authUid: string;
  email: string;
  /** A caixa do aceite foi marcada (só o cadastro); repassada ao confirm do claim. */
  lgpdOptIn?: boolean;
  /** O código do claim foi confirmado: a ficha é do login. */
  onResolved: (worker: WorkerProgressResponse) => void;
  /** Chamar o init de novo (e-mail verificado, ou passou a espera do 429). */
  onRetry: () => void;
  /** Fechou o modal do código sem confirmar. */
  onCancel: () => void;
}

/**
 * A resposta do init que não é `ok`, tratada num lugar só (DP-20): o mesmo `ClaimOtpModal` do
 * cadastro, "Revisá tu correo" e a espera do 429. Usado pelo 1º login, pelo cadastro e pelo perfil.
 */
export function WorkerInitOutcomePanel({ outcome, authUid, email, lgpdOptIn, onResolved, onRetry, onCancel }: WorkerInitOutcomePanelProps): JSX.Element {
  if (outcome.kind === 'claim_pending') {
    return (
      <ClaimOtpModal
        open
        phoneMasked={outcome.phoneMasked}
        verificationSid={outcome.verificationSid}
        authUid={authUid}
        email={email}
        lgpdOptIn={lgpdOptIn}
        onConfirmed={onResolved}
        onClose={onCancel}
      />
    );
  }
  if (outcome.kind === 'email_not_verified') return <EmailNotVerified email={email} onVerified={onRetry} />;
  return <RateLimited onRetry={onRetry} />;
}

type EmailStatus = 'idle' | 'sending' | 'sent' | 'sendError' | 'checking' | 'stillNotVerified';

function EmailNotVerified({ email, onVerified }: { email: string; onVerified: () => void }): JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<EmailStatus>('idle');

  const resend = async (): Promise<void> => {
    setStatus('sending');
    try {
      await authService.resendEmailVerification();
      setStatus('sent');
    } catch {
      setStatus('sendError');
    }
  };

  const check = async (): Promise<void> => {
    setStatus('checking');
    const verified = await authService.reloadAndRefreshToken().catch(() => false);
    if (verified) onVerified();
    else setStatus('stillNotVerified');
  };

  const feedback: Partial<Record<EmailStatus, string>> = {
    sent: t('claim.emailNotVerified.resent'),
    sendError: t('claim.emailNotVerified.resendError'),
    stillNotVerified: t('claim.emailNotVerified.stillNotVerified'),
  };

  return (
    <section data-testid="email-not-verified" className="max-w-[440px] mx-auto flex flex-col gap-4 p-6">
      <Heading level={2} weight="semibold" color="primary">{t('claim.emailNotVerified.title')}</Heading>
      <Text size="sm" color="secondary">{t('claim.emailNotVerified.body', { email })}</Text>
      {feedback[status] && <Text size="sm" role="status" data-testid="email-not-verified-feedback">{feedback[status]}</Text>}
      <Button type="button" variant="primary" size="lg" fullWidth isLoading={status === 'checking'} disabled={status === 'checking'} onClick={() => void check()}>
        {t('claim.emailNotVerified.checkButton')}
      </Button>
      <Button type="button" variant="ghost" size="md" fullWidth isLoading={status === 'sending'} disabled={status === 'sending'} onClick={() => void resend()}>
        {t('claim.emailNotVerified.resendButton')}
      </Button>
    </section>
  );
}

function RateLimited({ onRetry }: { onRetry: () => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <section data-testid="init-rate-limited" className="max-w-[440px] mx-auto flex flex-col gap-4 p-6">
      <Heading level={2} weight="semibold" color="primary">{t('claim.rateLimited.title')}</Heading>
      <Text size="sm" color="secondary">{t('claim.rateLimited.body')}</Text>
      <Button type="button" variant="primary" size="lg" fullWidth onClick={onRetry}>
        {t('claim.rateLimited.retryButton')}
      </Button>
    </section>
  );
}
