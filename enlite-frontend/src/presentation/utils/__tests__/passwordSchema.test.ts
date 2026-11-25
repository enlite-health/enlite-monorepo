import { describe, it, expect } from 'vitest';
import { passwordSchema } from '../passwordSchema';

const msg = (s: string) => {
  const r = passwordSchema.safeParse(s);
  return r.success ? null : r.error.errors[0].message;
};

describe('passwordSchema (D770)', () => {
  it('recusa menos de 8 caracteres', () => expect(msg('Abcde1!')).toBe('auth.action.passwordMin'));
  it('recusa sem maiúscula, sem minúscula, sem número e sem especial', () => {
    for (const s of ['abcdef1!', 'ABCDEF1!', 'Abcdefg!', 'Abcdefg1']) {
      expect(msg(s)).toBe('auth.errors.passwordRequirements');
    }
  });
  it('aceita cada especial da lista do Identity Platform', () => {
    for (const c of '^$*.[]{}()?"!@#%&/\\,><\':;|_~`') expect(msg(`Abcdef1${c}`)).toBeNull();
  });
  it('hífen, +, = e espaço não contam como especial', () => {
    for (const c of ['-', '+', '=', ' ']) expect(msg(`Abcdef1${c}`)).toBe('auth.errors.passwordRequirements');
  });
});
