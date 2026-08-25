import { Pool } from 'pg';
import { TENANT_E2E } from './helpers/permissionFamilyHarness';

/**
 * As migrations 284 e 285 contra Postgres REAL — B4 do gate `revisao-pr`.
 *
 * O gate mediu: `grep -rl "contact_access_log\|actor_class" tests/e2e/` voltava
 * VAZIO. Os dois triggers da C9 são o coração do "invariante NO BANCO, não por
 * convenção" que o cabeçalho da 285 declara, e nada os executava. O teste C10
 * que existia lê TEXTO DE ARQUIVO com regex — não toca o banco.
 *
 * ⚠️ Nada aqui é mock: se o trigger não existir no banco, o `INSERT` passa e o
 * caso fica vermelho. É essa a diferença entre "a migration está escrita" e "a
 * migration está aplicada e vale".
 *
 * ⚠️ A regra da skill: "Migration SQL exige e2e de banco real que a RODE". Este
 * arquivo depende de as migrations já terem sido aplicadas no banco de e2e —
 * o que o `run-migrations-docker.js` faz — e prova o EFEITO delas.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const GRUPO_EXTERNO = 'C9 E2E Terceiro Externo';
const GRUPO_INTERNO = 'C9 E2E Interno Com Dossie';

describe('invariantes de terceiro e trilha de contato, no banco (migrations 284/285)', () => {
  let pool: Pool;

  async function limpar(): Promise<void> {
    await pool.query(
      `DELETE FROM iam.group_permissions WHERE group_id IN
         (SELECT id FROM iam.permission_groups WHERE name = ANY($1))`,
      [[GRUPO_EXTERNO, GRUPO_INTERNO]],
    );
    await pool.query(`DELETE FROM iam.permission_groups WHERE name = ANY($1)`, [[GRUPO_EXTERNO, GRUPO_INTERNO]]);
    await pool.query(`DELETE FROM iam.contact_access_log WHERE operator_uid LIKE 'c6-e2e-%'`);
  }

  async function criarGrupo(nome: string, classe: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, actor_class)
         VALUES ($1, $2, 'e2e', $3) RETURNING id`,
      [TENANT_E2E, nome, classe],
    );
    return r.rows[0].id as string;
  }

  async function idDaCelula(resource: string, action: string): Promise<string> {
    const r = await pool.query(`SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    if (r.rowCount !== 1) throw new Error(`célula ${resource}:${action} não existe — o seed do teste está errado`);
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  }, 30000);

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  describe('285 — a célula vedada não chega ao terceiro (C9)', () => {
    it('🔴 conceder `worker_pii:read` a grupo EXTERNAL_THIRD_PARTY é recusado PELO BANCO', async () => {
      const grupo = await criarGrupo(GRUPO_EXTERNO, 'EXTERNAL_THIRD_PARTY');
      const celula = await idDaCelula('worker_pii', 'read');

      await expect(
        pool.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2)`, [grupo, celula]),
      ).rejects.toMatchObject({ code: '23514' });

      const sobrou = await pool.query(`SELECT 1 FROM iam.group_permissions WHERE group_id = $1`, [grupo]);
      expect(sobrou.rowCount).toBe(0);
    });

    it('célula NÃO vedada continua entrando no mesmo grupo — o trigger não é bloqueio geral', async () => {
      // Controle POSITIVO: sem ele, um trigger que recusasse TUDO passaria no
      // caso acima e ninguém veria.
      const grupo = await pool.query(`SELECT id FROM iam.permission_groups WHERE name = $1`, [GRUPO_EXTERNO]);
      const celula = await idDaCelula('worker', 'read');

      const r = await pool.query(
        `INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2) RETURNING permission_id`,
        [grupo.rows[0].id, celula],
      );

      expect(r.rowCount).toBe(1);
    });

    it('🔴 grupo que JÁ tem a célula vedada não pode VIRAR terceiro — o caminho inverso', async () => {
      const grupo = await criarGrupo(GRUPO_INTERNO, 'INTERNAL');
      const celula = await idDaCelula('worker_pii', 'read');
      await pool.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2)`, [grupo, celula]);

      await expect(
        pool.query(`UPDATE iam.permission_groups SET actor_class = 'EXTERNAL_THIRD_PARTY' WHERE id = $1`, [grupo]),
      ).rejects.toMatchObject({ code: '23514' });

      const classe = await pool.query(`SELECT actor_class FROM iam.permission_groups WHERE id = $1`, [grupo]);
      expect(classe.rows[0].actor_class).toBe('INTERNAL');
    });

    it('a coluna nasce `INTERNAL` e só aceita as duas classes', async () => {
      const r = await pool.query(
        `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e') RETURNING actor_class`,
        [TENANT_E2E, `${GRUPO_INTERNO} default`],
      );
      expect(r.rows[0].actor_class).toBe('INTERNAL');

      await expect(
        pool.query(`UPDATE iam.permission_groups SET actor_class = 'QUALQUER_COISA' WHERE name = $1`, [
          `${GRUPO_INTERNO} default`,
        ]),
      ).rejects.toMatchObject({ code: '23514' });

      await pool.query(`DELETE FROM iam.permission_groups WHERE name = $1`, [`${GRUPO_INTERNO} default`]);
    });
  });

  describe('284 — a trilha agregada de contato', () => {
    const uid = 'c6-e2e-recrutadora';

    it('grava UMA linha com a lista inteira, e `n` bate com a cardinalidade', async () => {
      const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

      await pool.query(
        `INSERT INTO iam.contact_access_log (tenant_id, operator_uid, cell, worker_ids, n, country)
           VALUES ($1, $2, 'worker_contact:read', $3::uuid[], $4, 'AR')`,
        [TENANT_E2E, uid, ids, ids.length],
      );

      const r = await pool.query(`SELECT n, cardinality(worker_ids) AS card FROM iam.contact_access_log WHERE operator_uid = $1`, [uid]);
      expect(r.rowCount).toBe(1);
      expect(r.rows[0].n).toBe(2);
      expect(r.rows[0].card).toBe(2);
    });

    it('🔴 `n` que não bate com a lista é recusado — o materializado não pode mentir', async () => {
      const ids = ['33333333-3333-4333-8333-333333333333'];

      await expect(
        pool.query(
          `INSERT INTO iam.contact_access_log (tenant_id, operator_uid, cell, worker_ids, n)
             VALUES ($1, 'c6-e2e-mentiroso', 'worker_contact:read', $2::uuid[], 99)`,
          [TENANT_E2E, ids],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('🔴 lista VAZIA é recusada — "tentou ver" não é trilha de contato (M1-2)', async () => {
      await expect(
        pool.query(
          `INSERT INTO iam.contact_access_log (tenant_id, operator_uid, cell, worker_ids, n)
             VALUES ($1, 'c6-e2e-vazio', 'worker_contact:read', '{}'::uuid[], 0)`,
          [TENANT_E2E],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});
