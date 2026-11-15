import { PatientCountReader } from '../PatientCountReader';
import { excludeTestPatientSql } from '@shared/database/testRealmSql';

describe('PatientCountReader — paciente de teste fora da contagem (D664/D665)', () => {
  it.each([
    ['total', null],
    ['agrupada por has_provider', 'has_provider'],
  ])('contagem %s carrega o recorte is_test, pelo dono (testRealmSql)', async (_n, groupBy) => {
    const query = jest.fn().mockResolvedValue({ rows: groupBy ? [] : [{ n: 0 }] });
    await new PatientCountReader({ query }).count({ filters: [], group_by: groupBy }, ['AR']);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain(excludeTestPatientSql('p'));
  });
});
