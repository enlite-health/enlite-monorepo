import {
  SUBSTITUTION_MAX_DAYS,
  substitutionCreateBodySchema,
  substitutionListQuerySchema,
  substitutionPreviewBodySchema,
  substitutionShiftBodySchema,
} from '../substitutionRequestSchemas';

const W = '55555555-5555-4555-8555-555555555555';
const SLOT = '66666666-6666-4666-8666-666666666666';
const base = { type: 'DAYS', outgoingWorkerId: W, from: '2026-11-02', to: '2026-11-13' };

describe('substitutionRequestSchemas', () => {
  it('list: when padrão upcoming, só upcoming|past', () => {
    expect(substitutionListQuerySchema.parse({})).toEqual({ when: 'upcoming' });
    expect(substitutionListQuerySchema.safeParse({ when: 'x' }).success).toBe(false);
  });

  describe('período', () => {
    const preview = (o: Record<string, unknown>) => substitutionPreviewBodySchema.safeParse({ ...base, candidateWorkerIds: [], ...o });
    it('DAYS exige `to`, `from <= to`, calendário real e no máximo 92 dias (inclusive)', () => {
      expect(preview({}).success).toBe(true);
      expect(preview({ to: undefined }).success).toBe(false);
      expect(preview({ to: '2026-11-01' }).success).toBe(false);
      expect(preview({ from: '2026-02-31' }).success).toBe(false);
      expect(preview({ from: '2026-01-01', to: '2026-04-02' }).success).toBe(true); // 92 dias
      expect(preview({ from: '2026-01-01', to: '2026-04-03' }).success).toBe(false); // 93
      expect(SUBSTITUTION_MAX_DAYS).toBe(92);
    });
    it('ONE_DAY: `to` ausente ou igual a `from` (normalizado para `to = from`); outro `to` é recusado', () => {
      const ok = preview({ type: 'ONE_DAY', to: undefined });
      expect(ok.success && ok.data.to).toBe('2026-11-02');
      expect(preview({ type: 'ONE_DAY', to: '2026-11-02' }).success).toBe(true);
      expect(preview({ type: 'ONE_DAY', to: '2026-11-03' }).success).toBe(false);
    });
    it('PERMANENT ainda não é aceito (F3); chave estranha é recusada (.strict)', () => {
      expect(preview({ type: 'PERMANENT' }).success).toBe(false);
      expect(preview({ extra: 1 }).success).toBe(false);
      expect(preview({ candidateWorkerIds: ['x'] }).success).toBe(false);
    });
  });

  describe('turno do pedido (P16)', () => {
    it('substituteWorkerId é OBRIGATÓRIO e nullable: uuid ou null; ausente ou string solta é recusado', () => {
      expect(substitutionShiftBodySchema.safeParse({ date: '2026-11-02', slotId: SLOT, substituteWorkerId: W }).success).toBe(true);
      expect(substitutionShiftBodySchema.safeParse({ date: '2026-11-02', slotId: SLOT, substituteWorkerId: null }).success).toBe(true);
      expect(substitutionShiftBodySchema.safeParse({ date: '2026-11-02', slotId: SLOT }).success).toBe(false);
      expect(substitutionShiftBodySchema.safeParse({ date: '2026-11-02', slotId: SLOT, substituteWorkerId: 'x' }).success).toBe(false);
      expect(substitutionShiftBodySchema.safeParse({ date: '2026-11-02', slotId: SLOT, substituteWorkerId: undefined }).success).toBe(false);
    });
  });

  it('create: motivo ausente NÃO é 400 (é 422 do caso de uso); turnos podem ser [] (período sem turno é 422 do caso de uso)', () => {
    expect(substitutionCreateBodySchema.safeParse({ ...base, shifts: [] }).success).toBe(true);
    expect(substitutionCreateBodySchema.safeParse({ ...base, reasonCategory: null, shifts: [] }).success).toBe(true);
    expect(substitutionCreateBodySchema.safeParse({ ...base }).success).toBe(false); // `shifts` é obrigatório
  });
});
