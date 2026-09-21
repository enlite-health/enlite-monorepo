/**
 * Teste golden para as 5 células novas da Spec 022 (chat interno por paciente).
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

  it('nenhuma célula de conversation/staff_directory fica sem definição', () => {
    const recursos = ['patient_conversation', 'staff_directory'];
    const semDefinicao = recursos.filter(
      (r) => !Object.keys(CELL_DESCRIPTION).some((k) => k.startsWith(`${r}:`)),
    );
    expect(semDefinicao).toEqual([]);
  });
});
