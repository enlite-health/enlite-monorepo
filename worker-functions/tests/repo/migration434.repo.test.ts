/**
 * migration434.repo.test.ts — teste de REPOSITÓRIO, banco Postgres REAL (nunca mock), contra a
 * migration 434 (spec 019, gate `revisao-pr`, achado K2).
 *
 * Prova automatizada do conserto: o passo 0 (re-backfill) da 434 tinha DOIS bugs na janela entre
 * o deploy do código novo e a migration rodar —
 *
 *   (a) reafirmava `is_default = true` na linha `'primary'` legada mesmo quando o PATCH novo já
 *       tinha trocado o principal do paciente para OUTRO endereço — criando um segundo principal
 *       ativo (violação do índice único `patient_addresses_one_default_per_patient`, migration
 *       433) e derrubando a migration INTEIRA (nada aplica pela metade, spec.md linha 88);
 *   (b) o passo 5 apagava QUALQUER `address_type` não-nulo em linha ativa, inclusive um valor da
 *       lista NOVA que o PATCH já tivesse gravado (ex.: 'escuela').
 *
 * O conserto: (a) o backfill só reafirma quando `NOT EXISTS` outro principal ativo do mesmo
 * paciente; (b) o apagamento do passo 5 é restrito a `address_type IN ('primary','secondary',
 * 'tertiary','service')` — nunca a um valor da lista nova.
 *
 * Como rodar (banco só até a 433 — a 434 é aplicada DENTRO do teste, não antes):
 *   docker run -d --name 019fix-pg -p 127.0.0.1:5450:5432 \
 *     -e POSTGRES_USER=enlite_admin -e POSTGRES_PASSWORD=enlite_password -e POSTGRES_DB=enlite_e2e \
 *     postgis/postgis:16-3.4
 *   # aplicar só até a 433 (mover a 434 pra fora do diretório antes de rodar o runner, ou usar
 *   # um checkout de migrations/ anterior a ela) — ver docs/funcionalidades desta rodada.
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5450/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand migration434
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5450/enlite_e2e';
const MIGRATION_434_SQL = fs.readFileSync(
  path.join(__dirname, '../../migrations/434_patient_addresses_address_type_contract.sql'),
  'utf8',
);

describe('migration 434 (contract) @repo — Postgres real, schema só até a 433', () => {
  let pool: Pool;
  const patientIds: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1'); // falha cedo e claro se o container não estiver de pé

    // Pré-condição do teste: 434 ainda NÃO deve ter rodado neste banco (senão o CHECK da lista
    // fechada já rejeitaria os valores legados que este teste semeia). Falha alto e claro se
    // alguém rodar isto contra um banco que já tem a 434.
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'patient_addresses_type_check'
       ) AS exists`,
    );
    if (rows[0].exists) {
      throw new Error(
        'Pré-condição falhou: patient_addresses_type_check já existe — este banco já rodou a 434. ' +
        'Use um container fresco com migrations só até a 433 (ver header deste arquivo).',
      );
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    for (const key of ['A', 'B', 'C'] as const) {
      const { rows: [p] } = await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'K2', $2, 'AR', 'ACTIVE') RETURNING id`,
        [`k2-migration-434-${key}-${Date.now()}-${Math.random()}`, key],
      );
      patientIds[key] = p.id;
    }
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM patient_addresses WHERE patient_id = ANY($1::uuid[])`, [Object.values(patientIds)]);
    await pool.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [Object.values(patientIds)]);
  });

  it('backfill (passo 0) não cria segundo principal quando o PATCH novo já trocou; passo 5 preserva tipo novo já gravado (ex.: escuela)', async () => {
    // Paciente A: 'primary' ativa (is_default=false, código velho) + 'secondary' ativa já
    // marcada is_default=true (operador trocou via PATCH novo nessa janela).
    await pool.query(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order, address_type, is_default, source)
       VALUES ($1, 'A - primary', 1, 'primary', false, 'admin_manual'),
              ($1, 'A - secondary', 2, 'secondary', true, 'admin_manual')`,
      [patientIds.A],
    );
    // Paciente B: já com 'escuela' (PATCH novo já rodou).
    await pool.query(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order, address_type, is_default, source)
       VALUES ($1, 'B - escuela', 1, 'escuela', true, 'admin_manual')`,
      [patientIds.B],
    );
    // Paciente C: 'primary' sem is_default (código antigo na janela).
    await pool.query(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order, address_type, is_default, source)
       VALUES ($1, 'C - primary', 1, 'primary', false, 'admin_manual')`,
      [patientIds.C],
    );
    // Linha arquivada de A com valor legado — nunca deve ser tocada.
    const { rows: [arquivada] } = await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order, address_type, is_default, archived_at, source)
       VALUES ($1, 'A - arquivada', 3, 'primary', false, NOW(), 'admin_manual') RETURNING id`,
      [patientIds.A],
    );

    await pool.query(MIGRATION_434_SQL);

    const { rows: aRows } = await pool.query<{ address_type: string | null; is_default: boolean }>(
      `SELECT address_type, is_default FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL ORDER BY display_order`,
      [patientIds.A],
    );
    expect(aRows).toEqual([
      { address_type: null, is_default: false }, // a antiga 'primary' NÃO virou principal de novo
      { address_type: null, is_default: true },  // a 'secondary' continua a única principal
    ]);
    const { rows: [aCount] } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM patient_addresses WHERE patient_id = $1 AND is_default AND archived_at IS NULL`,
      [patientIds.A],
    );
    expect(aCount.n).toBe('1'); // nunca 0, nunca 2

    const { rows: [bRow] } = await pool.query<{ address_type: string | null }>(
      `SELECT address_type FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL`,
      [patientIds.B],
    );
    expect(bRow.address_type).toBe('escuela'); // preservado, não é valor legado

    const { rows: [cRow] } = await pool.query<{ address_type: string | null; is_default: boolean }>(
      `SELECT address_type, is_default FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL`,
      [patientIds.C],
    );
    expect(cRow).toEqual({ address_type: null, is_default: true }); // backfill normal, sem colisão

    const { rows: [arquivadaRow] } = await pool.query<{ address_type: string | null }>(
      `SELECT address_type FROM patient_addresses WHERE id = $1`,
      [arquivada.id],
    );
    expect(arquivadaRow.address_type).toBe('primary'); // arquivada nunca tocada
  });
});
