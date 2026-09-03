/**
 * PatientService.updatePatientSection — seções do bloco B (spec 012):
 *   'coverage' → escalares (health_insurance_name, affiliate_id) pelo update parcial do geral +
 *                verificadas por código pelo PatientInsuranceVerifiedRepository (só quando a chave veio);
 *   'clinical' → deviceTypes (códigos) pelo PatientDeviceTypeRepository (só quando a chave veio);
 *   'general'  → serviceStartDate entra na whitelist (service_start_date).
 */
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown> = async () => ({ rows: [], rowCount: 0 });
const mockClient = { query: jest.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params)), release: jest.fn() };
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({})), getClient: jest.fn().mockResolvedValue(mockClient) })) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({ KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: jest.fn(async (v: string | null) => v), decrypt: jest.fn() })) }));
jest.mock('../../infrastructure/PatientIdentityRepository', () => ({ PatientIdentityRepository: jest.fn().mockImplementation(() => ({})) }));
const mockClinicalUpsert = jest.fn().mockResolvedValue(undefined);
jest.mock('../../infrastructure/PatientClinicalRepository', () => ({ PatientClinicalRepository: jest.fn().mockImplementation(() => ({ upsert: (...a: unknown[]) => mockClinicalUpsert(...a) })) }));
jest.mock('../../infrastructure/PatientResponsibleRepository', () => ({ PatientResponsibleRepository: jest.fn().mockImplementation(() => ({})) }));
const mockReplaceDevices = jest.fn().mockResolvedValue({ changed: true, codes: [] });
jest.mock('../../infrastructure/PatientDeviceTypeRepository', () => ({ PatientDeviceTypeRepository: jest.fn().mockImplementation(() => ({ replaceCodesForPatient: (...a: unknown[]) => mockReplaceDevices(...a) })) }));
const mockReplaceCodes = jest.fn().mockResolvedValue({ codes: [] });
jest.mock('../../infrastructure/PatientInsuranceVerifiedRepository', () => ({ PatientInsuranceVerifiedRepository: jest.fn().mockImplementation(() => ({ replaceCodesForPatient: (...a: unknown[]) => mockReplaceCodes(...a) })) }));
jest.mock('../../../../infrastructure/services/GeocodingService', () => ({ GeocodingService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('firebase-functions', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { PatientService } from '../PatientService';

const PID = 'pid-b';
const sqls = () => mockClient.query.mock.calls.map(([s]) => String(s));

describe('PatientService.updatePatientSection — bloco B', () => {
  let service: PatientService;
  beforeEach(() => { jest.clearAllMocks(); service = new PatientService(); });

  it('coverage: escalares no UPDATE parcial + códigos no repositório, na MESMA transação', async () => {
    await service.updatePatientSection(PID, 'coverage', { healthInsuranceName: 'OSDE 210', affiliateId: null, insuranceVerifiedCodes: ['OSDE', 'SWISS_MEDICAL'] });
    const upd = mockClient.query.mock.calls.find(([s]) => /^UPDATE patients SET/.test(String(s)));
    // a ordem é a da whitelist do update geral (affiliate_id vem antes de health_insurance_name)
    expect(upd?.[0]).toMatch(/affiliate_id = \$2, health_insurance_name = \$3/);
    expect(upd?.[1]).toEqual([PID, null, 'OSDE 210']);
    expect(mockReplaceCodes).toHaveBeenCalledWith(PID, ['OSDE', 'SWISS_MEDICAL'], mockClient);
    expect(sqls()[0]).toBe('BEGIN'); expect(sqls().at(-1)).toBe('COMMIT');
  });

  it('coverage: sem códigos não toca o repositório; sem escalares não emite UPDATE', async () => {
    await service.updatePatientSection(PID, 'coverage', { affiliateId: 'AF-1' });
    expect(mockReplaceCodes).not.toHaveBeenCalled();
    expect(sqls().some((s) => /^UPDATE patients SET affiliate_id/.test(s))).toBe(true);
    jest.clearAllMocks();
    await service.updatePatientSection(PID, 'coverage', { insuranceVerifiedCodes: [] });
    expect(sqls().some((s) => /^UPDATE patients/.test(s))).toBe(false);
    expect(mockReplaceCodes).toHaveBeenCalledWith(PID, [], mockClient);
  });

  it('clinical: deviceTypes vai ao repositório de dispositivo (só quando a chave veio); o upsert clínico NÃO recebe deviceType', async () => {
    await service.updatePatientSection(PID, 'clinical', { diagnosis: 'x', deviceTypes: ['HOME', 'SCHOOL'] }, { uid: 'u1' });
    expect(mockReplaceDevices).toHaveBeenCalledWith(PID, ['HOME', 'SCHOOL'], mockClient);
    expect(mockClinicalUpsert.mock.calls[0][0]).not.toHaveProperty('deviceType');
    expect(mockClinicalUpsert.mock.calls[0][0]).toMatchObject({ patientId: PID, diagnosis: 'x', actorUid: 'u1' });
    jest.clearAllMocks();
    await service.updatePatientSection(PID, 'clinical', { diagnosis: 'y' });
    expect(mockReplaceDevices).not.toHaveBeenCalled();
  });

  it('general: serviceStartDate entra na whitelist como service_start_date (null limpa)', async () => {
    const d = new Date('2026-09-15T00:00:00Z');
    await service.updatePatientSection(PID, 'general', { serviceStartDate: d });
    const upd = mockClient.query.mock.calls.find(([s]) => /^UPDATE patients SET/.test(String(s)));
    expect(upd?.[0]).toMatch(/service_start_date = \$2/);
    expect(upd?.[1]).toEqual([PID, d]);
  });

  it('erro no repositório de códigos → ROLLBACK e propaga', async () => {
    mockReplaceCodes.mockRejectedValueOnce(new Error('unknown code'));
    await expect(service.updatePatientSection(PID, 'coverage', { insuranceVerifiedCodes: ['X'] })).rejects.toThrow('unknown code');
    expect(sqls().at(-1)).toBe('ROLLBACK');
  });
});
