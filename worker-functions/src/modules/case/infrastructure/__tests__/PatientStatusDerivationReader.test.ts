/**
 * PatientStatusDerivationReader — cadeia Fase 15, DX-15.8: uma query no client recebido, com o lock
 * do paciente e o EXISTS da montagem; nenhuma coluna de PII/clínico.
 */
import type { PoolClient } from 'pg';
import { PatientStatusDerivationReader } from '../PatientStatusDerivationReader';

const PID = '33333333-3333-4333-8333-333333333333';

function clientCom(rows: unknown[]) {
  const query = jest.fn(async () => ({ rows, rowCount: rows.length }));
  return { query, client: { query } as unknown as PoolClient };
}

describe('PatientStatusDerivationReader', () => {
  const reader = new PatientStatusDerivationReader();

  it('UMA query no client recebido, com FOR UPDATE OF p e o EXISTS da montagem; o patientId no $1', async () => {
    const { query, client } = clientCom([{ status: 'SEARCHING', country: 'AR', montado: true }]);
    await reader.readSubjectWith(client, PID);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/FOR UPDATE OF p/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM patient_itinerary_assembly a WHERE a\.patient_id = p\.id\) AS montado/);
    expect(sql).toMatch(/p\.deleted_at IS NULL/);
    expect(params).toEqual([PID]);
  });

  it('mapeia o sujeito e `montado` como boolean (true e false)', async () => {
    await expect(reader.readSubjectWith(clientCom([{ status: 'ACTIVE', country: 'AR', montado: true }]).client, PID))
      .resolves.toEqual({ status: 'ACTIVE', country: 'AR', montado: true });
    await expect(reader.readSubjectWith(clientCom([{ status: null, country: 'BR', montado: false }]).client, PID))
      .resolves.toEqual({ status: null, country: 'BR', montado: false });
  });

  it('sem linha → null', async () => {
    await expect(reader.readSubjectWith(clientCom([]).client, PID)).resolves.toBeNull();
  });

  it('a SQL não lê nome, telefone nem diagnóstico', async () => {
    const { query, client } = clientCom([]);
    await reader.readSubjectWith(client, PID);
    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(/first_name|last_name|phone|diagnos/i.test(sql)).toBe(false);
  });
});
