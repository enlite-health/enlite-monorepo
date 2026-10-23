import {
  SUBSTITUTION_MAX_DAYS,
  substitutionCoverBodySchema,
  substitutionCreateBodySchema,
  substitutionListQuerySchema,
  substitutionPreviewBodySchema,
  substitutionRequestParamsSchema,
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
      expect(ok.success && 'to' in ok.data && ok.data.to).toBe('2026-11-02');
      expect(preview({ type: 'ONE_DAY', to: '2026-11-02' }).success).toBe(true);
      expect(preview({ type: 'ONE_DAY', to: '2026-11-03' }).success).toBe(false);
    });
    it('PERMANENT: `from` = D e candidatos, SEM `to` (sem fim); `to` num permanente e chave estranha são recusados (.strict)', () => {
      const permanent = (o: Record<string, unknown>) => substitutionPreviewBodySchema.safeParse({ type: 'PERMANENT', outgoingWorkerId: W, from: '2026-11-02', candidateWorkerIds: [], ...o });
      expect(permanent({}).success).toBe(true);
      expect(permanent({ to: '2026-11-13' }).success).toBe(false);
      expect(permanent({ from: '2026-02-31' }).success).toBe(false);
      expect(preview({ extra: 1 }).success).toBe(false);
      expect(preview({ candidateWorkerIds: ['x'] }).success).toBe(false);
    });
    it('DIAS: `ignoreRequestId` ("Elegir quién entra") é uuid opcional; no permanente é chave estranha', () => {
      expect(preview({ ignoreRequestId: W }).success).toBe(true);
      expect(preview({ ignoreRequestId: 'x' }).success).toBe(false);
      expect(substitutionPreviewBodySchema.safeParse({ type: 'PERMANENT', outgoingWorkerId: W, from: '2026-11-02', candidateWorkerIds: [], ignoreRequestId: W }).success).toBe(false);
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

  describe('"No vuelve más" (PERMANENT) e os params/corpo das ações do pedido', () => {
    const permanent = (o: Record<string, unknown>) =>
      substitutionCreateBodySchema.safeParse({ type: 'PERMANENT', outgoingWorkerId: W, from: '2026-11-02', substituteWorkerId: null, ...o });
    it('substituteWorkerId é OBRIGATÓRIO e nullable (P16): uuid ou null; ausente ou string solta é 400', () => {
      expect(permanent({}).success).toBe(true);
      expect(permanent({ substituteWorkerId: W }).success).toBe(true);
      expect(permanent({ substituteWorkerId: undefined }).success).toBe(false);
      expect(permanent({ substituteWorkerId: 'x' }).success).toBe(false);
    });
    it('motivo e destino ausentes NÃO são 400 (422 do caso de uso); `to`/`shifts` num permanente e data inexistente são recusados', () => {
      expect(permanent({ reasonCategory: null, destination: null }).success).toBe(true);
      expect(permanent({ to: '2026-11-13' }).success).toBe(false);
      expect(permanent({ shifts: [] }).success).toBe(false);
      expect(permanent({ from: '2026-02-31' }).success).toBe(false);
    });
    it('params do pedido exigem uuid em id, sid e rid; cover exige UM substituteWorkerId uuid (.strict)', () => {
      expect(substitutionRequestParamsSchema.safeParse({ id: W, sid: SLOT, rid: W }).success).toBe(true);
      expect(substitutionRequestParamsSchema.safeParse({ id: W, sid: SLOT, rid: 'x' }).success).toBe(false);
      expect(substitutionCoverBodySchema.safeParse({ substituteWorkerId: W }).success).toBe(true);
      expect(substitutionCoverBodySchema.safeParse({}).success).toBe(false);
      expect(substitutionCoverBodySchema.safeParse({ substituteWorkerId: null }).success).toBe(false);
      expect(substitutionCoverBodySchema.safeParse({ substituteWorkerId: W, extra: 1 }).success).toBe(false);
    });
  });
});
