import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FormField, InputWithIcon, PasswordInput } from '@presentation/components/molecules';
import { Button } from '@presentation/components/atoms/Button';
import { AuthNavbar } from '@presentation/components/organisms/AuthNavbar';
import { getAuthErrorMessage } from '@presentation/utils/authErrorMapper';
import { startAuthTrace } from '@infrastructure/observability/authTrace';

const loginSchema = z.object({
  email: z.string().min(1, 'admin.login.emailRequired').email('register.invalidEmail'),
  password: z.string().min(1, 'admin.login.passwordRequired'),
});

export function AdminLoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login, loginWithGoogle } = useAdminAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setError(null);
    setIsGoogleLoading(true);
    const trace = startAuthTrace('google');
    try {
      await loginWithGoogle(trace);

      await new Promise(resolve => setTimeout(resolve, 500));

      const { adminProfile: profile } = useAdminAuthStore.getState();
      trace.step('store-read', { hasProfile: !!profile });

      if (!profile) {
        trace.end('denied');
        setError(t('admin.login.notAuthorized', 'Acesso negado. Esta conta não possui permissões de administrador.'));
        const { logout: adminLogout } = useAdminAuthStore.getState();
        await adminLogout();
        return;
      }

      trace.step('redirect', { to: '/admin' });
      navigate('/admin');
      trace.end('success');
    } catch (err) {
      trace.fail('login-flow', err);
      trace.end('error');
      if (err instanceof Error && err.message === 'admin.login.unauthorizedDomain') {
        setError(t('admin.login.unauthorizedDomain', 'Acesso negado. Apenas emails @enlite.health têm acesso ao painel administrativo.'));
      } else {
        setError(getAuthErrorMessage(err, t));
      }
    } finally {
      setIsGoogleLoading(false);
    }
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
    const trace = startAuthTrace('password');
    try {
      await login(email, password, trace);

      // Aguarda um momento para o store atualizar o adminProfile
      await new Promise(resolve => setTimeout(resolve, 500));

      // Verifica se o perfil admin foi carregado
      const { adminProfile: profile } = useAdminAuthStore.getState();
      trace.step('store-read', { hasProfile: !!profile });

      if (!profile) {
        // Usuário autenticou no Firebase mas não tem perfil admin
        trace.end('denied');
        console.warn('[AdminLoginPage] Login bloqueado - usuário não é admin');
        setError(t('admin.login.notAuthorized', 'Acesso negado. Esta conta não possui permissões de administrador.'));

        // Faz logout para limpar o estado
        const { logout: adminLogout } = useAdminAuthStore.getState();
        await adminLogout();
        setIsLoading(false);
        return;
      }

      // Admin válido, redireciona
      trace.step('redirect', { to: '/admin' });
      navigate('/admin');
      trace.end('success');
    } catch (err) {
      trace.fail('login-flow', err);
      trace.end('error');
      const translatedError = getAuthErrorMessage(err, t);
      setError(translatedError);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col px-4 sm:px-10 md:px-16 lg:px-20 xl:px-[120px] pt-8 pb-20 gap-8 sm:gap-10 lg:gap-12">
      <AuthNavbar className="px-4" />

      <div className="flex flex-col items-center justify-center flex-1 w-full max-w-[440px] mx-auto">
        <div className="flex flex-col gap-2 mb-8 text-center">
          <Heading level={1} weight="semibold" color="primary">
            {t('admin.login.title', 'Panel Administrativo')}
          </Heading>
          <Text size="sm" color="primary">
            {t('admin.login.description', 'Ingrese sus credenciales de administrador')}
          </Text>
        </div>

        <form className="flex flex-col gap-5 w-full" onSubmit={handleSubmit}>
          {error && (
            <div className="bg-red-50 border border-red-200 px-4 py-3 rounded-lg">
              <Text as="span" size="sm" color="primary">{error}</Text>
            </div>
          )}

          <div className="flex flex-col gap-3 w-full">
            <FormField label={t('common.email')} htmlFor="admin-email">
              <InputWithIcon
                id="admin-email"
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

            <FormField label={t('common.password')} htmlFor="admin-password">
              <PasswordInput
                id="admin-password"
                placeholder={t('common.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            isLoading={isLoading}
          >
            {t('admin.login.loginButton', 'Iniciar sesión')}
          </Button>
        </form>

        <div className="flex items-center gap-3 w-full mt-5">
          <div className="flex-1 h-px bg-gray-200" />
          <Text as="span" size="sm" color="muted" className="whitespace-nowrap">
            {t('common.or', 'ou')}
          </Text>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        <button
          type="button"
          onClick={handleGoogleLogin}
          disabled={isGoogleLoading || isLoading}
          className="mt-3 flex items-center justify-center gap-3 w-full h-14 rounded-full border border-[#180149] bg-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M19.8042 10.2312C19.8042 9.55141 19.7491 8.86797 19.6315 8.19922H10.1992V12.05H15.6007C15.3765 13.292 14.6563 14.3907 13.6018 15.0888V17.5874H16.8243C18.7166 15.8457 19.8042 13.2736 19.8042 10.2312Z" fill="#4285F4"/>
            <path d="M10.198 20.0017C12.895 20.0017 15.1695 19.1162 16.8267 17.5876L13.6042 15.089C12.7076 15.699 11.5502 16.0444 10.2016 16.0444C7.59279 16.0444 5.38077 14.2843 4.58709 11.918H1.26172V14.4938C2.95931 17.8706 6.41697 20.0017 10.198 20.0017Z" fill="#34A853"/>
            <path d="M4.58467 11.9163C4.16578 10.6743 4.16578 9.32947 4.58467 8.0875V5.51172H1.26297C-0.155365 8.33737 -0.155365 11.6664 1.26297 14.4921L4.58467 11.9163Z" fill="#FBBC04"/>
            <path d="M10.198 3.95805C11.6236 3.936 13.0016 4.47247 14.0341 5.45722L16.8891 2.60218C15.0813 0.904588 12.6819 -0.0287217 10.198 0.000673889C6.41696 0.000673889 2.95931 2.13185 1.26172 5.51234L4.58342 8.08813C5.37342 5.71811 7.58911 3.95805 10.198 3.95805Z" fill="#EA4335"/>
          </svg>
          <Text as="span" size="base" weight="semibold" color="primary">
            {isGoogleLoading ? t('common.loading', 'Carregando...') : t('auth.google.login', 'Entrar com Google')}
          </Text>
        </button>
      </div>
    </div>
  );
}
