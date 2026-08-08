import { describe, it, expect } from 'vitest';
import {
  PATIENT_CHAT_ROLES,
  chatRolesToDisplay,
  chatRoleLabelKey,
} from '../patientChatRole';

describe('patientChatRole', () => {
  it('tem os três papéis, com o do plano de saúde por último', () => {
    expect(PATIENT_CHAT_ROLES).toEqual(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']);
  });

  describe('chatRolesToDisplay', () => {
    it('sem vínculo nenhum, mostra o catálogo inteiro na ordem', () => {
      expect(chatRolesToDisplay({})).toEqual(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']);
    });

    it.each([[null], [undefined]])('aceita %s sem quebrar', value => {
      expect(chatRolesToDisplay(value)).toEqual(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']);
    });

    it('acrescenta papel DESCONHECIDO que o backend já grava, no fim e ordenado', () => {
      expect(chatRolesToDisplay({ MANAGEMENT: 'a@g.us', AUDIT: 'b@g.us' })).toEqual([
        'FAMILY', 'PROVIDERS', 'HEALTH_PLAN', 'AUDIT', 'MANAGEMENT',
      ]);
    });

    it('não duplica um papel conhecido que também veio no mapa', () => {
      const out = chatRolesToDisplay({ FAMILY: 'a@g.us', HEALTH_PLAN: 'c@g.us' });
      expect(out).toEqual(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']);
      expect(new Set(out).size).toBe(out.length);
    });

    it('não muta o catálogo entre chamadas', () => {
      chatRolesToDisplay({ MANAGEMENT: 'a@g.us' });
      expect(chatRolesToDisplay({})).toEqual(['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']);
      expect(PATIENT_CHAT_ROLES).toHaveLength(3);
    });
  });

  describe('chatRoleLabelKey', () => {
    it('aponta para a chave do locale', () => {
      expect(chatRoleLabelKey('HEALTH_PLAN')).toBe(
        'admin.patients.detail.chatIdsCard.roles.HEALTH_PLAN',
      );
    });

    it('a chave carrega o próprio papel — quem chama cai no defaultValue', () => {
      expect(chatRoleLabelKey('MANAGEMENT')).toContain('MANAGEMENT');
    });
  });
});
