/**
 * occurrenceInputs — `readAssembledPatientIds` (spec 069, universo P13 do "Sin cubrir"): UMA consulta para todos os pacientes,
 * nenhuma quando não há paciente; devolve só quem tem linha em `patient_itinerary_assembly`.
 */
import { readAssembledPatientIds } from '../occurrenceInputs';

describe('readAssembledPatientIds', () => {
  it('sem pacientes → conjunto vazio e NENHUMA query', async () => {
    const client = { query: jest.fn() };
    expect(await readAssembledPatientIds(client as never, [])).toEqual(new Set());
    expect(client.query).not.toHaveBeenCalled();
  });

  it('UMA query no client com os ids; devolve o conjunto de quem tem montagem (o resto fica de fora)', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ patient_id: 'p-1' }, { patient_id: 'p-3' }] }) };

    const assembled = await readAssembledPatientIds(client as never, ['p-1', 'p-2', 'p-3']);

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM patient_itinerary_assembly WHERE patient_id = ANY\(\$1::uuid\[\]\)/);
    expect(String(sql)).not.toMatch(/UPDATE|INSERT|DELETE/);
    expect(params).toEqual([['p-1', 'p-2', 'p-3']]);
    expect([...assembled].sort()).toEqual(['p-1', 'p-3']);
    expect(assembled.has('p-2')).toBe(false);
  });
});
