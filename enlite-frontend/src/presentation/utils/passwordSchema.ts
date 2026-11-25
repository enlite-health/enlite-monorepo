import { z } from 'zod';

/**
 * Política de senha de conta (D770): 8 caracteres + maiúscula + minúscula + número + especial.
 * É a MESMA do Identity Platform de prd (Notify); o servidor é o dono, o app só avisa antes.
 * Especiais válidos, conforme a doc oficial:
 * https://docs.cloud.google.com/identity-platform/docs/password-policy
 *   ^ $ * . [ ] { } ( ) ? " ! @ # % & / \ , > < ' : ; | _ ~ `
 * (hífen, +, = e espaço NÃO contam como especial para o Identity Platform).
 */
export const PASSWORD_MIN_LENGTH = 8;
const SPECIAL = /[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`]/;

export const PASSWORD_TOO_SHORT_KEY = 'auth.action.passwordMin';
export const PASSWORD_REQUIREMENTS_KEY = 'auth.errors.passwordRequirements';

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT_KEY)
  .regex(/[A-Z]/, PASSWORD_REQUIREMENTS_KEY)
  .regex(/[a-z]/, PASSWORD_REQUIREMENTS_KEY)
  .regex(/[0-9]/, PASSWORD_REQUIREMENTS_KEY)
  .regex(SPECIAL, PASSWORD_REQUIREMENTS_KEY);
