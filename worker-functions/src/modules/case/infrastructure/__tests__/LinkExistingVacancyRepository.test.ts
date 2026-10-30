/**
 * LinkExistingVacancyRepository (spec 079 T015) — client mockado; o SQL real é provado pelo e2e de API.
 */
import type { PoolClient } from 'pg';
import { LinkExistingVacancyRepository } from '../LinkExistingVacancyRepository';
import { VACANCY_SERVICE_OWNED_COLUMNS } from '../../domain/LinkExistingVacancyPlan';

function cliente(rows: unknown[] = [], rowCount = rows.length) {
  const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows, rowCount }));
  return { client: { query } as unknown as PoolClient, query };
}
const repo = new LinkExistingVacancyRepository();
const sqlOf = (q: jest.Mock, i = 0) => String(q.mock.calls[i][0]);

describe('LinkExistingVacancyRepository', () => {
  const RAW = {
    id: 'v1', patient_id: 'p1', contracted_service_id: null, deleted_at: null, status: 'SEARCHING',
    required_professions: ['AT'], required_experience: 'x', work_schedule: 'flexible', payment_day: '5',
    required_sex: 'BOTH', providers_needed: '2', age_range_min: 20, age_range_max: 40, schedule: { a: 1 },
    patient_address_id: 'addr-1',
  };

  it('readVacancyForLink mapeia para os nomes dos tipos, com colunas explícitas', async () => {
    const { client, query } = cliente([RAW]);
    const v = await repo.readVacancyForLink(client, 'v1', { forUpdate: false });
    expect(v).toMatchObject({ id: 'v1', patientId: 'p1', contractedServiceId: null, deletedAt: null, status: 'SEARCHING', patient_address_id: 'addr-1', providers_needed: '2' });
    const sql = sqlOf(query);
    expect(sql).toContain('FROM job_postings');
    expect(sql).toContain('patient_address_id');
    expect(sql).not.toContain('*');
    expect(query.mock.calls[0][1]).toEqual(['v1']);
  });

  it('readVacancyForLink: FOR UPDATE só com forUpdate', async () => {
    const a = cliente([RAW]);
    await repo.readVacancyForLink(a.client, 'v1', { forUpdate: true });
    expect(sqlOf(a.query)).toContain('FOR UPDATE');
    const b = cliente([RAW]);
    await repo.readVacancyForLink(b.client, 'v1', { forUpdate: false });
    expect(sqlOf(b.query)).not.toContain('FOR UPDATE');
  });

  it('readVacancyForLink: inexistente -> null', async () => {
    const { client } = cliente([], 0);
    expect(await repo.readVacancyForLink(client, 'nope', { forUpdate: true })).toBeNull();
  });

  it('readServiceLinkTarget lê só provider_age_band', async () => {
    const { client, query } = cliente([{ provider_age_band: 'ADULT' }]);
    expect(await repo.readServiceLinkTarget(client, 's1')).toEqual({ provider_age_band: 'ADULT' });
    expect(sqlOf(query)).toContain('provider_age_band');
    expect(sqlOf(query)).toContain('patient_contracted_services');
    expect(await repo.readServiceLinkTarget(cliente([], 0).client, 's1')).toBeNull();
  });

  it('feedService({}) não faz query', async () => {
    const { client, query } = cliente();
    await repo.feedService(client, 's1', {}, 'uid-1');
    expect(query).toHaveBeenCalledTimes(0);
  });

  it('feedService com 2 campos usa só os 2 (+ updated_by + updated_at), parâmetros posicionais', async () => {
    const { client, query } = cliente();
    await repo.feedService(client, 's1', { payment_day: '5', providers_needed: 3 }, 'uid-1');
    expect(query).toHaveBeenCalledTimes(1);
    const sql = sqlOf(query);
    expect(sql).toContain('UPDATE patient_contracted_services SET payment_day = $2, providers_needed = $3, updated_by = $4, updated_at = NOW() WHERE id = $1');
    expect(sql).not.toContain('work_schedule');
    expect(query.mock.calls[0][1]).toEqual(['s1', '5', 3, 'uid-1']);
  });

  it('feedService grava updated_by = $n com o uid do ator (último parâmetro), só quando há feed', async () => {
    const { client, query } = cliente();
    await repo.feedService(client, 's1', { work_schedule: 'L-V' }, 'uid-ator');
    const sql = sqlOf(query);
    expect(sql).toMatch(/updated_by = \$3, updated_at = NOW\(\)/);
    expect(query.mock.calls[0][1]).toEqual(['s1', 'L-V', 'uid-ator']);
  });

  it('linkVacancyAndClear: 1 única query, 9 colunas = NULL, nunca salary_text/worker_profile_sought/patient_address_id', async () => {
    const { client, query } = cliente([], 1);
    const n = await repo.linkVacancyAndClear(client, 'v1', 's1');
    expect(n).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = sqlOf(query);
    for (const c of VACANCY_SERVICE_OWNED_COLUMNS) expect(sql).toContain(`${c} = NULL`);
    expect(VACANCY_SERVICE_OWNED_COLUMNS).toHaveLength(9);
    expect(sql).toContain('contracted_service_id = $2');
    expect(sql).toContain('contracted_service_id IS NULL AND deleted_at IS NULL');
    for (const proibido of ['salary_text', 'worker_profile_sought', 'patient_address_id']) expect(sql).not.toContain(proibido);
    expect(query.mock.calls[0][1]).toEqual(['v1', 's1']);
  });

  it('linkVacancyAndClear devolve 0 quando ninguém foi atualizado', async () => {
    const { client } = cliente([], 0);
    expect(await repo.linkVacancyAndClear(client, 'v1', 's1')).toBe(0);
  });

  it('listPatientVacanciesForLink usa o client recebido', async () => {
    const { client, query } = cliente([]);
    await repo.listPatientVacanciesForLink(client, 'p1');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['p1']);
  });
});
