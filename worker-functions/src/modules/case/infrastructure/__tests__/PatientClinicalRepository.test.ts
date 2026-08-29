import type { Pool, PoolClient } from 'pg';
import { PatientClinicalRepository } from '../PatientClinicalRepository';

/**
 * PatientClinicalRepository — SQL emitido pelo upsert (REQ-01 · migration 286).
 * Régua sobre o comando e os parâmetros: a autoria de additional_comments só
 * muda quando o campo VEIO no input ($12=true), e grava o uid ($13), nunca o valor.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('PatientClinicalRepository.upsert', () => {
  beforeEach(() => { mockPoolQuery.mockReset().mockResolvedValue({ rows: [] }); });

  it('additionalComments presente → $12=true e $13=uid (autoria gravada na MESMA query do UPDATE)', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, additionalComments: 'Texto clínico', actorUid: 'uid-staff-1' });

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toMatch(/additional_comments_updated_at = CASE WHEN \$12::boolean THEN NOW\(\)/);
    expect(sql).toMatch(/additional_comments_updated_by = CASE WHEN \$12::boolean THEN \$13/);
    expect(params[0]).toBe(PATIENT);
    expect(params[6]).toBe('Texto clínico');
    expect(params[11]).toBe(true);
    expect(params[12]).toBe('uid-staff-1');
  });

  it('additionalComments ausente → $12=false: a autoria anterior é preservada (CASE ELSE)', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, diagnosis: 'F84.0', actorUid: 'uid-staff-1' });

    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toMatch(/ELSE additional_comments_updated_at END/);
    expect(sql).toMatch(/ELSE additional_comments_updated_by END/);
    expect(params[11]).toBe(false);
  });

  it('additionalComments = null (limpar) conta como "veio": autoria registrada; sem actor → $13 null', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, additionalComments: null });

    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params[6]).toBeNull();
    expect(params[11]).toBe(true);
    expect(params[12]).toBeNull();
  });

  it('usa o client transacional quando fornecido (mesma transação do PATCH)', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query: clientQuery } as unknown as PoolClient;
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, serviceType: [], additionalComments: 'x' }, client);

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    // serviceType [] vira NULL (regra existente, migration 139)
    expect(clientQuery.mock.calls[0][1][4]).toBeNull();
  });

  it('findByPatientId devolve null quando não há linha e mapeia quando há', async () => {
    const repo = new PatientClinicalRepository();
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.findByPatientId(PATIENT)).toBeNull();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ patientId: PATIENT, diagnosis: 'F84', additionalComments: 't' }] });
    const row = await repo.findByPatientId(PATIENT);
    expect(row).toMatchObject({ patientId: PATIENT, diagnosis: 'F84' });
  });
});
