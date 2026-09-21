import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '../../../infrastructure/i18n/config';
import { createGeneralInfoSchema } from '../workerRegistrationSchemas';

/**
 * Defeito 1 (21/09/2026, autorizado pelo Gabriel): o schema do form só exigia
 * `min(1)` em `birthDate` — qualquer string não-vazia passava, inclusive o
 * agrupamento quebrado que `maskDate` produz para entrada incompleta
 * ("25/31/985"). Este teste prova que o schema agora rejeita data incompleta
 * ou calendário-inválida, com mensagem amigável (não técnica do Zod).
 */
const VALID = {
  profilePhoto: null,
  fullName: 'Alberto Marquez',
  lastName: 'Marquez',
  cpf: '12345678901',
  phone: '+5411999999999',
  email: 'alberto@example.com',
  birthDate: '18/03/1960',
  sex: 'male' as const,
  gender: 'male' as const,
  documentType: 'CUIL_CUIT' as const,
  professionalLicense: 'Licenciado en psicología',
  languages: ['es'] as Array<'pt' | 'es' | 'en'>,
  profession: 'AT' as const,
  knowledgeLevel: 'BACHELOR' as const,
  experienceTypes: ['adicciones'] as Array<'adicciones'>,
  yearsExperience: '3_5' as const,
  preferredTypes: ['adicciones'] as Array<'adicciones'>,
  preferredAgeRange: ['adults'] as Array<'children' | 'adolescents' | 'adults' | 'elderly'>,
};

describe('generalInfoSchema — birthDate (defeito 1)', () => {
  beforeAll(() => {
    i18n.changeLanguage('es');
  });

  it('data válida DD/MM/AAAA → aceita', () => {
    const result = createGeneralInfoSchema().safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('agrupamento quebrado de mask incompleta ("25/31/985") → rejeita com mensagem amigável', () => {
    const result = createGeneralInfoSchema().safeParse({ ...VALID, birthDate: '25/31/985' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.errors.find((e) => e.path[0] === 'birthDate')?.message;
      expect(msg).toBe('Ingrese una fecha de nacimiento válida (DD/MM/AAAA)');
    }
  });

  it('mês 13 → rejeita', () => {
    const result = createGeneralInfoSchema().safeParse({ ...VALID, birthDate: '18/13/1990' });
    expect(result.success).toBe(false);
  });

  it('31 de abril (dia inexistente) → rejeita', () => {
    const result = createGeneralInfoSchema().safeParse({ ...VALID, birthDate: '31/04/1990' });
    expect(result.success).toBe(false);
  });

  it('data futura → rejeita', () => {
    const futureYear = new Date().getFullYear() + 1;
    const result = createGeneralInfoSchema().safeParse({ ...VALID, birthDate: `01/01/${futureYear}` });
    expect(result.success).toBe(false);
  });

  it('vazio → mantém a mensagem de obrigatório (não a de formato)', () => {
    const result = createGeneralInfoSchema().safeParse({ ...VALID, birthDate: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.errors.find((e) => e.path[0] === 'birthDate')?.message;
      expect(msg).toBe('La fecha de nacimiento es obligatoria');
    }
  });

  it('PT-BR: mensagem de formato inválido traduzida', () => {
    i18n.changeLanguage('pt-BR');
    const result = createGeneralInfoSchema().safeParse({ ...VALID, birthDate: '31/04/1990' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.errors.find((e) => e.path[0] === 'birthDate')?.message;
      expect(msg).toBe('Informe uma data de nascimento válida (DD/MM/AAAA)');
    }
    i18n.changeLanguage('es');
  });
});
