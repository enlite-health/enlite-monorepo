import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  verifyPasswordResetCode,
  confirmPasswordReset,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { getFirebaseAuth } from '@infrastructure/config/firebase';
import { AuthNavbar } from '@presentation/components/organisms/AuthNavbar';
import { ActionErrorCard } from './ActionErrorCard';
import { PasswordResetForm } from './PasswordResetForm';

type PageState =
  | 'verifying'
  | 'ready'
  | 'submitting'
  | 'error-verification'
  | 'error-submit';

export function AuthActionPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const mode = searchParams.get('mode');
  const oobCode = searchParams.get('oobCode') ?? '';

  const [pageState, setPageState] = useState<PageState>('verifying');
  const [verifiedEmail, setVerifiedEmail] = useState<string>('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'resetPassword') {
      setPageState('error-verification');
      return;
    }

    if (!oobCode) {
      setPageState('error-verification');
      return;
    }

    const auth = getFirebaseAuth();
    verifyPasswordResetCode(auth, oobCode)
      .then((email) => {
        setVerifiedEmail(email);
        setPageState('ready');
      })
      .catch(() => {
        setPageState('error-verification');
      });
  }, [mode, oobCode]);

  const handleSubmit = async (newPassword: string) => {
    setPageState('submitting');
    setSubmitError(null);

    try {
      const auth = getFirebaseAuth();
      await confirmPasswordReset(auth, oobCode, newPassword);
      const credential = await signInWithEmailAndPassword(auth, verifiedEmail, newPassword);
      const idTokenResult = await credential.user.getIdTokenResult(true);
      // D294: o tipo da conta (`account_type`) é a fronteira staff × prestador; o papel
      // é só a ponte para conta que ainda não recebeu o claim novo.
      const accountType = idTokenResult.claims['account_type'] as string | undefined;
      const role = idTokenResult.claims['role'] as string | undefined;
      const isStaff = accountType !== undefined
        ? accountType === 'staff'
        : role === 'admin' || role === 'recruiter' || role === 'community_manager';

      if (isStaff) {
        navigate('/admin', { replace: true });
      } else {
        navigate('/', { replace: true });
      }
    } catch {
      setSubmitError(t('auth.action.genericError'));
      setPageState('error-submit');
    }
  };

  const renderContent = () => {
    if (pageState === 'verifying') {
      return (
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary" />
          <p className="font-lexend text-sm text-gray-600">{t('auth.action.verifying')}</p>
        </div>
      );
    }

    if (pageState === 'error-verification') {
      const titleKey =
        mode !== 'resetPassword'
          ? 'auth.action.unsupportedMode'
          : 'auth.action.linkInvalid';
      const descKey =
        mode !== 'resetPassword' ? undefined : 'auth.action.linkInvalidDesc';

      return <ActionErrorCard titleKey={titleKey} descriptionKey={descKey} />;
    }

    return (
      <PasswordResetForm
        email={verifiedEmail}
        isSubmitting={pageState === 'submitting'}
        submitError={pageState === 'error-submit' ? submitError : null}
        onSubmit={handleSubmit}
      />
    );
  };

  return (
    <div className="min-h-screen bg-background flex flex-col px-4 sm:px-10 md:px-16 lg:px-20 xl:px-[120px] pt-8 pb-20 gap-8 sm:gap-10 lg:gap-12">
      <AuthNavbar className="px-4" />

      <div className="flex flex-col items-center justify-center flex-1 w-full max-w-[440px] mx-auto">
        {renderContent()}
      </div>
    </div>
  );
}
