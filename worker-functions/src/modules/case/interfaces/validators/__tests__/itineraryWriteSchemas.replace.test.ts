import { itineraryReplaceBodySchema } from '../itineraryWriteSchemas';

const UUID = '3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69';

describe('itineraryReplaceBodySchema', () => {
  it('replace: aceita newWorkerId, fromDate, reasonCategory e destination', () => {
    const body = { newWorkerId: UUID, fromDate: '2026-10-21', reasonCategory: 'OTHER', destination: 'RESERVE' };
    const r = itineraryReplaceBodySchema.safeParse(body);

    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(body);
  });

  it('replace: motivo e destino ausentes passam (422 é do caso de uso)', () => {
    const r = itineraryReplaceBodySchema.safeParse({ newWorkerId: UUID, fromDate: '2026-10-21' });

    expect(r.success).toBe(true);
  });

  it('replace: sem newWorkerId → falha (400)', () => {
    const r = itineraryReplaceBodySchema.safeParse({ fromDate: '2026-10-21', reasonCategory: 'OTHER', destination: 'RESERVE' });

    expect(r.success).toBe(false);
  });

  it('replace: reasonCategory numérico → falha', () => {
    const r = itineraryReplaceBodySchema.safeParse({ newWorkerId: UUID, fromDate: '2026-10-21', reasonCategory: 3 });

    expect(r.success).toBe(false);
  });
});
