/**
 * PatientVacanciesQueryHelper (spec 047, F4) — `GET /patients/:id/vacancies` devolve `caseOrdinal` e o caso
 * EFETIVO do paciente (fragmento com dono, spec 046), o mesmo da ficha e da lista de vagas. Pool mockado; o e2e de
 * tela `vacante-em-servico-047-bloco` prova com banco real.
 */
import type { Pool } from 'pg';
import { fetchPatientVacancies } from '../PatientVacanciesQueryHelper';
import { VACANCY_CASE_NUMBER_SQL } from '@shared/sql/vacancyCaseNumberSql';
import { cicloDeVidaSql } from '@modules/matching/domain/vacancyLifecycle';

const pool = (rows: unknown[]) => ({ query: jest.fn().mockResolvedValue({ rows }) } as unknown as Pool & { query: jest.Mock });
const ROW = { id: 'v1', caseNumber: '1234', caseOrdinal: '2', vacancyNumber: '77', title: 'T', status: 'SEARCHING', isDraft: true, contractedServiceId: 'svc-1', createdAt: new Date('2026-09-01') };

describe('fetchPatientVacancies', () => {
  it('devolve caseOrdinal (número) e caseNumber (número); o SQL lê o caso do PACIENTE pelo fragmento com dono e o ordinal da vaga', async () => {
    const p = pool([ROW]);
    const [v] = await fetchPatientVacancies(p, 'pat-1');
    expect(v).toEqual({ id: 'v1', caseNumber: 1234, caseOrdinal: 2, vacancyNumber: 77, title: 'T', status: 'SEARCHING', isDraft: true, contractedServiceId: 'svc-1', createdAt: ROW.createdAt, lifecycle: null });
    const [sql, params] = p.query.mock.calls[0];
    expect(params).toEqual(['pat-1']);
    expect(sql).toContain(`${VACANCY_CASE_NUMBER_SQL} AS "caseNumber"`);
    expect(sql).toContain('jp.case_ordinal  AS "caseOrdinal"');
    expect(sql).toContain('jp.contracted_service_id AS "contractedServiceId"');
    expect(sql).toContain('LEFT JOIN patients p ON p.id = jp.patient_id');
    expect(sql).not.toContain('jp.case_number');
    expect(sql).toContain('jp.deleted_at IS NULL');
  });

  it('estado-automatico F2 (D3): o estado do paciente é p.status por JOIN (nunca coluna de job_postings) e o ciclo sai do SQL do dono', async () => {
    const p = pool([{ ...ROW, lifecycle: 'rascunho', patientStatus: 'SEARCHING' }]);
    const [v] = await fetchPatientVacancies(p, 'pat-1');
    expect(v).toMatchObject({ lifecycle: 'rascunho', patientStatus: 'SEARCHING' });
    const [sql] = p.query.mock.calls[0];
    expect(sql).toContain('p.status         AS "patientStatus"');
    expect(sql).not.toMatch(/jp\.status\s+AS\s+"patientStatus"/);
    expect(sql).toContain(`${cicloDeVidaSql('jp')} AS "lifecycle"`);
    // paciente legado sem estado: sem a chave
    const [semEstado] = await fetchPatientVacancies(pool([{ ...ROW, lifecycle: 'aberta', patientStatus: null }]), 'pat-1');
    expect(semEstado).not.toHaveProperty('patientStatus');
  });

  it('A3: vaga legada (case_ordinal NULL) e sem caso visível → null nos dois, sem quebrar; isDraft só é true se for true', async () => {
    const [v] = await fetchPatientVacancies(pool([{ ...ROW, caseNumber: null, caseOrdinal: null, vacancyNumber: null, isDraft: null }]), 'pat-1');
    expect(v).toMatchObject({ caseNumber: null, caseOrdinal: null, vacancyNumber: null, isDraft: false });
  });
});
