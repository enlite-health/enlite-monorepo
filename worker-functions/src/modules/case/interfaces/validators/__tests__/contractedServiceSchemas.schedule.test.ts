/**
 * contractedServiceSchemas — endereço (ponteiro) e horário do encuadre (migration 330).
 * O horário é o MESMO slot que a vaga persiste; `null` é "ainda sem horário" (Gabriel 05/09).
 */
import { createContractedServiceSchema, updateContractedServiceSchema } from '../contractedServiceSchemas';

const SLOT = { dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 };

describe('contractedServiceSchemas — addressId e schedule (migration 330)', () => {
  it('POST aceita addressId uuid + schedule válido; PATCH aceita os dois como null (limpar)', () => {
    const ok = createContractedServiceSchema.safeParse({ serviceCode: 'AT', addressId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', schedule: [SLOT] });
    expect(ok.success).toBe(true);
    const cleared = updateContractedServiceSchema.safeParse({ addressId: null, schedule: null });
    expect(cleared.success).toBe(true);
    expect(cleared.success && cleared.data).toEqual({ addressId: null, schedule: null });
  });

  it('schedule [] vira null na borda — "sem horário" tem UMA representação (NULL), nunca "[]" (gate 06/09)', () => {
    const r = updateContractedServiceSchema.safeParse({ schedule: [] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.schedule).toBeNull();
    const c = createContractedServiceSchema.safeParse({ serviceCode: 'AT', schedule: [] });
    expect(c.success && c.data.schedule).toBeNull();
    // null e ausente seguem como estão.
    expect(updateContractedServiceSchema.safeParse({ schedule: null }).success && updateContractedServiceSchema.parse({ schedule: null }).schedule).toBeNull();
    expect('schedule' in updateContractedServiceSchema.parse({})).toBe(false);
  });

  it('aceita durationMinutes 720 (turno noturno) e 1440 (24 h)', () => {
    for (const durationMinutes of [720, 1440]) {
      const r = updateContractedServiceSchema.safeParse({ schedule: [{ dayOfWeek: 1, startTime: '20:00', durationMinutes }] });
      expect(r.success).toBe(true);
    }
  });

  it('recusa endTime (.strict): o fim nunca entra pela API', () => {
    const slot = { dayOfWeek: 1, startTime: '20:00', durationMinutes: 720, endTime: '08:00' };
    expect(updateContractedServiceSchema.safeParse({ schedule: [slot] }).success).toBe(false);
    expect(createContractedServiceSchema.safeParse({ serviceCode: 'AT', schedule: [slot] }).success).toBe(false);
  });

  it('addressId que não é uuid → recusado', () => {
    expect(createContractedServiceSchema.safeParse({ serviceCode: 'AT', addressId: 'nao-uuid' }).success).toBe(false);
  });

  it.each([
    ['hora fora de HH:MM', { ...SLOT, startTime: '8h' }],
    ['24:00 não existe', { ...SLOT, startTime: '24:00' }],
    ['duração 0', { ...SLOT, durationMinutes: 0 }],
    ['duração 1441', { ...SLOT, durationMinutes: 1441 }],
    ['duração fracionária', { ...SLOT, durationMinutes: 90.5 }],
    ['sem durationMinutes', { dayOfWeek: 1, startTime: '08:00' }],
    ['dia 7', { ...SLOT, dayOfWeek: 7 }],
    ['dia negativo', { ...SLOT, dayOfWeek: -1 }],
    ['dia fracionário', { ...SLOT, dayOfWeek: 1.5 }],
    ['chave a mais (strict)', { ...SLOT, extra: 1 }],
  ])('slot inválido (%s) → recusado no POST e no PATCH', (_label, slot) => {
    expect(createContractedServiceSchema.safeParse({ serviceCode: 'AT', schedule: [slot] }).success).toBe(false);
    expect(updateContractedServiceSchema.safeParse({ schedule: [slot] }).success).toBe(false);
  });

  it('mais de 50 slots → recusado (teto)', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ dayOfWeek: i % 7, startTime: '08:00', durationMinutes: 60 }));
    expect(updateContractedServiceSchema.safeParse({ schedule: many }).success).toBe(false);
  });
});
