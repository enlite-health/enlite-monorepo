/**
 * vacante-em-servico-047-api.e2e.test.ts @integration — spec 047, F2: a vaga viva do serviço contratado
 * chega à ficha com código, estado e link, REDIGIDA por `vacancy:read`.
 *
 * Postgres real, SQL real, sem mock. O paciente tem 3 serviços:
 *   A — 2 vagas vivas (a mais ANTIGA é a que vale), com link do site;
 *   B — sem vaga;
 *   C — 1 vaga viva SEM link do site (`social_short_links` vazio) → `siteUrl: null`.
 * A vaga nunca é lida de `jp.case_number` (a coluna fica NULL de propósito): o caso vem do PACIENTE
 * (fragmento com dono, spec 046) — se alguém voltar a ler a cópia, o `caseNumber` do teste vira null.
 *
 *  feliz  — admin, pelas DUAS rotas HTTP (`GET /patients/:id` e `/contracted-services`): objeto completo com as 5
 *           chaves, valor-hora cru, flags false; B → null + false; C → siteUrl null.
 *  alt 1  — "recrutador" SEM `patient_contract_value:read`, mas com `vacancy:read` (engine decidiu: células):
 *           valor redigido, vaga VISÍVEL — nas duas projeções reais. As chaves da vaga são EXATAMENTE as 5.
 *  alt 2  — perfil SEM `vacancy:read` (com o valor-hora): vaga redigida (null + true) no serviço A e C, e no B
 *           (sem vaga) também true — "sem permissão" não se confunde com "sem vaga"; o serviço continua visível.
 *
 * As células chegam como o `PermissionMiddleware` as penduraria (`req.permissionCells`), sobre os controllers/projeções
 * REAIS e o banco real — o CI roda este e2e com o engine ABAC desligado (rota por papel), onde só admin/recruiter existem.
 * Nenhum canal real: só Postgres; o Short.io nem é importado neste caminho de leitura.
 */
import { Pool } from 'pg';
import type { Request, Response } from 'express';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { AdminPatientContractedServicesController } from '@modules/case/interfaces/controllers/AdminPatientContractedServicesController';
import { PatientQueryRepository } from '@modules/case/infrastructure/PatientQueryRepository';
import { projectAdminPatientDetail } from '@modules/case/interfaces/AdminPatientView';
import { hourlyValueActorOf } from '@modules/case/application/contractedServiceHourlyValueAccess';
import { patientContainerReadsOf } from '@modules/case/application/patientContainerAccess';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK = `v047-api-${RUN}`;
const CASE_NUMBER = 940000 + (RUN % 50000);
const SITE = 'https://exemplo.test/x';
const CINCO_CHAVES = ['caseNumber', 'caseOrdinal', 'id', 'siteUrl', 'status'];

type Captured = { status: number; body: unknown };
function reqRes(params: Record<string, string>, roles: string[], cells: string[]): [Request, Response, Captured] {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: unknown) { captured.body = payload; return this; },
  } as unknown as Response;
  return [{ params, body: {}, query: {}, user: { roles }, permissionCells: cells } as unknown as Request, res, captured];
}

type Svc = { id: string; hourlyValue: number | null; hourlyValueRedacted: boolean; liveVacancy: Record<string, unknown> | null; liveVacancyRedacted: boolean };

describe('Vaga viva do serviço contratado, redigida por vacancy:read (spec 047 F2) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: { headers: { Authorization: string } };
  let patientId = '';
  const svc = { A: '', B: '', C: '' };
  const vaga = { Aold: '', Ayoung: '', C: '' };

  const limpar = async (): Promise<void> => {
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id = $1)`, [TASK]);
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id = $1)`, [TASK]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [TASK]);
  };
  const seedVaga = async (serviceId: string, ordinal: number, status: string, idade: string, links: string): Promise<string> =>
    (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (vacancy_number, title, description, patient_id, contracted_service_id, case_ordinal,
          required_professions, providers_needed, status, is_draft, is_test, country, social_short_links, created_at, updated_at)
       VALUES (nextval('job_postings_vacancy_number_seq'), $1, '', $2, $3, $4, ARRAY['AT']::varchar[], 1, $5, false, true, 'AR', $6::jsonb,
          NOW() - $7::interval, NOW() - $7::interval) RETURNING id`,
      [`CASO E2E 047 ${ordinal}`, patientId, serviceId, ordinal, status, links, idade],
    )).rows[0].id;
  const seedService = async (): Promise<string> =>
    (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, hourly_value, created_by, updated_by)
       VALUES ($1, 'AT', true, 'AR', 1500, 'e2e-v047', 'e2e-v047') RETURNING id`, [patientId],
    )).rows[0].id;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`v047-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number)
       VALUES ($1, 'Vacante', 'Servicio 047', 'AR', 'ACTIVE', $2) RETURNING id`, [TASK, CASE_NUMBER],
    )).rows[0].id;
    svc.A = await seedService();
    svc.B = await seedService();
    svc.C = await seedService();
    vaga.Aold = await seedVaga(svc.A, 1, 'SEARCHING', '2 days', JSON.stringify({ site: SITE }));
    vaga.Ayoung = await seedVaga(svc.A, 2, 'CLOSED', '1 hour', JSON.stringify({ site: 'https://exemplo.test/outra' }));
    vaga.C = await seedVaga(svc.C, 3, 'SEARCHING', '1 day', '{}');
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  const porId = (rows: Svc[], id: string): Svc => rows.find((s) => s.id === id)!;

  /** As duas projeções REAIS, com as células pedidas (e o papel do ator). */
  async function leituras(roles: string[], cells: string[]): Promise<{ lista: Svc[]; ficha: Svc[] }> {
    const [req, res, out] = reqRes({ id: patientId }, roles, cells);
    await new AdminPatientContractedServicesController().list(req, res);
    expect(out.status).toBe(200);
    const lista = (out.body as { data: { services: Svc[] } }).data.services;
    const row = await new PatientQueryRepository().findDetailById(patientId, patientContainerReadsOf(cells));
    const ficha = (projectAdminPatientDetail(row as unknown as Record<string, unknown>, cells, hourlyValueActorOf(req)) as { contractedServices: Svc[] }).contractedServices;
    return { lista, ficha };
  }

  it('feliz — admin: as DUAS rotas HTTP devolvem a vaga viva MAIS ANTIGA com as 5 chaves; sem vaga → null+false; sem link → siteUrl null', async () => {
    const lista = (await api.get(`/api/admin/patients/${patientId}/contracted-services`, asAdmin)).data.data.services as Svc[];
    const ficha = (await api.get(`/api/admin/patients/${patientId}`, asAdmin)).data.data.contractedServices as Svc[];
    for (const rows of [lista, ficha]) {
      const a = porId(rows, svc.A);
      expect(a.liveVacancy).toEqual({ id: vaga.Aold, caseNumber: CASE_NUMBER, caseOrdinal: 1, status: 'SEARCHING', siteUrl: SITE });
      expect(Object.keys(a.liveVacancy!).sort()).toEqual(CINCO_CHAVES);
      expect(a).toMatchObject({ liveVacancyRedacted: false, hourlyValue: 1500, hourlyValueRedacted: false });
      expect(porId(rows, svc.B)).toMatchObject({ liveVacancy: null, liveVacancyRedacted: false });
      // A4: vaga sem link → siteUrl null (nada é gerado na leitura: a coluna segue vazia).
      expect(porId(rows, svc.C).liveVacancy).toEqual({ id: vaga.C, caseNumber: CASE_NUMBER, caseOrdinal: 3, status: 'SEARCHING', siteUrl: null });
    }
    const aindaVazio = (await pool.query(`SELECT social_short_links FROM job_postings WHERE id = $1`, [vaga.C])).rows[0].social_short_links;
    expect(aindaVazio).toEqual({});
  });

  it('alt 1 — recrutador SEM patient_contract_value:read mas COM vacancy:read: valor redigido, vaga visível (nas duas projeções)', async () => {
    const { lista, ficha } = await leituras(['recruiter'], ['patient:read', 'patient_services:read', 'vacancy:read']);
    for (const rows of [lista, ficha]) {
      const a = porId(rows, svc.A);
      expect(a).toMatchObject({ hourlyValue: null, hourlyValueRedacted: true, liveVacancyRedacted: false });
      expect(a.liveVacancy).toEqual({ id: vaga.Aold, caseNumber: CASE_NUMBER, caseOrdinal: 1, status: 'SEARCHING', siteUrl: SITE });
      // A3: as chaves da vaga são EXATAMENTE as 5 — nenhum campo de dinheiro entra no objeto.
      expect(Object.keys(a.liveVacancy!).sort()).toEqual(CINCO_CHAVES);
      expect(porId(rows, svc.B)).toMatchObject({ liveVacancy: null, liveVacancyRedacted: false });
    }
  });

  it('alt 2 — perfil SEM vacancy:read (com o valor-hora): vaga redigida (null+true), serviço visível; "sem permissão" ≠ "sem vaga"', async () => {
    const { lista, ficha } = await leituras(['recruiter'], ['patient:read', 'patient_services:read', 'patient_contract_value:read']);
    for (const rows of [lista, ficha]) {
      expect(rows).toHaveLength(3);
      for (const id of [svc.A, svc.B, svc.C]) {
        expect(porId(rows, id)).toMatchObject({ liveVacancy: null, liveVacancyRedacted: true });
      }
      expect(porId(rows, svc.A)).toMatchObject({ hourlyValue: 1500, hourlyValueRedacted: false });
      expect(JSON.stringify(rows)).not.toContain(vaga.Aold);
      expect(JSON.stringify(rows)).not.toContain(SITE);
    }
  });
});
