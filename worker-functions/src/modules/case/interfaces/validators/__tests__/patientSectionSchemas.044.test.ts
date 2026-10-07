/**
 * patientSectionSchemas — spec 044 (migration 500): `general` ganha o faturamento do paciente
 * (billingAddressFormatted/billingCity/billingProvince). Os 3 viajam juntos; `null` limpa.
 * Endereços de ficção.
 */
import { generalSectionSchema } from '../patientSectionSchemas';

describe('patientSectionSchemas — general += billing* (spec 044 A2)', () => {
  it('aceita os 3 campos preenchidos', () => {
    const r = generalSectionSchema.safeParse({
      billingAddressFormatted: '  Calle Falsa 123, Ciudad Ficticia  ',
      billingCity: 'Ciudad Ficticia',
      billingProvince: 'Provincia Ficticia',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.billingAddressFormatted).toBe('Calle Falsa 123, Ciudad Ficticia'); // trim
  });

  it('aceita null nos 3 (limpar) e a ausência dos 3 (facultativo)', () => {
    expect(generalSectionSchema.safeParse({
      billingAddressFormatted: null, billingCity: null, billingProvince: null,
    }).success).toBe(true);
    expect(generalSectionSchema.safeParse({ firstName: 'Nuevo' }).success).toBe(true);
  });

  it('aceita só o texto (cidade/província ausentes)', () => {
    expect(generalSectionSchema.safeParse({ billingAddressFormatted: 'Calle Falsa 123' }).success).toBe(true);
  });

  it('recusa cidade ou província SEM o texto (os 3 viajam juntos)', () => {
    expect(generalSectionSchema.safeParse({ billingCity: 'Ciudad Ficticia' }).success).toBe(false);
    expect(generalSectionSchema.safeParse({ billingProvince: 'Provincia Ficticia' }).success).toBe(false);
  });

  it('recusa string vazia e texto acima do teto', () => {
    expect(generalSectionSchema.safeParse({ billingAddressFormatted: '   ' }).success).toBe(false);
    expect(generalSectionSchema.safeParse({ billingAddressFormatted: 'x'.repeat(501) }).success).toBe(false);
  });

  it('não abre lat/lng: .strict() continua recusando coordenada no PATCH /general', () => {
    const r = generalSectionSchema.safeParse({ billingAddressFormatted: 'Calle Falsa 123', billingLat: 1, billingLng: 2 });
    expect(r.success).toBe(false);
  });
});
