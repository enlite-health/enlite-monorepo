import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useAuth } from '@presentation/hooks/useAuth';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { FormField, InputWithIcon } from '@presentation/components/molecules';
import { AuthNavbar } from '@presentation/components/organisms/AuthNavbar';

const emailSchema = z.string().email();

/**
 * Códigos que NÃO revelam se o e-mail existe: a resposta é a mesma do sucesso. `missing-email` só chega
 * aqui com e-mail já validado no formulário, então também é caso "sem conta" para quem vê a tela.
 */
const NEUTRAL_CODES = new Set(['auth/user-not-found', 'auth/missing-email']);

type Outcome = { kind: 'sent' } | { kind: 'error'; messageKey: string };

function outcomeOf(err: unknown): Outcome {
  const code = (err as { code?: string } | null)?.code;
  if (code && NEUTRAL_CODES.has(code)) return { kind: 'sent' };
  if (code === 'auth/invalid-email') return { kind: 'error', messageKey: 'auth.forgot.invalidEmail' };
  if (code === 'auth/too-many-requests') return { kind: 'error', messageKey: 'auth.forgot.tooManyRequests' };
  return { kind: 'error', messageKey: 'auth.forgot.genericError' };
}

export function ForgotPasswordPage(): JSX.Element {
  const { t } = useTranslation();
  const { sendPasswordReset } = useAuth();
  // O e-mail do login chega por `state` do router (nunca por query string: seria PII na URL).
  const location = useLocation();
  const initialEmail = (location.state as { email?: string } | null)?.email ?? '';
  const [email, setEmail] = useState(initialEmail);
  const [isLoading, setIsLoading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOutcome(null);

    const address = email.trim();
    if (!emailSchema.safeParse(address).success) {
      setOutcome({ kind: 'error', messageKey: 'auth.forgot.invalidEmail' });
      return;
    }

    setIsLoading(true);
    try {
      await sendPasswordReset(address);
      setOutcome({ kind: 'sent' });
    } catch (err) {
      const result = outcomeOf(err);
      // Só o código: o e-mail (PII) nunca vai para o log.
      if (result.kind === 'error') {
        console.error('Password reset failed:', (err as { code?: string } | null)?.code ?? 'unknown');
      }
      setOutcome(result);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col px-4 sm:px-10 md:px-16 lg:px-20 xl:px-[120px] pt-8 pb-20 gap-8 sm:gap-10 lg:gap-12">
      <AuthNavbar className="px-4" />

      <div className="flex flex-col justify-center flex-1 w-full max-w-[440px] mx-auto gap-5">
        <div className="flex flex-col gap-2">
          <Heading level={1} weight="semibold" color="primary">
            {t('auth.forgot.title')}
          </Heading>
          <Text size="sm" color="primary">
            {t('auth.forgot.description')}
          </Text>
        </div>

        <form className="flex flex-col gap-5 w-full" onSubmit={handleSubmit} noValidate>
          {outcome?.kind === 'sent' && (
            <div
              role="status"
              data-testid="forgot-password-sent"
              className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg"
            >
              <Text as="span" size="sm" color="inherit">{t('auth.forgot.sentNeutral')}</Text>
            </div>
          )}
          {outcome?.kind === 'error' && (
            <div
              role="alert"
              data-testid="forgot-password-error"
              className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg"
            >
              <Text as="span" size="sm" color="inherit">{t(outcome.messageKey)}</Text>
            </div>
          )}

          <FormField label={t('common.email')} htmlFor="forgot-email">
            <InputWithIcon
              id="forgot-email"
              type="email"
              placeholder={t('common.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M17 21.25H7C3.35 21.25 1.25 19.15 1.25 15.5V8.5C1.25 4.85 3.35 2.75 7 2.75H17C20.65 2.75 22.75 4.85 22.75 8.5V15.5C22.75 19.15 20.65 21.25 17 21.25ZM7 4.25C4.14 4.25 2.75 5.64 2.75 8.5V15.5C2.75 18.36 4.14 19.75 7 19.75H17C19.86 19.75 21.25 18.36 21.25 15.5V8.5C21.25 5.64 19.86 4.25 17 4.25H7Z" fill="#180149"/>
                  <path d="M12.003 12.868C11.163 12.868 10.313 12.608 9.663 12.078L6.533 9.57802C6.213 9.31802 6.153 8.84802 6.413 8.52802C6.673 8.20802 7.143 8.14802 7.463 8.40802L10.593 10.908C11.353 11.518 12.643 11.518 13.403 10.908L16.533 8.40802C16.853 8.14802 17.333 8.19802 17.583 8.52802C17.843 8.84802 17.793 9.32802 17.463 9.57802L14.333 12.078C13.693 12.608 12.843 12.868 12.003 12.868Z" fill="#180149"/>
                </svg>
              }
            />
          </FormField>

          <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isLoading}>
            {t('auth.forgot.submit')}
          </Button>
        </form>

        <Text size="sm" color="secondary" className="text-center">
          <Link to="/login" data-testid="forgot-password-back" className="font-medium text-primary underline">
            {t('auth.forgot.backToLogin')}
          </Link>
        </Text>
      </div>
    </div>
  );
}
