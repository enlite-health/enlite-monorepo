/**
 * MoveReason — catálogo de rótulo das opções do motivo obrigatório (DX-4.11), Fase 4. As listas
 * são as MESMAS da API (`WF/domain/moveReason.ts`, DX-4.4/DX-4.6) — o front nunca decide "o que é
 * salto"; um descompasso aqui só quebra o teste do domínio, não uma tela.
 */
import { describe, it, expect } from 'vitest';
import {
  MoveReasonKind,
  MOVE_REASON_OPTIONS,
  MOVE_REASON_REQUIRED,
  REJECTION_REASON_OPTIONS,
  isMoveReasonKind,
} from '../MoveReason';

describe('MoveReason (DX-4.4, DX-4.6, DX-4.11)', () => {
  it('REJECTION_REASON_OPTIONS: as 9 categorias de rejeição de hoje (saiu de RejectionReasonSelect.tsx)', () => {
    expect([...REJECTION_REASON_OPTIONS]).toEqual([
      'DISTANCE', 'SCHEDULE_INCOMPATIBLE', 'INSUFFICIENT_EXPERIENCE', 'SALARY_EXPECTATION',
      'WORKER_DECLINED', 'OVERQUALIFIED', 'DEPENDENCY_MISMATCH', 'TALENTUM_NOT_QUALIFIED', 'OTHER',
    ]);
  });

  it('MOVE_REASON_OPTIONS: as três listas literais da DX-4.4, mesmas do domínio da API (P6)', () => {
    expect([...MOVE_REASON_OPTIONS.JUMP]).toEqual([
      'ENCUADRE_ANTECIPADO', 'REAPROVEITADO_DE_OUTRA_VAGA', 'INDICACAO_DA_EQUIPE', 'OTHER',
    ]);
    expect([...MOVE_REASON_OPTIONS.ENTER_REJECTED]).toEqual([...REJECTION_REASON_OPTIONS]);
    expect([...MOVE_REASON_OPTIONS.LEAVE_REJECTED]).toEqual(['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER']);
  });

  it('união das três listas = 14 valores (OTHER uma vez, DX-4.4)', () => {
    const uniao = new Set([
      ...MOVE_REASON_OPTIONS.JUMP,
      ...MOVE_REASON_OPTIONS.ENTER_REJECTED,
      ...MOVE_REASON_OPTIONS.LEAVE_REJECTED,
    ]);
    expect(uniao.size).toBe(14);
  });

  it('MOVE_REASON_REQUIRED é o código do 422 que o front reage (DX-4.6/DX-4.10)', () => {
    expect(MOVE_REASON_REQUIRED).toBe('MOVE_REASON_REQUIRED');
  });

  it('isMoveReasonKind reconhece só os 3 kinds do backend', () => {
    const kinds: MoveReasonKind[] = ['JUMP', 'ENTER_REJECTED', 'LEAVE_REJECTED'];
    for (const kind of kinds) {
      expect(isMoveReasonKind(kind)).toBe(true);
    }
    expect(isMoveReasonKind('OTHER')).toBe(false);
    expect(isMoveReasonKind(undefined)).toBe(false);
    expect(isMoveReasonKind(null)).toBe(false);
  });
});
