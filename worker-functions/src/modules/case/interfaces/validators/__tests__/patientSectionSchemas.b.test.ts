/**
 * patientSectionSchemas — bloco B (spec 012):
 *   general  += serviceStartDate (US-B9)
 *   clinical  : `deviceType` (texto livre) SAI; `deviceTypes` (códigos do catálogo) ENTRA (US-B4)
 *   coverage  : seção NOVA — cobertura informada, verificadas por código, nº de afiliado (US-B3)
 *   support-network: `relationship` é ENUM (a coluna tem CHECK desde a 139) → 400, não 23514 (US-B5)
 *   status    : v2 + onHoldReason/onHoldNote (teto 2000 no servidor — lex C7.1-f)
 */
import {
  generalSectionSchema, clinicalSectionSchema, coverageSectionSchema, supportNetworkSectionSchema,
  patientStatusSchema, patientSectionParamSchema, SECTION_SCHEMAS,
} from '../patientSectionSchemas';

const ID = '11111111-1111-4111-8111-111111111111';

describe('patientSectionSchemas — bloco B', () => {
  it('general aceita serviceStartDate (data, nullable) e o coage para Date', () => {
    const ok = generalSectionSchema.safeParse({ serviceStartDate: '2026-09-01' });
    expect(ok.success).toBe(true);
    expect((ok as { data: { serviceStartDate: Date } }).data.serviceStartDate).toBeInstanceOf(Date);
    expect(generalSectionSchema.safeParse({ serviceStartDate: null }).success).toBe(true);
    expect(generalSectionSchema.safeParse({ serviceStartDate: 'não-é-data' }).success).toBe(false);
  });

  it('clinical: deviceType (texto livre) é recusado pelo .strict(); deviceTypes é array de códigos', () => {
    expect(clinicalSectionSchema.safeParse({ deviceType: 'Silla de ruedas' }).success).toBe(false);
    expect(clinicalSectionSchema.safeParse({ deviceTypes: ['HOME', 'SCHOOL'] }).success).toBe(true);
    expect(clinicalSectionSchema.safeParse({ deviceTypes: [] }).success).toBe(true);
    expect(clinicalSectionSchema.safeParse({ deviceTypes: ['casa'] }).success).toBe(false);   // forma do código, não catálogo
    expect(clinicalSectionSchema.safeParse({ deviceTypes: 'HOME' }).success).toBe(false);
  });

  it('coverage: healthInsuranceName, affiliateId, insuranceVerifiedCodes (códigos); chave estranha → recusa', () => {
    expect(coverageSectionSchema.safeParse({ healthInsuranceName: 'OSDE 210', affiliateId: '123', insuranceVerifiedCodes: ['OSDE', 'SWISS_MEDICAL'] }).success).toBe(true);
    expect(coverageSectionSchema.safeParse({ insuranceVerifiedCodes: ['swiss medical'] }).success).toBe(false);
    expect(coverageSectionSchema.safeParse({ affiliateId: null }).success).toBe(true);
    expect(coverageSectionSchema.safeParse({ taxCondition: 'IVA_21' }).success).toBe(false); // bloco C, não entra aqui
    expect(SECTION_SCHEMAS.coverage).toBe(coverageSectionSchema);
    expect(patientSectionParamSchema.safeParse({ id: ID, section: 'coverage' }).success).toBe(true);
  });

  it('coverage: emergencyContacts (417, D301) — kind fechado, nome ≤200, telefone ≤40, teto 20, chave estranha recusada; ausente = não toca', () => {
    const ok = { emergencyContacts: [{ kind: 'DIRECT_PROFESSIONAL', name: ' Dra. Pérez ', phone: '+54 11 5555-0001' }, { kind: 'AMBULANCE', name: 'Ambulancia', phone: '0800' }] };
    const parsed = coverageSectionSchema.safeParse(ok);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.emergencyContacts?.[0].name).toBe('Dra. Pérez'); // trim
    expect(coverageSectionSchema.safeParse({ emergencyContacts: [] }).success).toBe(true);
    expect(coverageSectionSchema.safeParse({ emergencyContacts: [{ kind: 'FAMILY', name: 'x', phone: '1' }] }).success).toBe(false);
    expect(coverageSectionSchema.safeParse({ emergencyContacts: [{ kind: 'AMBULANCE', name: '', phone: '1' }] }).success).toBe(false);
    expect(coverageSectionSchema.safeParse({ emergencyContacts: [{ kind: 'AMBULANCE', name: 'x', phone: '' }] }).success).toBe(false);
    expect(coverageSectionSchema.safeParse({ emergencyContacts: [{ kind: 'AMBULANCE', name: 'x'.repeat(201), phone: '1' }] }).success).toBe(false);
    expect(coverageSectionSchema.safeParse({ emergencyContacts: [{ kind: 'AMBULANCE', name: 'x', phone: '1'.repeat(41) }] }).success).toBe(false);
    expect(coverageSectionSchema.safeParse({ emergencyContacts: [{ kind: 'AMBULANCE', name: 'x', phone: '1', email: 'a@b.co' }] }).success).toBe(false);
    expect(coverageSectionSchema.safeParse({ emergencyContacts: Array.from({ length: 21 }, () => ({ kind: 'AMBULANCE', name: 'x', phone: '1' })) }).success).toBe(false);
    const semChave = coverageSectionSchema.safeParse({ affiliateId: 'A' });
    expect(semChave.success && semChave.data.emergencyContacts).toBeUndefined();
  });

  it('support-network: relationship só aceita os códigos da 139 (CHILD…OTHER) ou null', () => {
    const row = { firstName: 'Ana', lastName: 'Diaz', isPrimary: true, displayOrder: 0 };
    expect(supportNetworkSectionSchema.safeParse({ responsibles: [{ ...row, relationship: 'PARENT' }] }).success).toBe(true);
    expect(supportNetworkSectionSchema.safeParse({ responsibles: [{ ...row, relationship: null }] }).success).toBe(true);
    expect(supportNetworkSectionSchema.safeParse({ responsibles: [{ ...row, relationship: 'Madre' }] }).success).toBe(false);
  });

  it('status v2: seis estados; ON_HOLD leva motivo e nota (≤ 2000); DISCONTINUED recusado', () => {
    expect(patientStatusSchema.safeParse({ status: 'ON_HOLD', onHoldReason: 'SCHOOL', onHoldNote: 'x' }).success).toBe(true);
    expect(patientStatusSchema.safeParse({ status: 'SEARCHING' }).success).toBe(true);
    expect(patientStatusSchema.safeParse({ status: 'DISCONTINUED' }).success).toBe(false);
    expect(patientStatusSchema.safeParse({ status: 'ON_HOLD', onHoldReason: 'BUDGET' }).success).toBe(false);
    expect(patientStatusSchema.safeParse({ status: 'ON_HOLD', onHoldReason: 'OTHER', onHoldNote: 'x'.repeat(2001) }).success).toBe(false);
    expect(patientStatusSchema.safeParse({ status: 'ON_HOLD', onHoldReason: 'OTHER', onHoldNote: null }).success).toBe(true);
  });
});
