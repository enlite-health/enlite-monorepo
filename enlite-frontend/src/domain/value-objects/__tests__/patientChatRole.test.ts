import { describe, it, expect } from 'vitest';
import {
  chatRolesToDisplay,
  chatRoleLabel,
  isPatientChatRoleCode,
  PATIENT_CHAT_ROLE_PATTERN,
  PATIENT_CHAT_ROLE_MAX_LENGTH,
  type PatientChatRoleSpec,
} from '../patientChatRole';

function spec(code: string, over: Partial<PatientChatRoleSpec> = {}): PatientChatRoleSpec {
  return {
    code,
    labelEs: `es-${code}`,
    labelPtBr: `pt-${code}`,
    isExclusive: true,
    displayOrder: 0,
    isActive: true,
    matchKeywords: [],
    ...over,
  };
}

/** O catálogo como a API o devolve, já na ordem de exibição. */
const CATALOG = [spec('FAMILY'), spec('PROVIDERS'), spec('HEALTH_PLAN', { isExclusive: false })];

describe('patientChatRole — o painel não tem lista própria de papéis', () => {
  it('não exporta lista de papéis: o catálogo vem da API', async () => {
    // Trava estrutural. Uma lista aqui voltaria a envelhecer junto com a
    // operação — foi de 2 para 3 papéis em um dia.
    const mod = await import('../patientChatRole');
    expect(Object.keys(mod)).not.toContain('PATIENT_CHAT_ROLES');
  });

  describe('chatRolesToDisplay', () => {
    it('usa a ordem do catálogo, não a alfabética', () => {
      expect(chatRolesToDisplay(CATALOG, {})).toEqual(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']);
    });

    it('papel gravado no paciente que saiu do catálogo CONTINUA aparecendo', () => {
      // Esconder um vínculo existente é pior que mostrar o código cru: sem isso
      // a pessoa vincularia outro grupo por cima sem saber que já havia um.
      expect(chatRolesToDisplay(CATALOG, { MANAGEMENT: '9@g.us' })).toEqual([
        'FAMILY', 'PROVIDERS', 'HEALTH_PLAN', 'MANAGEMENT',
      ]);
    });

    it('catálogo que não carregou ainda mostra o que o paciente TEM', () => {
      // É o caso da rede lenta: a ficha não pode dizer "sem vínculo" para quem
      // tem vínculo só porque o catálogo demorou.
      expect(chatRolesToDisplay([], { FAMILY: '1@g.us' })).toEqual(['FAMILY']);
    });

    it('extras entram em ordem estável (alfabética), sem duplicar os conhecidos', () => {
      expect(chatRolesToDisplay(CATALOG, { ZZZ: 'z@g.us', AAA: 'a@g.us', FAMILY: '1@g.us' })).toEqual([
        'FAMILY', 'PROVIDERS', 'HEALTH_PLAN', 'AAA', 'ZZZ',
      ]);
    });

    it('chatIds nulo ou indefinido não quebra', () => {
      expect(chatRolesToDisplay(CATALOG, null)).toEqual(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']);
      expect(chatRolesToDisplay(CATALOG, undefined)).toEqual(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']);
    });

    it('tudo vazio devolve lista vazia', () => {
      expect(chatRolesToDisplay([], {})).toEqual([]);
    });
  });

  describe('chatRoleLabel', () => {
    it.each([
      ['pt-BR', 'pt-FAMILY'],
      ['pt', 'pt-FAMILY'],
      ['es', 'es-FAMILY'],
      ['es-AR', 'es-FAMILY'],
      ['en', 'es-FAMILY'],
    ])('locale %s -> %s', (locale, expected) => {
      expect(chatRoleLabel(CATALOG, 'FAMILY', locale)).toBe(expected);
    });

    it('papel fora do catálogo vira o próprio código, nunca campo sem nome', () => {
      expect(chatRoleLabel(CATALOG, 'MANAGEMENT', 'es')).toBe('MANAGEMENT');
      expect(chatRoleLabel([], 'FAMILY', 'pt-BR')).toBe('FAMILY');
    });
  });

  describe('isPatientChatRoleCode — espelha o CHECK do banco', () => {
    it.each(['FAMILY', 'HEALTH_PLAN', 'A', 'PLAN_2'])('aceita %s', v => {
      expect(isPatientChatRoleCode(v)).toBe(true);
    });

    it.each(['family', 'HEALTH PLAN', 'HEALTH-PLAN', '1FAMILY', '_X', '', 'FAMÍLIA'])(
      'recusa %s',
      v => {
        expect(isPatientChatRoleCode(v)).toBe(false);
      },
    );

    it('recusa código maior que a coluna', () => {
      expect(isPatientChatRoleCode('A'.repeat(PATIENT_CHAT_ROLE_MAX_LENGTH))).toBe(true);
      expect(isPatientChatRoleCode('A'.repeat(PATIENT_CHAT_ROLE_MAX_LENGTH + 1))).toBe(false);
      // a forma sozinha passaria — é o comprimento que barra
      expect(PATIENT_CHAT_ROLE_PATTERN.test('A'.repeat(PATIENT_CHAT_ROLE_MAX_LENGTH + 1))).toBe(true);
    });
  });
});
