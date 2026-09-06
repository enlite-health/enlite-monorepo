/**
 * contractedServiceSchemas — endereço (ponteiro) e horário do encuadre (migration 330).
 * O horário é o MESMO slot que a vaga persiste; `null` é "ainda sem horário" (Gabriel 05/09).
 */
import { createContractedServiceSchema, updateContractedServiceSchema } from '../contractedServiceSchemas';

const SLOT = { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' };

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

  it('addressId que não é uuid → recusado', () => {
    expect(createContractedServiceSchema.safeParse({ serviceCode: 'AT', addressId: 'nao-uuid' }).success).toBe(false);
  });

  it.each([
    ['hora fora de HH:MM', { ...SLOT, startTime: '8h' }],
    ['24:00 não existe', { ...SLOT, endTime: '24:00' }],
    ['início depois do fim', { ...SLOT, startTime: '14:00', endTime: '12:00' }],
    ['início igual ao fim', { ...SLOT, startTime: '12:00', endTime: '12:00' }],
    ['dia 7', { ...SLOT, dayOfWeek: 7 }],
    ['dia negativo', { ...SLOT, dayOfWeek: -1 }],
    ['dia fracionário', { ...SLOT, dayOfWeek: 1.5 }],
    ['chave a mais (strict)', { ...SLOT, extra: 1 }],
  ])('slot inválido (%s) → recusado no POST e no PATCH', (_label, slot) => {
    expect(createContractedServiceSchema.safeParse({ serviceCode: 'AT', schedule: [slot] }).success).toBe(false);
    expect(updateContractedServiceSchema.safeParse({ schedule: [slot] }).success).toBe(false);
  });

  it('mais de 50 slots → recusado (teto)', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ dayOfWeek: i % 7, startTime: '08:00', endTime: '09:00' }));
    expect(updateContractedServiceSchema.safeParse({ schedule: many }).success).toBe(false);
  });
});
