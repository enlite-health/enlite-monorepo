/**
 * patient-chat-id-changes-audit.e2e.test.ts
 *
 * Trilha de auditoria dos vínculos de grupo (migration 267) — contra Postgres
 * REAL, porque o que está sendo provado é a TRIGGER + o carimbo de ator na
 * mesma transação, invariantes que mock não enxerga.
 *
 * O que cada teste prova:
 *   A1. sync do ClickUp grava LINK com changed_by='sync:clickup-patients'
 *   A2. correção (valor novo no mesmo papel): old preservado via UNLINK+LINK
 *   A3. move de papel grava UNLINK do papel antigo + LINK do novo, mesma tx
 *   A4. escrita à mão (psql), sem ator: changed_by NULL — a leitura deriva
 *       'nao_instrumentado', nunca inventa autor (convenção D95)
 *   A5. desvínculo explícito (null) grava UNLINK
 */

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { Pool } from 'pg';
import { PatientChatIdsService } from '../../src/modules/case/application/PatientChatIdsService';
import { PatientChatIdsRepository } from '../../src/modules/case/infrastructure/PatientChatIdsRepository';
import { PatientChatRolesRepository } from '../../src/modules/case/infrastructure/PatientChatRolesRepository';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const TASK_PREFIX = 'cu-e2e-audit-test-';
const FAM = '120363910000000001@g.us';
const FAM2 = '120363910000000002@g.us';

describe('Trilha patient_chat_id_changes (E2E with real DB)', () => {
  let pool: Pool;
  let service: PatientChatIdsService;
  let patientId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    service = new PatientChatIdsService(
      new PatientChatIdsRepository(pool),
      new PatientChatRolesRepository(pool),
    );
  });

  beforeEach(async () => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO patients (first_name, last_name, clickup_task_id, country)
       VALUES ('Audit', 'E2E', $1, 'AR') RETURNING id`,
      [`${TASK_PREFIX}${Date.now()}`],
    );
    patientId = res.rows[0].id;
  });

  afterEach(async () => {
    // patient_chat_ids cai por CASCADE; a trilha fica de propósito (é história)
    // — limpa explicitamente pelo patient_id do fixture.
    await pool.query(`DELETE FROM patient_chat_id_changes WHERE patient_id = $1`, [patientId]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM patient_chat_id_changes WHERE patient_id IN
         (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [`${TASK_PREFIX}%`],
    ).catch(() => {});
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]).catch(() => {});
    await pool.end();
  });

  async function trail(): Promise<{ role: string; old: string | null; nw: string | null; op: string; by: string | null }[]> {
    const res = await pool.query(
      `SELECT role, old_chat_id AS old, new_chat_id AS nw, op, changed_by AS by
         FROM patient_chat_id_changes WHERE patient_id = $1 ORDER BY id`,
      [patientId],
    );
    return res.rows;
  }

  it('A1. sync do ClickUp: LINK carimbado sync:clickup-patients', async () => {
    await service.syncFromClickUp(patientId, { FAMILY: FAM });

    expect(await trail()).toEqual([
      { role: 'FAMILY', old: null, nw: FAM, op: 'LINK', by: 'sync:clickup-patients' },
    ]);
  });

  it('A2. correção no ClickUp: o valor antigo NÃO se perde — UNLINK+LINK no mesmo instante/ator', async () => {
    // A reescrita pelo caminho de produção solta a linha antiga antes de
    // inserir (é o que torna o swap atômico) → a trilha registra o par
    // UNLINK(old)+LINK(new), mesma transação, mesmo ator. old→new reconstruível.
    await service.syncFromClickUp(patientId, { FAMILY: FAM });
    await service.syncFromClickUp(patientId, { FAMILY: FAM2 });

    expect(await trail()).toEqual([
      { role: 'FAMILY', old: null, nw: FAM, op: 'LINK', by: 'sync:clickup-patients' },
      { role: 'FAMILY', old: FAM, nw: null, op: 'UNLINK', by: 'sync:clickup-patients' },
      { role: 'FAMILY', old: null, nw: FAM2, op: 'LINK', by: 'sync:clickup-patients' },
    ]);
  });

  it('A3. move de papel (equipo→familia no ClickUp): UNLINK + LINK na mesma transação', async () => {
    await service.syncFromClickUp(patientId, { PROVIDERS: FAM });
    await service.syncFromClickUp(patientId, { FAMILY: FAM });

    const rows = await trail();
    expect(rows[0]).toEqual({ role: 'PROVIDERS', old: null, nw: FAM, op: 'LINK', by: 'sync:clickup-patients' });
    // o move emite {FAMILY: FAM, PROVIDERS: null} numa gravação só
    expect(rows.slice(1)).toEqual(
      expect.arrayContaining([
        { role: 'PROVIDERS', old: FAM, nw: null, op: 'UNLINK', by: 'sync:clickup-patients' },
        { role: 'FAMILY', old: null, nw: FAM, op: 'LINK', by: 'sync:clickup-patients' },
      ]),
    );
    expect(rows).toHaveLength(3);
  });

  it('A4. escrita à mão sem ator: changed_by NULL (leitura = nao_instrumentado, nunca inferir)', async () => {
    await pool.query(
      `INSERT INTO patient_chat_ids (patient_id, role, chat_id, is_exclusive)
       VALUES ($1, 'FAMILY', $2, true)`,
      [patientId, FAM],
    );

    expect(await trail()).toEqual([
      { role: 'FAMILY', old: null, nw: FAM, op: 'LINK', by: null },
    ]);
  });

  it('A5. desvínculo explícito pela tela (null): UNLINK com ator explícito', async () => {
    await service.syncFromClickUp(patientId, { FAMILY: FAM });
    await service.update(patientId, { FAMILY: null }, { source: 'admin_panel', id: 'staff:e2e-test' });

    expect(await trail()).toEqual([
      { role: 'FAMILY', old: null, nw: FAM, op: 'LINK', by: 'sync:clickup-patients' },
      { role: 'FAMILY', old: FAM, nw: null, op: 'UNLINK', by: 'staff:e2e-test' },
    ]);
  });
});
