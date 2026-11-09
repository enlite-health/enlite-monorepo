import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@presentation/hooks/useAuth';
import type { User } from '@domain/entities/User';

interface GoogleLoginButtonProps {
  onSuccess?: (user: User) => void;
  onError?: (error: Error) => void;
  variant?: 'register' | 'login';
}

export function GoogleLoginButton({ onSuccess, onError, variant = 'login' }: GoogleLoginButtonProps) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const { loginWithGoogle } = useAuth();

  const handleClick = async () => {
    try {
      setIsLoading(true);
      const user = await loginWithGoogle();
      onSuccess?.(user);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error('Google login failed'));
    } finally {
      setIsLoading(false);
    }
  };

  const buttonText = variant === 'register' ? t('auth.google.register') : t('auth.google.login');

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isLoading}
      style={{
        display: 'flex',
        padding: '17px 101px',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '12px',
        borderRadius: '100px',
        border: '1.5px solid #180149',
        background: '#FFF',
        cursor: isLoading ? 'not-allowed' : 'pointer',
        opacity: isLoading ? 0.7 : 1,
        width: '100%',
        height: '56px',
        boxSizing: 'border-box',
      }}
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M19.8042 10.2312C19.8042 9.55141 19.7491 8.86797 19.6315 8.19922H10.1992V12.05H15.6007C15.3765 13.292 14.6563 14.3907 13.6018 15.0888V17.5874H16.8243C18.7166 15.8457 19.8042 13.2736 19.8042 10.2312Z" fill="#4285F4"/>
        <path d="M10.198 20.0017C12.895 20.0017 15.1695 19.1162 16.8267 17.5876L13.6042 15.089C12.7076 15.699 11.5502 16.0444 10.2016 16.0444C7.59279 16.0444 5.38077 14.2843 4.58709 11.918H1.26172V14.4938C2.95931 17.8706 6.41697 20.0017 10.198 20.0017Z" fill="#34A853"/>
        <path d="M4.58467 11.9163C4.16578 10.6743 4.16578 9.32947 4.58467 8.0875V5.51172H1.26297C-0.155365 8.33737 -0.155365 11.6664 1.26297 14.4921L4.58467 11.9163Z" fill="#FBBC04"/>
        <path d="M10.198 3.95805C11.6236 3.936 13.0016 4.47247 14.0341 5.45722L16.8891 2.60218C15.0813 0.904588 12.6819 -0.0287217 10.198 0.000673889C6.41696 0.000673889 2.95931 2.13185 1.26172 5.51234L4.58342 8.08813C5.37342 5.71811 7.58911 3.95805 10.198 3.95805Z" fill="#EA4335"/>
      </svg>
      <span style={{
        color: '#180149',
        fontFamily: 'Poppins, sans-serif',
        fontSize: '16px',
        fontWeight: 600,
        lineHeight: '135%',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>
        {buttonText}
      </span>
    </button>
  );
}
