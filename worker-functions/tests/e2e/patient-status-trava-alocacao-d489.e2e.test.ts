/**
 * patient-status-trava-alocacao-d489.e2e.test.ts @integration — D489/D530 (cadeia, 058 Parte B).
 *
 * App REAL (rotas da ficha, engine de permissão ligado) + Postgres real, sem mock: toda troca MANUAL de estado do paciente
 * (`PUT /patients/:id/status`, origem admin_panel ou kanban) é RECUSADA com 422 PATIENT_STATUS_LOCKED_BY_ALLOCATION quando o paciente
 * tem alocação VIVA no itinerário (`ACTIVE` e `valid_to` nulo ou >= hoje do país — inclui a que começa no futuro). A prova é o que
 * NÃO mudou (estado e trilha), nunca só o 422. Itinerário montado SEM prestador não bloqueia; a derivação automática (`system`) segue.
 */
import { Pool } from 'pg';
import type { AppDeFamilia } from './helpers/permissionFamilyHarness';
import { atorComCelulas, chamar, fecharApp058a, limparAtores, subirApp058a, type Celula } from './helpers/contrato058aApp';
import { DATABASE_URL } from './helpers/contrato058aDb';
import { alocar, criarCandidato, criarCenario, hojeOp, limparB, mais, novoPool, PREFIXO_058B } from './helpers/itinerario058bDb';
import { PatientStatusDerivation } from '../../src/modules/case/application/PatientStatusDerivation';

const ATOR = { uid: 'qa058b-d489', nome: 'QA058B D489' };
const CELULAS: Celula[] = [['patient', 'update'], ['patient', 'read']];

describe('D489/D530 — troca manual de estado com alocação viva no itinerário @integration', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const limparTudo = async (): Promise<void> => {
    const pac = `${PREFIXO_058B}-%`;
    await pool.query(`DELETE FROM patient_status_history WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [pac]);
    await pool.query(`DELETE FROM patient_itinerary_assembly WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [pac]);
    await limparB(pool);
  };

  beforeAll(async () => {
    pool = novoPool();
    await limparTudo();
    await limparAtores(pool, [ATOR]);
    await atorComCelulas(pool, ATOR.uid, ATOR.nome, CELULAS);
    app = await subirApp058a(DATABASE_URL);
  }, 60000);

  afterAll(async () => {
    await limparTudo();
    await limparAtores(pool, [ATOR]);
    await fecharApp058a(app);
    await pool.end();
  });

  const estado = async (id: string): Promise<{ status: string; trilha: number }> => (await pool.query(
    `SELECT (SELECT status FROM patients WHERE id = $1) AS status,
            (SELECT count(*)::int FROM patient_status_history WHERE patient_id = $1) AS trilha`, [id])).rows[0];
  const emEspera = { status: 'ON_HOLD', onHoldReason: 'INSURER' };

  /** Paciente ACTIVE com serviço, vaga e 2 faixas; `valid_from`/`valid_to` relativos ao "hoje" do país, lido do banco. */
  async function comAlocacao(de: number, ate: number | null) {
    const c = await criarCenario(pool, { faixas: 2 });
    const cand = await criarCandidato(pool, c);
    const hoje = await hojeOp(pool);
    await alocar(pool, c.faixas[0], cand, await mais(pool, hoje, de), ate === null ? null : await mais(pool, hoje, ate));
    return c;
  }

  it('HAPPY: alocação viva → PUT manual (ficha) 422 com a contagem e SEM nome; estado e trilha não mudam', async () => {
    const c = await comAlocacao(-3, null);
    const antes = await estado(c.patientId);
    const r = await chamar(app, 'PUT', `/api/admin/patients/${c.patientId}/status`, ATOR.uid, emEspera);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ success: false, code: 'PATIENT_STATUS_LOCKED_BY_ALLOCATION', details: { allocations: 1 } });
    expect(JSON.stringify(r.body)).not.toMatch(/QA058|e2e\.local/); // nenhum nome de paciente/prestador no corpo
    expect(await estado(c.patientId)).toEqual(antes);
    expect(antes.status).toBe('ACTIVE');
  });

  it('o arrasto do Kanban (changeSource kanban) é recusado do mesmo jeito', async () => {
    const c = await comAlocacao(-3, null);
    const r = await chamar(app, 'PUT', `/api/admin/patients/${c.patientId}/status`, ATOR.uid, { ...emEspera, changeSource: 'kanban' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PATIENT_STATUS_LOCKED_BY_ALLOCATION');
    expect((await estado(c.patientId)).status).toBe('ACTIVE');
  });

  it('alocação que COMEÇA no futuro já é viva → 422', async () => {
    const c = await comAlocacao(5, null);
    const r = await chamar(app, 'PUT', `/api/admin/patients/${c.patientId}/status`, ATOR.uid, emEspera);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PATIENT_STATUS_LOCKED_BY_ALLOCATION');
  });

  it('GET status-options com alocação viva: TODO destino sai com blockedBy [ACTIVE_ALLOCATION]', async () => {
    const c = await comAlocacao(-3, null);
    const r = await chamar(app, 'GET', `/api/admin/patients/${c.patientId}/status-options?changeSource=admin_panel`, ATOR.uid);
    expect(r.status).toBe(200);
    const opts = r.body.data.options as Array<{ blockedBy?: string[] }>;
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every((o) => JSON.stringify(o.blockedBy) === '["ACTIVE_ALLOCATION"]')).toBe(true);
  });

  it('SEM alocação (só o itinerário montado: serviço, vaga e faixas, nenhum prestador) → 200 e o estado muda', async () => {
    const c = await criarCenario(pool, { faixas: 2 });
    const r = await chamar(app, 'PUT', `/api/admin/patients/${c.patientId}/status`, ATOR.uid, emEspera);
    expect(r.status).toBe(200);
    expect((await estado(c.patientId)).status).toBe('ON_HOLD');
  });

  it('alocação já ENCERRADA (valid_to < hoje) não é viva → 200', async () => {
    const c = await comAlocacao(-10, -1);
    const r = await chamar(app, 'PUT', `/api/admin/patients/${c.patientId}/status`, ATOR.uid, emEspera);
    expect(r.status).toBe(200);
    expect((await estado(c.patientId)).status).toBe('ON_HOLD');
  });

  it('CONTROLE: a derivação automática (system) com alocação viva continua movendo o estado', async () => {
    const c = await comAlocacao(-3, null); // 1 de 2 faixas cobertas → REPLACEMENT
    await pool.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, 'qa058b', 'AR')`, [c.patientId]);
    const hoje = await hojeOp(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await new PatientStatusDerivation().run(client, c.patientId, new Date(`${hoje}T12:00:00Z`));
      await client.query('COMMIT');
      expect(out).toBe('moved');
    } finally {
      client.release();
    }
    const dep = await estado(c.patientId);
    expect(dep.status).toBe('REPLACEMENT');
    const hist = await pool.query(`SELECT change_source FROM patient_status_history WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`, [c.patientId]);
    expect(hist.rows[0].change_source).toBe('system');
  });
});
