/**
 * ownNotificationsMigrationsFreshDb.integration.test.ts — régua obrigatória do conserto do gate
 * revisao-pr (B4, achado ALTO): migrations 463/464 (`own_notifications:read|update`) num BANCO
 * NOVO, SEM a API subir (sem sync de catálogo).
 *
 * POR QUÊ UM BANCO SÓ DELE
 * O achado é sobre ORDEM DE BOOT: `Dockerfile` roda `run-migrations-docker.js` e só DEPOIS
 * `npm start` (que sincroniza `iam.permissions` — `wirePermissionsModule.ts`). Rodar este teste
 * contra o banco `enlite_e2e`/`enlite_e2e_022` compartilhado das outras suítes provaria pouco: essas
 * bases já tiveram a API/sync rodando em cima delas alguma hora nesta sessão, então
 * `own_notifications` já existe em `iam.permissions` por um caminho que NÃO é o das migrations —
 * mascarando exatamente o bug que este teste existe pra pegar. Um banco DESCARTÁVEL, com só as
 * migrations reais aplicadas (via `run-migrations-docker.js`, o MESMO runner do Dockerfile) e
 * NENHUM boot de API por cima, é a única forma de reproduzir "primeiro deploy" de verdade.
 *
 * O QUE PROVA
 *   1. `iam.permissions` tem `own_notifications:read` e `own_notifications:update` DEPOIS das
 *      migrations (nasceram da PRÓPRIA migration, não de sync nenhum — a run não sobe a API).
 *   2. `iam.group_permissions` concede as 2 células ao Acesso Master (migration 206 semeia o grupo
 *      com id fixo `a0000000-0000-0000-0000-000000000001` — 463/D-23) — contagem > 0.
 *   3. `iam.group_permissions` concede as 2 células a um grupo de staff NÃO-Master já existente no
 *      banco (migration 206 também semeia "Recrutador"/"Community Manager" — 464/D-07, "nasce
 *      concedida a TODO staff") — contagem > 0. Usa "Recrutador" (não fabricado por este teste —
 *      é o mesmo grupo que qualquer deploy novo já tem).
 *
 * GUARDA PELO AVESSO (evidência da sessão, não deste arquivo): rodado à MÃO, uma vez, com as
 * versões ANTIGAS (sem o seed) de 463/464 restauradas por `cp` a partir de `git show` — RED
 * (contagem 0 para as 2 células nos 2 grupos); depois `cp` de volta o conteúdo atual — GREEN.
 * Documentado em `specs/022-chat-interno-por-paciente/evidencias/b4-conserto-gates.md`. Este
 * arquivo, uma vez commitado, só precisa manter o estado GREEN como regressão permanente — reverter
 * a régua pra RED de propósito toda vez que rodar tornaria o CI instável à toa.
 */

import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import * as path from 'path';

const BASE_URL =
  process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'run-migrations-docker.js');

const MASTER_GROUP_ID = 'a0000000-0000-0000-0000-000000000001';

const urlPara = (db: string): string => {
  const u = new URL(BASE_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

/** Cria um database descartável e aplica TODAS as migrations reais nele — mesmo runner do Dockerfile, sem API por cima. */
async function bancoDescartavel(sufixo: string): Promise<{ url: string; pool: Pool; destruir: () => Promise<void> }> {
  const nome = `own_notif_gate_${sufixo}_${Date.now()}`;
  const admin = new Pool({ connectionString: BASE_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${nome}`);
  const url = urlPara(nome);

  execFileSync('node', [RUNNER], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });

  const pool = new Pool({ connectionString: url, max: 1 });
  return {
    url,
    pool,
    destruir: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      await admin.end();
    },
  };
}

async function grantCount(pool: Pool, groupId: string, action: 'read' | 'update'): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM iam.group_permissions gp
       JOIN iam.permissions p ON p.id = gp.permission_id
      WHERE gp.group_id = $1 AND p.resource = 'own_notifications' AND p.action = $2`,
    [groupId, action],
  );
  return Number(r.rows[0].n);
}

async function groupIdByName(pool: Pool, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM iam.permission_groups WHERE name = $1`, [name]);
  if (!r.rows[0]) throw new Error(`grupo-fixture ausente do seed da 206: ${name}`);
  return r.rows[0].id;
}

describe('migrations 463/464 — own_notifications num banco NOVO, sem API/sync (gate revisao-pr B4, achado ALTO)', () => {
  jest.setTimeout(180_000);

  let db: { url: string; pool: Pool; destruir: () => Promise<void> };

  beforeAll(async () => {
    db = await bancoDescartavel('regua');
  });

  afterAll(async () => {
    if (db) await db.destruir();
  });

  it('as migrations SOZINHAS (sem sync de boot) semeiam own_notifications:read|update em iam.permissions', async () => {
    const r = await db.pool.query<{ resource: string; action: string }>(
      `SELECT resource, action FROM iam.permissions WHERE resource = 'own_notifications' ORDER BY action`,
    );
    expect(r.rows).toEqual([
      { resource: 'own_notifications', action: 'read' },
      { resource: 'own_notifications', action: 'update' },
    ]);
  });

  it('Acesso Master (463, D-23): grant > 0 para read E update', async () => {
    expect(await grantCount(db.pool, MASTER_GROUP_ID, 'read')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, MASTER_GROUP_ID, 'update')).toBeGreaterThan(0);
  });

  it('grupo de staff NÃO-Master já existente no seed (464, D-07 — "nasce concedida a TODO staff"): grant > 0 para read E update', async () => {
    const recrutadorId = await groupIdByName(db.pool, 'Recrutador');
    expect(await grantCount(db.pool, recrutadorId, 'read')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, recrutadorId, 'update')).toBeGreaterThan(0);

    // 2º grupo não-Master, para não depender de um único nome de fixture (mesmo seed da 206).
    const cmId = await groupIdByName(db.pool, 'Community Manager');
    expect(await grantCount(db.pool, cmId, 'read')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, cmId, 'update')).toBeGreaterThan(0);
  });

  it('reaplicar 463+464 (idempotência): rodar o runner de novo não muda a contagem de grants', async () => {
    const antes = (await db.pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM iam.group_permissions`)).rows[0].n;
    execFileSync('node', [RUNNER], { env: { ...process.env, DATABASE_URL: db.url }, stdio: 'pipe' });
    const depois = (await db.pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM iam.group_permissions`)).rows[0].n;
    expect(depois).toBe(antes);
  });
});
