/**
 * occurrenceInputs — `readAlertUniverseFacts` (spec 069, universo P13 do "Sin cubrir"): UMA consulta para todos os pacientes, nenhuma
 * quando não há paciente; devolve, por paciente, se o itinerário está montado e o estado atual (a regra é de `itineraryAlerts`).
 */
import { readAlertUniverseFacts } from '../occurrenceInputs';

describe('readAlertUniverseFacts', () => {
  it('sem pacientes → mapa vazio e NENHUMA query', async () => {
    const client = { query: jest.fn() };
    expect(await readAlertUniverseFacts(client as never, [])).toEqual(new Map());
    expect(client.query).not.toHaveBeenCalled();
  });

  it('UMA query no client com os ids; devolve montado + estado por paciente (soft-deletado/inexistente fica de fora)', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({
        rows: [
          { id: 'p-1', status: 'ACTIVE', assembled: true },
          { id: 'p-2', status: 'ACTIVE', assembled: false },
          { id: 'p-3', status: 'ON_HOLD', assembled: true },
        ],
      }),
    };

    const facts = await readAlertUniverseFacts(client as never, ['p-1', 'p-2', 'p-3', 'p-4']);

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM patient_itinerary_assembly a WHERE a\.patient_id = p\.id/);
    expect(String(sql)).toMatch(/p\.id = ANY\(\$1::uuid\[\]\) AND p\.deleted_at IS NULL/);
    expect(String(sql)).not.toMatch(/UPDATE|INSERT|DELETE/);
    expect(params).toEqual([['p-1', 'p-2', 'p-3', 'p-4']]);
    expect(facts.get('p-1')).toEqual({ itineraryAssembled: true, patientStatus: 'ACTIVE' });
    expect(facts.get('p-2')).toEqual({ itineraryAssembled: false, patientStatus: 'ACTIVE' });
    expect(facts.get('p-3')).toEqual({ itineraryAssembled: true, patientStatus: 'ON_HOLD' });
    expect(facts.has('p-4')).toBe(false);
  });
});
