/**
 * patient-contacts-active-db.e2e.test.ts — migration 420 (spec 018, PR-1, ADR-1; US-0; FR-001…004).
 *
 * Prova contra Postgres REAL os dois invariantes de banco que sustentam a escrita por linha:
 *   1. CHECK `*_active_coerente` — `active` e `deactivated_at` nunca divergem, nas TRÊS tabelas.
 *   2. `idx_patient_responsibles_one_primary` passou a olhar SÓ linhas ativas — desativar o
 *      titular abre espaço para outro (a "prova que morre": sem a migration, o índice antigo
 *      (`WHERE is_primary = true`, sem `AND active`) bloquearia o segundo INSERT).
 * Task 1.4 do tasks.md pedia "vermelho antes da 420, verde depois" — a sabotagem abaixo reproduz
 * isso: recria o índice ANTIGO (sem `AND active`) numa tabela temporária-por-teste e mostra que o
 * 2º INSERT falha 23505; restaurado, os dois INSERTs passam.
 */
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('migration 420 — active/deactivated_* nos três conjuntos de contato (Postgres real)', () => {
  let pool: Pool;
  const PATIENT = 'ee420000-0a00-0001-0001-000000000001';

  async function limpar(): Promise<void> {
    await pool.query('DELETE FROM patients WHERE id = $1', [PATIENT]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test)
       VALUES ($1, 'e2e-420-a', 'Paciente', 'Sintético 420', 'AR', true)`,
      [PATIENT],
    );
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM patient_responsibles WHERE patient_id = $1', [PATIENT]);
    await pool.query('DELETE FROM patient_coverage_emergency_contacts WHERE patient_id = $1', [PATIENT]);
    await pool.query('DELETE FROM patient_professionals WHERE patient_id = $1', [PATIENT]);
    await pool.query('DELETE FROM patient_external_contacts WHERE patient_id = $1', [PATIENT]);
  });

  it.each([
    ['patient_responsibles', `INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order) VALUES ($1, 'A', 'B', false, 1) RETURNING id`],
    ['patient_coverage_emergency_contacts', `INSERT INTO patient_coverage_emergency_contacts (patient_id, kind, name, phone_encrypted, created_by) VALUES ($1, 'PRIVATE_AMBULANCE', 'A', 'enc', 'e2e') RETURNING id`],
    ['patient_professionals', `INSERT INTO patient_professionals (patient_id, name) VALUES ($1, 'A') RETURNING id`],
    // Spec 018, PR-2: patient_external_contacts (migration 422) tem a MESMA invariante
    // (`pxc_active_coerente`) — mesmo molde das 3 tabelas acima.
    ['patient_external_contacts', `INSERT INTO patient_external_contacts (patient_id, relation, name, created_by) VALUES ($1, 'NEIGHBOR', 'A', 'e2e') RETURNING id`],
  ])('%s: CHECK *_active_coerente recusa active=false com deactivated_at NULL, e active=true com deactivated_at preenchido', async (tabela, insertSql) => {
    const { rows } = await pool.query<{ id: string }>(insertSql, [PATIENT]);
    const id = rows[0].id;

    await expect(pool.query(`UPDATE ${tabela} SET active = false, deactivated_at = NULL WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: '23514' });

    await expect(pool.query(`UPDATE ${tabela} SET active = true, deactivated_at = NOW() WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: '23514' });

    // O par coerente passa nos dois sentidos.
    await pool.query(`UPDATE ${tabela} SET active = false, deactivated_at = NOW() WHERE id = $1`, [id]);
    await pool.query(`UPDATE ${tabela} SET active = true, deactivated_at = NULL WHERE id = $1`, [id]);
    const { rows: final } = await pool.query<{ active: boolean }>(`SELECT active FROM ${tabela} WHERE id = $1`, [id]);
    expect(final[0].active).toBe(true);
  });

  it('idx_patient_responsibles_one_primary: desativar o titular abre espaço para outro (o índice olha só active)', async () => {
    const { rows: r1 } = await pool.query<{ id: string }>(
      `INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order) VALUES ($1, 'Titular', '1', true, 1) RETURNING id`,
      [PATIENT],
    );
    // 2º titular ATIVO → 23505 (o índice segue vivo: no máximo 1 titular ATIVO).
    await expect(
      pool.query(`INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order) VALUES ($1, 'Titular', '2', true, 2)`, [PATIENT]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'idx_patient_responsibles_one_primary' });

    // Desativar o titular…
    await pool.query(`UPDATE patient_responsibles SET active = false, deactivated_at = NOW() WHERE id = $1`, [r1[0].id]);

    // …e AGORA um 2º titular entra sem conflito (a prova que morre sem a migration 420: o
    // índice antigo, `WHERE is_primary = true` sem `AND active`, recusaria este INSERT).
    const { rows: r2 } = await pool.query<{ id: string }>(
      `INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order) VALUES ($1, 'Titular', '2', true, 2) RETURNING id`,
      [PATIENT],
    );
    expect(r2[0].id).not.toBe(r1[0].id);
  });

  it('SABOTAGEM (D183, cp/restauração feita fora do banco — aqui reproduzida com um índice PARALELO ao vivo): o índice SEM "AND active" bloqueia o 2º titular mesmo com o 1º desativado; o índice de verdade (420) convive com ele sem recusar', async () => {
    // Recria, numa tabela-sombra com a MESMA forma parcial, o comportamento do índice ANTIGO
    // (136_...sql, sem `AND active`) — sem tocar no índice real da migration 420. Prova o
    // contraste "antes × depois" sem precisar reverter a migration no banco de teste.
    await pool.query(`DROP INDEX IF EXISTS idx_sabotagem_420_sem_active`);
    await pool.query(`CREATE UNIQUE INDEX idx_sabotagem_420_sem_active ON patient_responsibles(patient_id) WHERE is_primary`);
    try {
      const { rows: r1 } = await pool.query<{ id: string }>(
        `INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order) VALUES ($1, 'Titular', '1', true, 1) RETURNING id`,
        [PATIENT],
      );
      await pool.query(`UPDATE patient_responsibles SET active = false, deactivated_at = NOW() WHERE id = $1`, [r1[0].id]);
      // Com o índice ANTIGO ainda vivo (sabotagem), o 2º titular ATIVO colide nele mesmo
      // desativado o 1º — é exatamente o defeito que a migration 420 corrigiu.
      await expect(
        pool.query(`INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order) VALUES ($1, 'Titular', '2', true, 2)`, [PATIENT]),
      ).rejects.toMatchObject({ code: '23505', constraint: 'idx_sabotagem_420_sem_active' });
    } finally {
      // Restaura (equivalente ao `cp X.bak X` — aqui, DROP do índice-sombra que a sabotagem criou).
      await pool.query(`DROP INDEX IF EXISTS idx_sabotagem_420_sem_active`);
    }
    // Verde de novo: SEM o índice-sombra, o mesmo cenário passa (o índice real da 420 segue vivo
    // e não incomoda, porque ele JÁ olha só `active`).
    const { rows: r1 } = await pool.query<{ id: string }>(
      `INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order) VALUES ($1, 'Titular', '1b', true, 3) RETURNING id`,
      [PATIENT],
    );
    await pool.query(`UPDATE patient_responsibles SET active = false, deactivated_at = NOW() WHERE id = $1`, [r1[0].id]);
    await expect(
      pool.query(`INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order) VALUES ($1, 'Titular', '2b', true, 4)`, [PATIENT]),
    ).resolves.toBeDefined();
  });
});
