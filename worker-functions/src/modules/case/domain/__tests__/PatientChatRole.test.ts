import {
  PATIENT_CHAT_ROLES,
  PATIENT_CHAT_ROLE_VALUES,
  PATIENT_CHAT_ROLE_PATTERN,
  PATIENT_CHAT_ROLE_MAX_LENGTH,
  isPatientChatRole,
  isExclusiveChatRole,
} from '../PatientChatRole';

describe('PatientChatRole — o catálogo', () => {
  it('tem os três papéis que o Marcel pediu, e o do plano de saúde é o novo', () => {
    expect(PATIENT_CHAT_ROLE_VALUES).toEqual(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']);
  });

  it('todo papel casa com o CHECK do banco (INGLÊS MAIÚSCULO, sem espaço)', () => {
    for (const role of PATIENT_CHAT_ROLE_VALUES) {
      expect(PATIENT_CHAT_ROLE_PATTERN.test(role)).toBe(true);
      expect(role.length).toBeLessThanOrEqual(PATIENT_CHAT_ROLE_MAX_LENGTH);
    }
  });

  it.each([
    ['minúsculo', 'family'],
    ['com espaço', 'HEALTH PLAN'],
    ['com hífen', 'HEALTH-PLAN'],
    ['começando com dígito', '1FAMILY'],
    ['vazio', ''],
    ['acento', 'FAMÍLIA'],
  ])('o padrão recusa %s', (_l, value) => {
    expect(PATIENT_CHAT_ROLE_PATTERN.test(value)).toBe(false);
  });

  describe('isPatientChatRole', () => {
    it.each(PATIENT_CHAT_ROLE_VALUES)('reconhece %s', role => {
      expect(isPatientChatRole(role)).toBe(true);
    });

    it.each(['family', 'MANAGEMENT', '', 'toString', 'constructor'])(
      'não reconhece %s (inclusive herdado de Object.prototype)',
      value => {
        expect(isPatientChatRole(value)).toBe(false);
      },
    );
  });

  describe('isExclusiveChatRole — a política de unicidade', () => {
    it('FAMILY e PROVIDERS são exclusivos (necessidade comprovada, 409 em prod)', () => {
      expect(isExclusiveChatRole('FAMILY')).toBe(true);
      expect(isExclusiveChatRole('PROVIDERS')).toBe(true);
    });

    it('HEALTH_PLAN é exclusivo ENQUANTO o Marcel não responder — decisão conservadora', () => {
      // Se este teste quebrar, a política mudou de propósito: conferir se o
      // UPDATE de is_exclusive das linhas já gravadas foi junto com o deploy.
      expect(isExclusiveChatRole('HEALTH_PLAN')).toBe(true);
      expect(PATIENT_CHAT_ROLES.HEALTH_PLAN.exclusive).toBe(true);
    });

    it('papel DESCONHECIDO tranca — na dúvida, não deixa contar duas vezes', () => {
      expect(isExclusiveChatRole('MANAGEMENT')).toBe(true);
      expect(isExclusiveChatRole('')).toBe(true);
    });
  });

  it('somar um papel novo não passa por schema: basta uma entrada aqui', () => {
    // A prova é estrutural: tudo que a aplicação sabe sobre papéis sai deste
    // objeto, então a lista derivada acompanha automaticamente.
    expect(PATIENT_CHAT_ROLE_VALUES).toEqual(Object.keys(PATIENT_CHAT_ROLES));
  });
});
