/**
 * Unit de `scripts/lib/maskEmail.ts` (B3) — a fonte única de `mask` que antes
 * estava copiada byte a byte em `espelhar-staff-stage.ts` e `iam-config-import.ts`.
 * Nunca logar e-mail completo (regra dura de PII).
 */
import { maskEmail } from '../../../scripts/lib/maskEmail';

describe('maskEmail', () => {
  it('mantém os 2 primeiros caracteres do local-part e o domínio', () => {
    expect(maskEmail('gestor@enlite.health')).toBe('ge…@enlite.health');
  });

  it('local-part de 2 caracteres', () => {
    expect(maskEmail('ab@e.com')).toBe('ab…@e.com');
  });

  it('e-mail sem @ não é tocado (regex não bate)', () => {
    expect(maskEmail('nao-e-email')).toBe('nao-e-email');
  });

  it('(M6) local-part de 1 caractere fica TOTALMENTE oculto — a regex antiga (`/^(..).*@/`) deixava passar inteiro', () => {
    expect(maskEmail('a@enlite.health')).toBe('…@enlite.health');
  });

  it('(M6) local-part vazio (e-mail começa com @) também fica totalmente oculto', () => {
    expect(maskEmail('@enlite.health')).toBe('…@enlite.health');
  });
});
