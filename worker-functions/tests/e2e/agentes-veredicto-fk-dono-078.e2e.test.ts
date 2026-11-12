/**
 * agentes-veredicto-fk-dono-078.e2e.test.ts — régua do conserto da migration 568 (spec 078, notário).
 *
 * DEFEITO (prd, 30/10 → 04/11/2026): `agentes.veredicto.registrar` com achados morria com
 * `permission denied for table veredictos`. A checagem de FK de `veredicto_achados` roda COMO O DONO de
 * `veredictos` e pede UPDATE (`FOR KEY SHARE`); a 551 revogou o UPDATE do próprio dono (`enlite_app`, executor
 * das migrations e dono das tabelas em prd).
 *
 * POR QUE UM BANCO SÓ DELE, COM DONO NÃO-SUPERUSER
 * As outras suítes rodam as migrations como `enlite_admin` (superuser): o dono superuser não passa por ACL e a
 * classe é invisível. Aqui o banco descartável pertence a um login `enlite_app` NOSUPERUSER (o desenho do Cloud
 * SQL de prd), TODAS as migrations reais rodam por ele com o mesmo runner do Dockerfile, e a capability roda
 * como o MCP de prd roda: pool conectado como `enlite_app`, `COUNTRY_RLS_ENABLED` desligado.
 * Desfazer a 568 → o teste "veredicto COM achado" falha com 42501.
 */
import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { AgentesRepository } from '../../src/modules/mcp/infrastructure/AgentesRepository';
import { AgentesVeredictoRegistrarCapability } from '../../src/modules/mcp/application/capabilities/AgentesVeredictoRegistrarCapability';

const BASE_URL =
  process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'run-migrations-docker.js');
const DONO = 'enlite_app';
const DONO_SENHA = 'qa078_dono_nao_superuser';
// O dono não-superuser não cria extensão; no Cloud SQL quem cria é o cloudsqlsuperuser. Aqui, o admin, antes.
const EXTENSOES = ['uuid-ossp', 'btree_gist', 'fuzzystrmatch', 'pg_trgm', 'postgis', 'unaccent'];

const urlPara = (db: string, user?: { name: string; password: string }): string => {
  const u = new URL(BASE_URL);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
};

describe('568 — veredicto COM achado grava quando o dono das tabelas não é superuser (prd: enlite_app)', () => {
  jest.setTimeout(180_000);

  const nome = `qa078_fk_dono_${Date.now()}`;
  let admin: Pool;
  let dono: Pool;
  let criouRole = false;
  let cap: AgentesVeredictoRegistrarCapability;
  const run = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    admin = new Pool({ connectionString: BASE_URL, max: 1 });
    const existe = await admin.query(`SELECT rolsuper FROM pg_roles WHERE rolname = $1`, [DONO]);
    if (existe.rows.length === 0) {
      await admin.query(`CREATE ROLE ${DONO} LOGIN NOSUPERUSER CREATEROLE PASSWORD '${DONO_SENHA}'`);
      criouRole = true;
    } else if (existe.rows[0].rolsuper) {
      throw new Error(`${DONO} já existe como SUPERUSER neste cluster — o teste não mediria nada`);
    }
    await admin.query(`CREATE DATABASE ${nome} OWNER ${DONO}`);
    const ext = new Pool({ connectionString: urlPara(nome), max: 1 });
    for (const e of EXTENSOES) await ext.query(`CREATE EXTENSION IF NOT EXISTS "${e}"`);
    await ext.end();

    const urlDono = urlPara(nome, { name: DONO, password: DONO_SENHA });
    execFileSync('node', [RUNNER], { env: { ...process.env, DATABASE_URL: urlDono }, stdio: 'pipe' });

    dono = new Pool({ connectionString: urlDono, max: 2 });
    cap = new AgentesVeredictoRegistrarCapability(new AgentesRepository(dono));
  });

  afterAll(async () => {
    if (dono) await dono.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      if (criouRole) await admin.query(`DROP ROLE IF EXISTS ${DONO}`);
      await admin.end();
    }
  });

  const args = (conversa: string, achados: Array<Record<string, string>>) => ({
    operador: 'luz',
    sensor: 'notario',
    inbox: 'chatwoot',
    conversa_ref: `qa078-${run}-${conversa}`,
    ultima_msg_ref: 'm1',
    cruza_areas: false,
    avaliado_em: '2026-11-04T20:00:00.000Z',
    achados,
  });

  it('pré-condição: o dono das tabelas é o login não-superuser (senão o teste não mede a classe)', async () => {
    const { rows } = await dono.query(
      `SELECT pg_get_userbyid(c.relowner) AS dono, r.rolsuper
         FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        WHERE c.oid = 'agentes.veredictos'::regclass`,
    );
    expect(rows[0]).toEqual({ dono: DONO, rolsuper: false });
  });

  it('veredicto COM achado (o caso que morria em prd) grava o veredicto e o achado', async () => {
    const r = await cap.execute(
      args('com-achado', [{ tipo: 'violacao', regra_ref: 'constituicao/persona-luz#4e2715b899bd', gravidade: 'alta' }]),
      'sol-supervisor',
    );
    expect(r.duplicado).toBeUndefined();
    const { rows } = await dono.query(`SELECT count(*)::int AS n FROM agentes.veredicto_achados WHERE veredicto_id = $1`, [r.id]);
    expect(rows[0].n).toBe(1);
  });

  it('controle: veredicto SEM achado (o caso que já passava) segue gravando', async () => {
    const r = await cap.execute(args('sem-achado', []), 'sol-supervisor');
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('INSERT-only preservado: o dono segue sem UPDATE de outra coluna e sem DELETE (42501)', async () => {
    const code = async (sql: string) => {
      try {
        await dono.query(sql);
        return 'NENHUM-ERRO';
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(await code(`UPDATE agentes.veredictos SET operador = 'x'`)).toBe('42501');
    expect(await code(`DELETE FROM agentes.veredictos`)).toBe('42501');
    expect(await code(`DELETE FROM agentes.veredicto_achados`)).toBe('42501');
    const { rows } = await dono.query(
      `SELECT has_table_privilege($1, 'agentes.veredictos', 'UPDATE') AS tabela,
              has_column_privilege($1, 'agentes.veredictos', 'operador', 'UPDATE') AS operador,
              has_column_privilege($1, 'agentes.veredictos', 'id', 'UPDATE') AS id,
              has_any_column_privilege('app_runtime', 'agentes.veredictos', 'UPDATE') AS runtime,
              has_any_column_privilege('app_system', 'agentes.veredictos', 'UPDATE') AS sistema`,
      [DONO],
    );
    expect(rows[0]).toEqual({ tabela: false, operador: false, id: true, runtime: false, sistema: false });
  });
});
