/**
 * Teste golden para as 7 células da Spec 022 (chat interno por paciente + sino de notificações,
 * Bloco 4 — T408 estende as 5 originais do B1 com `own_notifications:read|update`).
 *
 * A célula `patient_conversation:*` é a PORTA do chat privado — sem ela não há
 * vista, não há permissão de criar/editar/apagar. Este teste reprova se qualquer
 * uma delas sumir do catálogo ou ficar sem descrição, garantindo rastreabilidade
 * da decisão de acesso.
 */

import { CELL_DESCRIPTION, RESOURCE_CATEGORY, cellKey } from '../PermissionCell';

describe('Chat Interno — Células de Conversa (Spec 022)', () => {
  const conversationCells = ['read', 'create', 'update', 'delete'];

  it('patient_conversation é recurso conhecido em categoria Pacientes', () => {
    expect(RESOURCE_CATEGORY.patient_conversation).toBe('Pacientes');
  });

  it('as 4 ações do patient_conversation têm definição escrita e não-vazia', () => {
    for (const action of conversationCells) {
      const key = cellKey('patient_conversation', action);
      expect(CELL_DESCRIPTION[key]?.trim().length ?? 0).toBeGreaterThan(40);
    }
  });

  it('patient_conversation:read nomeia DADO DE SAÚDE na definição', () => {
    const d = CELL_DESCRIPTION[cellKey('patient_conversation', 'read')].toLowerCase();
    expect(d).toContain('saúde');
  });

  it('staff_directory é recurso conhecido em categoria Administração', () => {
    expect(RESOURCE_CATEGORY.staff_directory).toBe('Administração');
  });

  it('staff_directory:read tem definição escrita e não-vazia', () => {
    const key = cellKey('staff_directory', 'read');
    expect(CELL_DESCRIPTION[key]?.trim().length ?? 0).toBeGreaterThan(20);
  });

  it('nenhuma célula de conversation/staff_directory/own_notifications fica sem definição', () => {
    const recursos = ['patient_conversation', 'staff_directory', 'own_notifications'];
    const semDefinicao = recursos.filter(
      (r) => !Object.keys(CELL_DESCRIPTION).some((k) => k.startsWith(`${r}:`)),
    );
    expect(semDefinicao).toEqual([]);
  });

  describe('own_notifications (Bloco 4, T408 — D-07: nasce concedida a TODO staff, diferente de patient_conversation)', () => {
    const ownNotificationCells = ['read', 'update'];

    it('own_notifications é recurso conhecido em categoria Administração', () => {
      expect(RESOURCE_CATEGORY.own_notifications).toBe('Administração');
    });

    it('as 2 ações do own_notifications têm definição escrita e não-vazia', () => {
      for (const action of ownNotificationCells) {
        const key = cellKey('own_notifications', action);
        expect(CELL_DESCRIPTION[key]?.trim().length ?? 0).toBeGreaterThan(40);
      }
    });

    it('own_notifications:read/update nomeiam D-07 ou D-24 na definição (rastreio da decisão)', () => {
      for (const action of ownNotificationCells) {
        const d = CELL_DESCRIPTION[cellKey('own_notifications', action)];
        expect(d).toMatch(/D-07|D-24/);
      }
    });
  });
});
