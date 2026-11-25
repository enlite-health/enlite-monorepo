import { describe, it, expect, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import type { TFunction } from 'i18next';
import {
  getAuthErrorTranslationKey,
  getAuthErrorMessage,
  isKnownAuthError,
} from '../authErrorMapper';

describe('authErrorMapper', () => {
  const mockT = vi.fn((key: string) => {
    const translations: Record<string, string> = {
      'auth.errors.invalidEmail': 'E-mail inválido',
      'auth.errors.userNotFound': 'Usuário não encontrado',
      'auth.errors.wrongPassword': 'Senha incorreta',
      'auth.errors.invalidLoginCredentials': 'E-mail ou senha incorretos',
      'auth.errors.emailAlreadyInUse': 'Este e-mail já está em uso',
      'auth.errors.weakPassword': 'A senha deve ter pelo menos 6 caracteres',
      'auth.errors.popupClosedByUser': 'Login cancelado - popup fechado',
      'auth.errors.networkError': 'Erro de conexão',
      'auth.errors.tooManyRequests': 'Muitas tentativas',
      'auth.errors.genericLoginError': 'Erro ao fazer login',
      'auth.errors.genericRegistrationError': 'Erro ao cadastrar',
      'auth.errors.unknownError': 'Ocorreu um erro inesperado',
    };
    return translations[key] || key;
  }) as unknown as TFunction;

  describe('getAuthErrorTranslationKey', () => {
    it('should map Firebase error codes to translation keys', () => {
      const error = new FirebaseError('auth/invalid-email', 'Invalid email');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.invalidEmail');
    });

    it('should map auth/user-not-found code', () => {
      const error = new FirebaseError('auth/user-not-found', 'User not found');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.userNotFound');
    });

    it('should map auth/wrong-password code', () => {
      const error = new FirebaseError('auth/wrong-password', 'Wrong password');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.wrongPassword');
    });

    it('should map auth/email-already-in-use code', () => {
      const error = new FirebaseError('auth/email-already-in-use', 'Email already in use');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.emailAlreadyInUse');
    });

    it('should map auth/weak-password code', () => {
      const error = new FirebaseError('auth/weak-password', 'Weak password');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.weakPassword');
    });

    it('mapeia auth/password-does-not-meet-requirements e o texto cru do servidor', () => {
      const porCodigo = new FirebaseError('auth/password-does-not-meet-requirements', 'Password does not meet requirements');
      expect(getAuthErrorTranslationKey(porCodigo)).toBe('auth.errors.passwordRequirements');
      const porTexto = new Error('PASSWORD_DOES_NOT_MEET_REQUIREMENTS : Missing password requirements: [Password must contain an upper case character]');
      expect(getAuthErrorTranslationKey(porTexto)).toBe('auth.errors.passwordRequirements');
    });

    it('should map auth/popup-closed-by-user code', () => {
      const error = new FirebaseError('auth/popup-closed-by-user', 'Popup closed');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.popupClosedByUser');
    });

    it('should map auth/network-request-failed code', () => {
      const error = new FirebaseError('auth/network-request-failed', 'Network error');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.networkError');
    });

    it('should map common error messages to translation keys', () => {
      const error = new Error('Invalid credentials');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.invalidLoginCredentials');
    });

    it('should map "Email already in use" message', () => {
      const error = new Error('Email already in use');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.emailAlreadyInUse');
    });

    it('should map "Popup closed by user" message', () => {
      const error = new Error('Popup closed by user');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.popupClosedByUser');
    });

    it('should return null for unknown errors', () => {
      const error = new Error('Some random error');
      expect(getAuthErrorTranslationKey(error)).toBeNull();
    });

    it('should return null for non-error values', () => {
      expect(getAuthErrorTranslationKey('string')).toBeNull();
      expect(getAuthErrorTranslationKey(123)).toBeNull();
      expect(getAuthErrorTranslationKey(null)).toBeNull();
      expect(getAuthErrorTranslationKey(undefined)).toBeNull();
    });

    it('should match partial messages', () => {
      const error = new Error('The email address is already in use by another account');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.emailAlreadyInUse');
    });

    it('should extract Firebase code from message if present', () => {
      const error = new Error('Firebase: Error (auth/invalid-email).');
      expect(getAuthErrorTranslationKey(error)).toBe('auth.errors.invalidEmail');
    });
  });

  describe('getAuthErrorMessage', () => {
    it('should return translated message for known Firebase errors', () => {
      const error = new FirebaseError('auth/invalid-email', 'Invalid email');
      const result = getAuthErrorMessage(error, mockT);
      expect(result).toBe('E-mail inválido');
      expect(mockT).toHaveBeenCalledWith('auth.errors.invalidEmail');
    });

    it('should return translated message for known error messages', () => {
      const error = new Error('Invalid credentials');
      const result = getAuthErrorMessage(error, mockT);
      expect(result).toBe('E-mail ou senha incorretos');
      expect(mockT).toHaveBeenCalledWith('auth.errors.invalidLoginCredentials');
    });

    it('should return original message for unknown errors', () => {
      const error = new Error('Some random error message');
      const result = getAuthErrorMessage(error, mockT);
      expect(result).toBe('Some random error message');
    });

    it('should return unknown error translation for non-error values', () => {
      const result = getAuthErrorMessage('not an error', mockT);
      expect(result).toBe('Ocorreu um erro inesperado');
      expect(mockT).toHaveBeenCalledWith('auth.errors.unknownError');
    });
  });

  describe('isKnownAuthError', () => {
    it('should return true for known Firebase errors', () => {
      const error = new FirebaseError('auth/invalid-email', 'Invalid email');
      expect(isKnownAuthError(error)).toBe(true);
    });

    it('should return true for known error messages', () => {
      const error = new Error('Invalid credentials');
      expect(isKnownAuthError(error)).toBe(true);
    });

    it('should return false for unknown errors', () => {
      const error = new Error('Some random error');
      expect(isKnownAuthError(error)).toBe(false);
    });

    it('should return false for non-error values', () => {
      expect(isKnownAuthError('string')).toBe(false);
      expect(isKnownAuthError(123)).toBe(false);
      expect(isKnownAuthError(null)).toBe(false);
    });
  });
});
