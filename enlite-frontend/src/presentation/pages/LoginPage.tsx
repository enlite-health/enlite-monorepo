import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { GoogleLoginButton } from '@presentation/components/features/auth/GoogleLoginButton';
import { useAuth } from '@presentation/hooks/useAuth';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField, InputWithIcon, PasswordInput } from '@presentation/components/molecules';
import { Button } from '@presentation/components/atoms/Button';
import { Divider } from '@presentation/components/atoms';
import { AuthNavbar } from '@presentation/components/organisms/AuthNavbar';
import { getAuthErrorMessage } from '@presentation/utils/authErrorMapper';

const loginSchema = z.object({
  email: z.string().min(1, 'login.emailRequired').email('register.invalidEmail'),
  password: z.string().min(1, 'login.passwordRequired'),
});

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSuccess = () => {
    // Support ?next= redirect for auth-guarded pages
    const next = searchParams.get('next');
    navigate(next || '/');
  };

  const handleError = (err: Error) => {
    console.error('Login failed:', err);
    const translatedError = getAuthErrorMessage(err, t);
    setError(translatedError);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const result = loginSchema.safeParse({ email, password });
    if (!result.success) {
      setError(t(result.error.errors[0].message));
      return;
    }

    setIsLoading(true);

    try {
      await login(email, password);
      handleSuccess();
    } catch (err) {
      handleError(err instanceof Error ? err : new Error('Login failed'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col px-4 sm:px-10 md:px-16 lg:px-20 xl:px-[120px] pt-8 pb-20 sm:pb-24 lg:pb-[138px] gap-8 sm:gap-10 lg:gap-12">
      <AuthNavbar className="px-4" />

      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center w-full max-w-[1200px] self-center flex-1 gap-8 md:gap-10 lg:gap-12">
        <div className="flex flex-col justify-center gap-5 w-full lg:w-[456px]">
          <div className="flex flex-col gap-2">
            <Heading level={1} weight="semibold" color="primary">
              {t('login.title')}
            </Heading>
            <Text size="sm" color="primary" className="max-w-[456px]">
              {t('login.description')}
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
                  onChange={(e) => setEmail(e.target.value)}
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

              <div className="text-right">
                <a href="#" className="font-lexend text-sm font-medium text-primary hover:underline">
                  {t('login.forgotPassword')}
                </a>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                isLoading={isLoading}
              >
                {t('login.loginButton')}
              </Button>

              <Divider text={t('login.orLoginWith')} />

              <GoogleLoginButton onSuccess={handleSuccess} onError={handleError} />
            </div>
          </form>

          <Text size="sm" color="secondary" className="text-right">
            {t('login.noAccount')}{' '}
            <Link to="/register?type=worker" className="font-medium text-primary underline">
              {t('login.signUp')}
            </Link>
          </Text>
        </div>

        <div className="hidden lg:flex shrink-0 w-[400px] xl:w-[700px] h-[400px] xl:h-[760px] overflow-hidden rounded-[16px]">
          <img
            src="https://api.builder.io/api/v1/image/assets/TEMP/204e5b41cf4b024bf575ab2f43cda6fd3787b71f?width=1400"
            alt="Enlite care moments"
            className="w-full h-full object-cover"
          />
        </div>
      </div>
    </div>
  );
}
