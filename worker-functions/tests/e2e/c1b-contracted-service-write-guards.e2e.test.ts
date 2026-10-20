/**
 * c1b-contracted-service-write-guards.e2e.test.ts @integration — C4 e C7 do relatório F5, reescrito na spec 058 (Parte A, T075).
 *
 * C4 — o PREÇO do contrato é restrito na LEITURA e nunca é escrito pelo serviço. Antes da 058 era `hourlyValue` (coluna do serviço, gravada
 *      por qualquer `staffOnly`); agora o preço mora no TERMO do contrato (`price`, redigido por `redactTermForActor`) e a escrita dele exige
 *      `patient_contract_value:create` nas rotas de contrato. O PATCH do serviço NÃO aceita mais a chave (o 422 `LEGACY_FIELD_REMOVED` é da
 *      ROTA, `legacyKeys.test.ts`; chamando o controller direto o `.strict()` recusa com 400) e a coluna legada nunca é tocada.
 * C7 — `country` vinha do corpo e chegava ao repositório. O trigger da 319 só preenche quando a coluna vem NULL, então o valor explícito
 *      VENCIA: `POST {country:'BR'}` num paciente AR carimbava BR — na coluna que existe exatamente para ser a fronteira de país.
 *
 * Postgres real: a asserção lê `hourly_value` (legado) e `country` de volta do banco; o preço projetado vem de um termo semeado por SQL.
 */
import { Pool } from 'pg';
import type { Request, Response } from 'express';
import { AdminPatientContractedServicesController } from '@modules/case/interfaces/controllers/AdminPatientContractedServicesController';
import { criarContrato, criarPagador, limpar as limpar058a, vincular, vigencia } from './helpers/contrato058aDb';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = 'C1B-cs-guards-%';
const PRECO = 4321;        // preço do TERMO do contrato vinculado
const LEGADO = 111;        // sentinela na coluna legada `hourly_value`: nada a escreve mais

type Captured = { status: number; body: unknown };
// `cells` ausente = o engine não decidiu (família fora do enforcement) → papel decide (D113).
// `cells` presente = o engine decidiu → só a célula `patient_contract_value:read` decide.
function reqRes(params: Record<string, string>, body: Record<string, unknown>, roles: string[], cells?: string[]): [Request, Response, Captured] {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: unknown) { captured.body = payload; return this; },
  } as unknown as Response;
  return [{ params, body, query: {}, user: { roles }, ...(cells ? { permissionCells: cells } : {}) } as unknown as Request, res, captured];
}

describe('C4/C7 — escrita do serviço contratado: valor restrito e país da fronteira (Postgres real) @integration', () => {
  let pool: Pool;
  const controller = new AdminPatientContractedServicesController();
  let patientId = '';
  let serviceId = '';

  const limpar = async (): Promise<void> => {
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [TAG]);
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
    await limpar058a(pool);
  };
  const svc = async () => (await pool.query<{ hourly_value: string | null; country: string }>(
    'SELECT hourly_value, country FROM patient_contracted_services WHERE id = $1', [serviceId])).rows[0];
  type Body = { data: { price: { state: string; hourlyRate?: number | string }; hourlyValue?: unknown; hourlyValueRedacted?: unknown; liveVacancy?: unknown; liveVacancyRedacted?: boolean } };

  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); await limpar(); });

  beforeEach(async () => {
    await limpar();
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('C1B-cs-guards-1', 'C1B', 'Servicio QA', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
    serviceId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, active, hourly_value, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', true, $2, 'c1b', 'c1b') RETURNING id`, [patientId, LEGADO],
    )).rows[0].id;
    // O preço de verdade: termo vigente do contrato vinculado ao serviço (a fonte única da 058).
    const contrato = await criarContrato(pool, await criarPagador(pool, 'OBRA_SOCIAL'), 'AR');
    await pool.query(
      `INSERT INTO insurance_contract_terms (contract_id, hourly_rate, tax_rate_percent, valid, recorded_by) VALUES ($1, $2, 21, '[2020-01-01,)', 'c1b')`,
      [contrato, PRECO],
    );
    await vincular(pool, serviceId, contrato, vigencia('2020-01-01'));
  });

  afterAll(async () => { await limpar(); await pool.end(); });

  it('C4-a. `recruiter` mandando `hourlyValue: 0` → recusado (400, o schema não conhece mais a chave) e a coluna legada NÃO muda', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { hourlyValue: 0 }, ['recruiter']);
    await controller.update(req, res);
    expect(out.status).toBe(400);
    expect(Number((await svc()).hourly_value)).toBe(LEGADO);
  });

  it('C4-b. `admin` mandando `hourlyValue` também é recusado (400) — nem o papel mais alto grava preço pelo serviço', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { hourlyValue: 5000 }, ['admin']);
    await controller.update(req, res);
    expect(out.status).toBe(400);
    expect(Number((await svc()).hourly_value)).toBe(LEGADO);
    // controle positivo: o MESMO ator, sem a chave legada, edita o serviço
    const [req2, res2, out2] = reqRes({ id: patientId, sid: serviceId }, { weeklyHours: 22 }, ['admin']);
    await controller.update(req2, res2);
    expect(out2.status).toBe(200);
  });

  it('C4-c. `recruiter` editando OUTRO campo passa; o preço do termo que ele não vê sai REDACTED e a coluna legada continua intacta', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { weeklyHours: 20 }, ['recruiter']);
    await controller.update(req, res);
    expect(out.status).toBe(200);
    // Spec 047 (F2): sem decisão do engine o papel `recruiter` também não lê a vaga — `null` + redigida:true.
    const { data } = out.body as Body;
    expect(data).toMatchObject({ price: { state: 'REDACTED' }, liveVacancy: null, liveVacancyRedacted: true });
    expect(data).not.toHaveProperty('hourlyValue');
    expect(data).not.toHaveProperty('hourlyValueRedacted');
    expect(JSON.stringify(data)).not.toContain(String(PRECO));
    expect(Number((await svc()).hourly_value)).toBe(LEGADO);
  });

  // 07/09 — o papel deixou de ser nível: com o engine decidindo, só a célula conta.
  it('C4-d. engine decidiu: `recruiter` COM `patient_contract_value:read` lê o preço do termo (e continua sem a vaga)', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { weeklyHours: 20 }, ['recruiter'], ['patient_services:write', 'patient_contract_value:read']);
    await controller.update(req, res);
    expect(out.status).toBe(200);
    // As duas redações são independentes: lê o preço (patient_contract_value:read) e NÃO lê a vaga (sem vacancy:read).
    const { data } = out.body as Body;
    expect(data).toMatchObject({ price: { state: 'OK' }, liveVacancyRedacted: true });
    expect(Number(data.price.hourlyRate)).toBe(PRECO);
    expect(Number((await svc()).hourly_value)).toBe(LEGADO);
  });

  it('C4-e. engine decidiu: `admin` SEM a célula → preço REDACTED na leitura — o papel não abre mais nada', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { weeklyHours: 10 }, ['admin'], ['patient_services:write']);
    await controller.update(req, res);
    expect(out.status).toBe(200);
    const { data } = out.body as Body;
    expect(data).toMatchObject({ price: { state: 'REDACTED' }, liveVacancyRedacted: true });
    expect(JSON.stringify(data)).not.toContain(String(PRECO));
  });

  it('C7. `POST {country:"BR"}` num paciente AR é RECUSADO (400) — e nada é criado', async () => {
    const antes = Number((await pool.query('SELECT COUNT(*)::int AS n FROM patient_contracted_services WHERE patient_id = $1', [patientId])).rows[0].n);
    const [req, res, out] = reqRes({ id: patientId }, { serviceCode: 'NURSE', country: 'BR' }, ['admin']);
    await controller.create(req, res);
    expect(out.status).toBe(400);
    const depois = Number((await pool.query('SELECT COUNT(*)::int AS n FROM patient_contracted_services WHERE patient_id = $1', [patientId])).rows[0].n);
    expect(depois).toBe(antes);
  });

  it('C7-b. criado SEM `country`, o serviço herda a jurisdição do PACIENTE (trigger da 319)', async () => {
    const [req, res, out] = reqRes({ id: patientId }, { serviceCode: 'NURSE' }, ['admin']);
    await controller.create(req, res);
    expect(out.status).toBe(201);
    const criado = (out.body as { data: { id: string; country: string } }).data;
    expect(criado.country).toBe('AR');
    const { rows } = await pool.query<{ country: string }>('SELECT country FROM patient_contracted_services WHERE id = $1', [criado.id]);
    expect(rows[0].country).toBe('AR');
  });
});
