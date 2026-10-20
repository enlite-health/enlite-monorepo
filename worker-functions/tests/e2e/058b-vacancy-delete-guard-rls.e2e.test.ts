/**
 * 058b-vacancy-delete-guard-rls.e2e.test.ts @integration — 058b/B2 (T247): a guarda do DELETE de vaga (`countVigenteForVacancy`) sob RLS,
 * com o papel de RUNTIME (`SET LOCAL ROLE app_runtime`, molde `country-rls-policies.test.ts:141-162`), e o lock do serviço que a probe segura
 * até o fim da transação. Teste de BANCO puro (só Postgres; nenhuma API, nenhum canal externo). O stack E2E roda a API como DONO (bypassa RLS):
 * o par "dentro do contexto do ator vê / fora do contexto não vê" só se prova aqui, com o papel de runtime.
 *
 * Postgres do stack (`enlite_e2e`): `app_runtime` vem da migration 269; a alocação vigente é semeada pelo dono (`seedB2`).
 */
import { Pool, PoolClient } from 'pg';
import { seedB2, limparB2, type SeedB2 } from './helpers/seedItinerarioB2';
import { countVigenteForVacancy } from '../../src/modules/case/infrastructure/VacancyAllocationProbe';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `058b-vdrls-${RUN}-`;
const STAFF_UID = `058b-vdrls-staff-${RUN}`;

describe('guarda do DELETE de vaga sob RLS (app_runtime) e lock do serviço (058 P6) @integration', () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  let s: SeedB2;

  beforeAll(async () => {
    // Dono do banco semeia: 1 serviço de 1 faixa, providers_needed 1, 1 titular vigente.
    s = await seedB2(pool, `${TASK_PREFIX}1`, { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1 });
  });

  afterAll(async () => {
    await limparB2(pool, TASK_PREFIX);
  });

  /**
   * Roda `fn` numa transação como a role dada com o contexto dado, e desfaz tudo (espelha o contrato do withActorContext:
   * SET LOCAL, nunca SET). Contexto ausente = fail-closed.
   */
  async function asRole<T>(
    role: 'app_runtime' | 'app_system',
    ctx: { userCountry?: string; userUid?: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      if (ctx.userCountry) await client.query(`SELECT set_config('app.user_country', $1, true)`, [ctx.userCountry]);
      if (ctx.userUid) await client.query(`SELECT set_config('app.user_uid', $1, true)`, [ctx.userUid]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  it('CONTROLE de instrumento: como DONO (bypassa RLS) a probe conta 1', async () => {
    expect(await countVigenteForVacancy(pool, s.vacancyId, new Date())).toBe(1);
  });

  it('app_runtime COM contexto do ator (país AR): a probe conta 1 — a guarda enxerga a alocação sob RLS', async () => {
    const n = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, (c) => countVigenteForVacancy(c, s.vacancyId, new Date()));
    expect(n).toBe(1);
  });

  it('app_runtime SEM contexto (leitura fora do contexto do ator): a probe conta 0 — é exatamente o buraco que a guarda dentro do withActorContext evita', async () => {
    const n = await asRole('app_runtime', {}, (c) => countVigenteForVacancy(c, s.vacancyId, new Date()));
    expect(n).toBe(0);
  });

  it("a probe segura o lock do serviço até o fim da transação: um 2º client não toma pg_try_advisory_xact_lock(hashtext('itinerary:service:' || serviceId)) enquanto o 1º não commita", async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    const tentaLock = async (): Promise<boolean> => {
      const r = await b.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtext('itinerary:service:' || $1::text)) AS ok`, [s.serviceId]);
      return r.rows[0].ok;
    };
    try {
      await a.query('BEGIN');
      await countVigenteForVacancy(a, s.vacancyId, new Date());
      expect(await tentaLock()).toBe(false); // A ainda não terminou: o lock é dela
      await a.query('ROLLBACK');
      expect(await tentaLock()).toBe(true); // A terminou: o lock soltou
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });
});
