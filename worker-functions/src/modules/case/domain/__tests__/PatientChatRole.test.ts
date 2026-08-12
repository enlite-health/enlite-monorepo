import {
  PATIENT_CHAT_ROLE_PATTERN,
  PATIENT_CHAT_ROLE_MAX_LENGTH,
  isPatientChatRoleCode,
  isExclusiveChatRole,
  toRoleCatalog,
  chatRoleLabel,
  type PatientChatRoleSpec,
} from '../PatientChatRole';

function spec(over: Partial<PatientChatRoleSpec> & { code: string }): PatientChatRoleSpec {
  return {
    labelEs: `es-${over.code}`,
    labelPtBr: `pt-${over.code}`,
    isExclusive: true,
    displayOrder: 0,
    isActive: true,
    matchKeywords: [],
    ...over,
  };
}

/** O que a migration 262 semeia — a forma que a aplicação vê depois de ler o banco. */
const SEEDED = [
  spec({ code: 'FAMILY', displayOrder: 1, matchKeywords: ['flia', 'familia'] }),
  spec({ code: 'PROVIDERS', displayOrder: 2, matchKeywords: ['equipo'] }),
  spec({ code: 'HEALTH_PLAN', isExclusive: false, displayOrder: 3 }),
];

describe('PatientChatRole — o que sobrou em código depois que o catálogo virou dado', () => {
  it('não exporta lista de papéis: o catálogo é DADO, não código', async () => {
    // Trava estrutural. Se alguém reintroduzir um PATIENT_CHAT_ROLES aqui, o
    // papel volta a exigir deploy — que é exatamente o que a 262 elimina.
    const mod = await import('../PatientChatRole');
    expect(Object.keys(mod)).not.toContain('PATIENT_CHAT_ROLES');
    expect(Object.keys(mod)).not.toContain('PATIENT_CHAT_ROLE_VALUES');
  });

  describe('a FORMA de um código de papel (o CHECK do banco, espelhado)', () => {
    it.each(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN', 'MANAGEMENT', 'A', 'PLAN_2'])(
      'aceita %s',
      value => {
        expect(isPatientChatRoleCode(value)).toBe(true);
        expect(PATIENT_CHAT_ROLE_PATTERN.test(value)).toBe(true);
      },
    );

    it.each([
      ['minúsculo', 'family'],
      ['com espaço', 'HEALTH PLAN'],
      ['com hífen', 'HEALTH-PLAN'],
      ['começando com dígito', '1FAMILY'],
      ['começando com underscore', '_FAMILY'],
      ['vazio', ''],
      ['acento', 'FAMÍLIA'],
    ])('recusa %s', (_l, value) => {
      expect(isPatientChatRoleCode(value)).toBe(false);
    });

    it('recusa código maior que a coluna — senão o INSERT estoura no banco, não aqui', () => {
      const tooLong = 'A'.repeat(PATIENT_CHAT_ROLE_MAX_LENGTH + 1);
      expect(PATIENT_CHAT_ROLE_PATTERN.test(tooLong)).toBe(true); // a forma passa…
      expect(isPatientChatRoleCode(tooLong)).toBe(false); // …o comprimento não
      expect(isPatientChatRoleCode('A'.repeat(PATIENT_CHAT_ROLE_MAX_LENGTH))).toBe(true);
    });
  });

  describe('toRoleCatalog', () => {
    it('indexa por código', () => {
      const catalog = toRoleCatalog(SEEDED);
      expect(catalog.size).toBe(3);
      expect(catalog.get('FAMILY')?.labelEs).toBe('es-FAMILY');
    });

    it('catálogo vazio (banco novo, migration não rodou) não explode', () => {
      expect(toRoleCatalog([]).size).toBe(0);
    });
  });

  describe('isExclusiveChatRole — o ponto ÚNICO da política de unicidade', () => {
    const catalog = toRoleCatalog(SEEDED);

    it('lê a política do CATÁLOGO, não de código', () => {
      expect(isExclusiveChatRole(catalog, 'FAMILY')).toBe(true);
      expect(isExclusiveChatRole(catalog, 'PROVIDERS')).toBe(true);
      // HEALTH_PLAN nasce compartilhável: 27 pagadores para 236 pacientes.
      expect(isExclusiveChatRole(catalog, 'HEALTH_PLAN')).toBe(false);
    });

    it('a MESMA função devolve o oposto quando o admin vira a chave na tela', () => {
      // É a prova de que trocar a política não passa por deploy: muda o dado,
      // muda a resposta.
      const flipped = toRoleCatalog([spec({ code: 'HEALTH_PLAN', isExclusive: true })]);
      expect(isExclusiveChatRole(flipped, 'HEALTH_PLAN')).toBe(true);
    });

    it.each([
      ['fora do catálogo', 'MANAGEMENT'],
      ['vazio', ''],
      ['herdado de Object.prototype', 'toString'],
      ['herdado — constructor', 'constructor'],
    ])('papel %s TRANCA — na dúvida, não deixa contar duas vezes', (_l, value) => {
      expect(isExclusiveChatRole(catalog, value)).toBe(true);
    });
  });

  describe('chatRoleLabel', () => {
    const family = SEEDED[0];

    it.each([
      ['pt-BR', 'pt-FAMILY'],
      ['pt', 'pt-FAMILY'],
      ['PT-br', 'pt-FAMILY'],
      ['es', 'es-FAMILY'],
      ['es-AR', 'es-FAMILY'],
      ['en', 'es-FAMILY'],
    ])('locale %s -> %s', (locale, expected) => {
      expect(chatRoleLabel(family, locale)).toBe(expected);
    });

    it('papel inexistente devolve string vazia, nunca "undefined" na tela', () => {
      expect(chatRoleLabel(undefined, 'es')).toBe('');
    });
  });
});
