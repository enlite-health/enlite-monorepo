import { itineraryEndBodySchema } from '../itineraryWriteSchemas';

describe('itineraryEndBodySchema', () => {
  it('end: aceita cancelScheduled true/false/ausente', () => {
    const base = { reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE' };

    const t = itineraryEndBodySchema.safeParse({ ...base, cancelScheduled: true });
    const f = itineraryEndBodySchema.safeParse({ ...base, cancelScheduled: false });
    const a = itineraryEndBodySchema.safeParse(base);

    expect(t.success && t.data.cancelScheduled).toBe(true);
    expect(f.success && f.data.cancelScheduled).toBe(false);
    expect(a.success && a.data.cancelScheduled).toBeUndefined();
  });

  it('end: cancelScheduled string → falha (400)', () => {
    const r = itineraryEndBodySchema.safeParse({ reasonCategory: 'OTHER', destination: 'LEAVE_SERVICE', cancelScheduled: 'true' });

    expect(r.success).toBe(false);
  });
});
