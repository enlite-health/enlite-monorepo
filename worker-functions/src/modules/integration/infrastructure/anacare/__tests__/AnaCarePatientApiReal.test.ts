/**
 * AnaCarePatientApiReal.test.ts (2.2) — porta real de PACIENTE sobre o AnaCareSessionClient.
 * F13: documento/agência só vêm pelo `patient` aninhado no turno — por isso a porta itera
 * turnos crus da agência e deduplica por paciente, nunca chama `/api/patients/`.
 */
import { AnaCarePatientApiReal } from '../AnaCarePatientApiReal';
import type { AnaCareSessionClient } from '../AnaCareSessionClient';
import type { RawAnaCareShift } from '../AnaCareFieldMinimization';

function rawShift(patientId: number, overrides: Partial<RawAnaCareShift['patient']> = {}): RawAnaCareShift {
  return {
    id: patientId * 10,
    date: '2026-09-01',
    scheduled_start: 'a',
    scheduled_end: 'b',
    actual_start: null,
    actual_end: null,
    checkin_source: null,
    duration_hours: null,
    patient: {
      id: patientId,
      agency: 116,
      document_type: 'DNI',
      document_number: String(1000 + patientId),
      first_name: `Nome${patientId}`,
      last_name: `Sobrenome${patientId}`,
      phone: '__should_never_appear__',
      ...overrides,
    },
    nurse: { id: 900, agency: 116, first_name: 'N', last_name: 'M' },
  };
}

function makeClient(pages: RawAnaCareShift[][]): AnaCareSessionClient {
  return {
    async *iterateAgencyShiftsRaw() {
      for (const page of pages) yield page;
    },
  } as unknown as AnaCareSessionClient;
}

describe('AnaCarePatientApiReal', () => {
  it('deduplica pacientes por id ao longo de vários turnos/páginas', async () => {
    const client = makeClient([
      [rawShift(1), rawShift(1), rawShift(2)],
      [rawShift(2), rawShift(3)],
    ]);
    const api = new AnaCarePatientApiReal(client);

    const page = await api.fetchAllPatients();
    expect(page.records).toHaveLength(3);
    expect(page.records.map((r) => r.externalId).sort()).toEqual(['1', '2', '3']);
  });

  it('minimiza os campos do paciente — telefone nunca aparece em `fields`', async () => {
    const client = makeClient([[rawShift(1)]]);
    const api = new AnaCarePatientApiReal(client);

    const page = await api.fetchAllPatients();
    const serialized = JSON.stringify(page.records[0].fields);
    expect(serialized).not.toContain('__should_never_appear__');
    expect(Object.keys(page.records[0].fields).sort()).toEqual(
      ['id', 'agency', 'document_type', 'document_number', 'first_name', 'last_name'].sort(),
    );
  });

  it('expectedCount é null (a API não declara count por paciente — só por turno)', async () => {
    const client = makeClient([[rawShift(1)]]);
    const api = new AnaCarePatientApiReal(client);
    const page = await api.fetchAllPatients();
    expect(page.expectedCount).toBeNull();
  });
});
