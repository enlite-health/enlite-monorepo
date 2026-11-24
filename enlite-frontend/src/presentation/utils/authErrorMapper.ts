import type { TFunction } from 'i18next';
import { FirebaseError } from 'firebase/app';

/**
 * Códigos de erro comuns do Firebase Auth
 * Referência: https://firebase.google.com/docs/auth/errors
 */
const AUTH_ERROR_CODES: Record<string, string> = {
  // Erros de login
  'auth/invalid-email': 'auth.errors.invalidEmail',
  'auth/user-disabled': 'auth.errors.userDisabled',
  'auth/user-not-found': 'auth.errors.userNotFound',
  'auth/wrong-password': 'auth.errors.wrongPassword',
  'auth/invalid-credential': 'auth.errors.invalidCredential',
  'auth/invalid-login-credentials': 'auth.errors.invalidLoginCredentials',
  'auth/too-many-requests': 'auth.errors.tooManyRequests',
  
  // Erros de registro
  'auth/email-already-in-use': 'auth.errors.emailAlreadyInUse',
  'auth/weak-password': 'auth.errors.weakPassword',
  // Política do Identity Platform (D770): o servidor recusa senha fora de 8 + 4 classes.
  'auth/password-does-not-meet-requirements': 'auth.errors.passwordRequirements',
  'auth/operation-not-allowed': 'auth.errors.operationNotAllowed',
  
  // Erros de Google/Popup
  'auth/popup-closed-by-user': 'auth.errors.popupClosedByUser',
  'auth/popup-blocked': 'auth.errors.popupBlocked',
  'auth/cancelled-popup-request': 'auth.errors.popupCancelled',
  'auth/account-exists-with-different-credential': 'auth.errors.accountExistsDifferentCredential',
  
  // Erros gerais
  'auth/network-request-failed': 'auth.errors.networkError',
  'auth/timeout': 'auth.errors.timeout',
  'auth/internal-error': 'auth.errors.internalError',
  'auth/unauthorized-domain': 'auth.errors.unauthorizedDomain',
};

/**
 * Mapeia mensagens de erro comuns para chaves de i18n
 */
const ERROR_MESSAGE_MAP: Record<string, string> = {
  // Mensagens comuns em inglês do Firebase
  'Invalid credentials': 'auth.errors.invalidLoginCredentials',
  'Invalid email or password': 'auth.errors.invalidLoginCredentials',
  'Incorrect email or password': 'auth.errors.invalidLoginCredentials',
  'Email already in use': 'auth.errors.emailAlreadyInUse',
  'The email address is already in use': 'auth.errors.emailAlreadyInUse',
  'Popup closed by user': 'auth.errors.popupClosedByUser',
  'The popup has been closed by the user': 'auth.errors.popupClosedByUser',
  'Network error': 'auth.errors.networkError',
  'A network error has occurred': 'auth.errors.networkError',
  'Weak password': 'auth.errors.weakPassword',
  // Texto cru do servidor quando o SDK não traz o código (ex.: PASSWORD_DOES_NOT_MEET_REQUIREMENTS).
  'PASSWORD_DOES_NOT_MEET_REQUIREMENTS': 'auth.errors.passwordRequirements',
  'Missing password requirements': 'auth.errors.passwordRequirements',
  'Password should be at least 6 characters': 'auth.errors.weakPassword',
  'User not found': 'auth.errors.userNotFound',
  'There is no user record corresponding to this identifier': 'auth.errors.userNotFound',
  'Too many attempts': 'auth.errors.tooManyRequests',
  'Too many unsuccessful login attempts': 'auth.errors.tooManyRequests',
  'Login failed': 'auth.errors.genericLoginError',
  'Registration failed': 'auth.errors.genericRegistrationError',
};

/**
 * Extrai a chave de tradução para um erro do Firebase ou retorna null se não for mapeado
 */
export function getAuthErrorTranslationKey(error: unknown): string | null {
  // Verifica se é um FirebaseError
  if (error instanceof FirebaseError) {
    const mappedKey = AUTH_ERROR_CODES[error.code];
    if (mappedKey) {
      return mappedKey;
    }
  }
  
  // Tenta mapear pela mensagem
  if (error instanceof Error) {
    const message = error.message;
    
    // Procura correspondência exata
    if (ERROR_MESSAGE_MAP[message]) {
      return ERROR_MESSAGE_MAP[message];
    }
    
    // Procura correspondência parcial (para mensagens que podem variar)
    for (const [pattern, key] of Object.entries(ERROR_MESSAGE_MAP)) {
      if (message.toLowerCase().includes(pattern.toLowerCase())) {
        return key;
      }
    }
    
    // Tenta extrair código do Firebase da mensagem (alguns erros vêm assim)
    for (const [code, key] of Object.entries(AUTH_ERROR_CODES)) {
      if (message.includes(code)) {
        return key;
      }
    }
  }
  
  return null;
}

/**
 * Retorna a mensagem traduzida ou a mensagem original se não houver tradução
 * Esta função deve ser usada com o hook useTranslation do react-i18next
 */
export function getAuthErrorMessage(
  error: unknown, 
  t: TFunction
): string {
  const translationKey = getAuthErrorTranslationKey(error);
  
  if (translationKey) {
    return t(translationKey);
  }
  
  // Fallback para a mensagem original
  if (error instanceof Error) {
    return error.message;
  }
  
  return t('auth.errors.unknownError');
}

/**
 * Verifica se o erro é um erro de autenticação conhecido
 */
export function isKnownAuthError(error: unknown): boolean {
  return getAuthErrorTranslationKey(error) !== null;
}
