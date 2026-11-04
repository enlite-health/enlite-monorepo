/**
 * R16 (spec 084): ligar uma vaga EXISTENTE a um serviço recalcula o case_ordinal NO MESMO UPDATE (a posição do serviço), com a
 * MESMA expressão do INSERT da vaga. Sem isso a vaga antiga ligada ficava com o número de outra época (#04 num paciente de 3 serviços).
 */
import { LinkExistingVacancyRepository } from '../LinkExistingVacancyRepository';
import { caseOrdinalFromServiceSql } from '@shared/sql/caseOrdinalSql';
import { CASE_ORDINAL_FROM_SERVICE_SQL } from '@modules/matching/interfaces/controllers/vacancyCrudHelpers';

describe('LinkExistingVacancyRepository.linkVacancyAndClear — case_ordinal do serviço', () => {
  it('UM UPDATE vincula, zera as colunas do serviço E grava a posição do serviço ($2)', async () => {
    const query = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    const n = await new LinkExistingVacancyRepository().linkVacancyAndClear({ query } as never, 'vaga-1', 'svc-2');
    expect(n).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain(`case_ordinal = ${caseOrdinalFromServiceSql('$2')}`);
    expect(sql).toMatch(/row_number\(\) OVER \(PARTITION BY patient_id ORDER BY created_at, id\)/);
    expect(sql).not.toMatch(/MAX\(/);
    expect(params).toEqual(['vaga-1', 'svc-2']);
  });

  it('a expressão é a MESMA do INSERT da vaga (fonte única)', () => {
    expect(CASE_ORDINAL_FROM_SERVICE_SQL).toBe(caseOrdinalFromServiceSql('$23'));
  });
});
