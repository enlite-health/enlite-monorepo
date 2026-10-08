/**
 * PatientVacanciesQueryHelper (spec 047, F4) — `GET /patients/:id/vacancies` devolve `caseOrdinal` e o caso
 * EFETIVO do paciente (fragmento com dono, spec 046), o mesmo da ficha e da lista de vagas. Pool mockado; o e2e de
 * tela `vacante-em-servico-047-bloco` prova com banco real.
 */
import type { Pool } from 'pg';
import { fetchPatientVacancies } from '../PatientVacanciesQueryHelper';
import { VACANCY_CASE_NUMBER_SQL } from '@shared/sql/vacancyCaseNumberSql';

const pool = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue({ rows }) } as unknown as Pool & { query: jest.Mock });
const ROW = { id: 'v1', caseNumber: '1234', caseOrdinal: '2', vacancyNumber: '77', title: 'T', status: 'SEARCHING', isDraft: true, createdAt: new Date('2026-09-01') };

describe('fetchPatientVacancies', () => {
  it('devolve caseOrdinal (número) e caseNumber (número); o SQL lê o caso do PACIENTE pelo fragmento com dono e o ordinal da vaga', async () => {
    const p = pool([ROW]);
    const [v] = await fetchPatientVacancies(p, 'pat-1');
    expect(v).toEqual({ id: 'v1', caseNumber: 1234, caseOrdinal: 2, vacancyNumber: 77, title: 'T', status: 'SEARCHING', isDraft: true, createdAt: ROW.createdAt });
    const [sql, params] = p.query.mock.calls[0];
    expect(params).toEqual(['pat-1']);
    expect(sql).toContain(`${VACANCY_CASE_NUMBER_SQL} AS "caseNumber"`);
    expect(sql).toContain('jp.case_ordinal  AS "caseOrdinal"');
    expect(sql).toContain('LEFT JOIN patients p ON p.id = jp.patient_id');
    expect(sql).not.toContain('jp.case_number');
    expect(sql).toContain('jp.deleted_at IS NULL');
  });

  it('A3: vaga legada (case_ordinal NULL) e sem caso visível → null nos dois, sem quebrar; isDraft só é true se for true', async () => {
    const [v] = await fetchPatientVacancies(pool([{ ...ROW, caseNumber: null, caseOrdinal: null, vacancyNumber: null, isDraft: null }]), 'pat-1');
    expect(v).toMatchObject({ caseNumber: null, caseOrdinal: null, vacancyNumber: null, isDraft: false });
  });
});
