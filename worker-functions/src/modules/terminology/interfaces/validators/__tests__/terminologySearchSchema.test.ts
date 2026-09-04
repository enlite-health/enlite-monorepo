import { terminologySearchQuerySchema } from '../terminologySearchSchema';

describe('terminologySearchQuerySchema (spec 016 F2)', () => {
  it('q obrigatório, lang/chapters opcionais, chapters vira array', () => {
    const ok = terminologySearchQuerySchema.safeParse({ q: 'esquisofrenia', lang: 'es', chapters: '06,08' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.chapters).toEqual(['06', '08']);
  });

  it('q ausente ou vazio recusa', () => {
    expect(terminologySearchQuerySchema.safeParse({}).success).toBe(false);
    expect(terminologySearchQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });

  it('lang fora de es|en recusa', () => {
    expect(terminologySearchQuerySchema.safeParse({ q: 'x', lang: 'pt' }).success).toBe(false);
  });

  it('sem chapters/lang: q sozinho basta', () => {
    const ok = terminologySearchQuerySchema.safeParse({ q: 'x' });
    expect(ok.success).toBe(true);
  });
});
