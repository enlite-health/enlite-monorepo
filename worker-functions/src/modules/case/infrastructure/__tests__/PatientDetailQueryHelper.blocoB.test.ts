/**
 * fetchPatientDetail — campos do bloco B (spec 012): admission_status / on_hold_* / service_start_date,
 * cobertura verificada por CÓDIGO e dispositivos como arrays na ordem do catálogo, e a logística por
 * endereço (neighborhood / logistics_corridor / access_notes / country). Defaults quando a linha
 * vem sem eles (API anterior às migrations 311-317).
 */
import type { Pool } from 'pg';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { fetchPatientDetail } from '../PatientDetailQueryHelper';

function pool(main: Record<string, unknown>, address: Record<string, unknown>): { pool: Pool; query: jest.Mock } {
  const query = jest.fn()
    .mockResolvedValueOnce({ rows: [main] })
    .mockResolvedValueOnce({ rows: [] })            // responsibles
    .mockResolvedValueOnce({ rows: [address] })      // addresses
    .mockResolvedValueOnce({ rows: [] })            // professionals
    .mockResolvedValueOnce({ rows: [] })            // vacancies
    .mockResolvedValueOnce({ rows: [] })            // contracted services (spec 013, bloco C)
    .mockResolvedValueOnce({ rows: [] });           // coverage emergency contacts (417)
  return { pool: { query } as unknown as Pool, query };
}
const enc = { decrypt: jest.fn().mockResolvedValue(null) } as unknown as KMSEncryptionService;

describe('fetchPatientDetail — bloco B', () => {
  it('seleciona as colunas novas (SQL) e mapeia; a nota sai crua daqui (a redação é do ponto único)', async () => {
    const { pool: p, query } = pool(
      { id: 'p1', status: 'ON_HOLD', admissionStatus: 'DONE', onHoldReason: 'INSURER', onHoldNote: 'nota', serviceStartDate: new Date('2026-09-01'),
        insuranceVerifiedCodes: ['OSDE', 'SWISS_MEDICAL'],
        insuranceVerifiedEntries: [{ code: 'OSDE', source: 'clickup' }, { code: 'SWISS_MEDICAL', source: 'admin_manual' }],
        deviceTypes: ['HOME'], chatIds: {}, country: 'AR', needsAttention: false, attentionReasons: [] },
      { id: 'a1', address_type: 'domicilio_propio', address_type_other: null, is_default: true,
        address_formatted: 'Rua X', address_raw: null, complement: null, display_order: 1, lat: '-34.6', lng: '-58.4',
        neighborhood: 'Palermo', logistics_corridor: 'Norte', access_notes: 'timbre 2', country: 'AR' },
    );
    const out = await fetchPatientDetail(p, enc, 'p1');
    const sql = String(query.mock.calls[0][0]);
    for (const col of ['admission_status', 'on_hold_reason', 'on_hold_note', 'service_start_date', 'patient_insurance_verified', 'patient_device_types']) expect(sql).toContain(col);
    // QA 🟡3 (SUP-B5): a SQL também seleciona a união COM origem, para o drawer de cobertura.
    expect(sql).toContain('insuranceVerifiedEntries');
    expect(sql).toContain('piv.source');
    expect(String(query.mock.calls[2][0])).toMatch(/neighborhood, logistics_corridor, access_notes, country/);
    // Spec 019: address_type/address_type_other/is_default entram na SELECT de endereços.
    expect(String(query.mock.calls[2][0])).toMatch(/address_type, address_type_other, is_default/);
    expect(out).toMatchObject({
      admissionStatus: 'DONE', onHoldReason: 'INSURER', onHoldNote: 'nota',
      insuranceVerifiedCodes: ['OSDE', 'SWISS_MEDICAL'],
      insuranceVerifiedEntries: [{ code: 'OSDE', source: 'clickup' }, { code: 'SWISS_MEDICAL', source: 'admin_manual' }],
      deviceTypes: ['HOME'],
    });
    expect(out?.serviceStartDate).toEqual(new Date('2026-09-01'));
    expect(out?.addresses[0]).toMatchObject({
      neighborhood: 'Palermo', logisticsCorridor: 'Norte', accessNotes: 'timbre 2', country: 'AR', lat: -34.6, lng: -58.4,
      addressType: 'domicilio_propio', addressTypeOther: null, isPrimary: true,
    });
  });

  it('linha sem os campos novos → defaults (DONE, null, [], []) e endereço com nulls', async () => {
    const { pool: p } = pool(
      { id: 'p2', status: 'ACTIVE', chatIds: {}, country: 'AR', needsAttention: false, attentionReasons: [] },
      { id: 'a2', address_type: null, address_type_other: null, is_default: false, address_formatted: null, address_raw: 'cru', display_order: 2, lat: null, lng: null },
    );
    const out = await fetchPatientDetail(p, enc, 'p2');
    expect(out).toMatchObject({
      admissionStatus: 'DONE', onHoldReason: null, onHoldNote: null, serviceStartDate: null,
      insuranceVerifiedCodes: [], insuranceVerifiedEntries: [], deviceTypes: [],
    });
    expect(out?.addresses[0]).toMatchObject({ neighborhood: null, logisticsCorridor: null, accessNotes: null, country: null, complement: null, isPrimary: false });
  });
});
