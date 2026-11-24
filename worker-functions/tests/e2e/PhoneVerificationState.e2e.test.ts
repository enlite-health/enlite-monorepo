/**
 * T-F3c-131 — "verificado" é DERIVADO (fn_worker_phone_is_verified / fn_worker_phone_verification_state), contra POSTGRES REAL.
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { novaFicha, gravarVerificacao, novoTelefone } from './helpers/phoneVerificationFixtures';
import { startPhoneVerificationHarness } from './helpers/phoneVerificationHarness';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('estado derivado do celular verificado', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  const estado = async (c: { query: Pool['query'] }, id: string) =>
    ((await c.query(`SELECT fn_worker_phone_verification_state($1) AS s`, [id])) as { rows: { s: string }[] }).rows[0].s;
  const colunas = async (c: { query: Pool['query'] }, id: string) =>
    ((await c.query(
      `SELECT phone_verified_normalized, phone_verified_at, phone_verified_method, phone_verified_otp_challenge_id FROM workers WHERE id = $1`,
      [id],
    )) as { rows: unknown[] }).rows[0];

  it('T-F3c-131 trocar workers.phone (caminho da web) leva a unverified SEM UPDATE nas colunas phone_verified_*', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const w = await novaFicha(c);
      await gravarVerificacao(c, w.id);
      expect(await estado(c, w.id)).toBe('verified');
      const antes = await colunas(c, w.id);
      await c.query(`UPDATE workers SET phone = $2 WHERE id = $1`, [w.id, novoTelefone()]);
      expect(await estado(c, w.id)).toBe('unverified');
      expect(await colunas(c, w.id)).toEqual(antes);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('T-F3c-131 a função devolve só no_phone, unverified e verified (nunca NULL), inclusive ficha inexistente', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const sem = await novaFicha(c, { phone: null });
      const vazio = await novaFicha(c, { phone: '' });
      const nunca = await novaFicha(c);
      const prova = await novaFicha(c);
      await gravarVerificacao(c, prova.id);
      const r = [await estado(c, sem.id), await estado(c, vazio.id), await estado(c, nunca.id), await estado(c, prova.id),
        await estado(c, '00000000-0000-0000-0000-0000000000f1')];
      expect(r).toEqual(['no_phone', 'no_phone', 'unverified', 'verified', 'no_phone']);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('T-F3c-131 com A verificada em N, B gravar verificação em N toma 23505 no índice parcial', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await novaFicha(c);
      await gravarVerificacao(c, a.id);
      // B tem o MESMO número normalizado em outra grafia? Aqui: o número de A é livre depois de A trocar; antes, B não pode nem tê-lo.
      const b = await novaFicha(c);
      await c.query('SAVEPOINT s');
      await expect(
        c.query(
          `UPDATE workers SET phone_verified_normalized = (SELECT phone_normalized FROM workers WHERE id = $2),
                  phone_verified_at = now(), phone_verified_method = 'otp_whatsapp_template',
                  phone = (SELECT phone FROM workers WHERE id = $2) WHERE id = $1`,
          [b.id, a.id],
        ),
      ).rejects.toThrow(/idx_workers_phone_unique|uq_workers_phone_verified_now/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      // O índice parcial sozinho: B com phone igual por outro caminho (A já sem o número como telefone, ver caso seguinte).
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('T-F3c-131 com A já sem N como telefone, B verifica N (o índice parcial só vale para a verificada AGORA)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const a = await novaFicha(c);
      await gravarVerificacao(c, a.id);
      const n = a.phone as string;
      await c.query(`UPDATE workers SET phone = $2 WHERE id = $1`, [a.id, novoTelefone()]);
      const b = await novaFicha(c, { phone: n });
      await gravarVerificacao(c, b.id);
      expect(await estado(c, b.id)).toBe('verified');
      expect(await estado(c, a.id)).toBe('unverified');
      // e o índice parcial de fato barra: duas fichas vivas com a prova coincidente no mesmo número (phone único desligado só neste teste)
      const d = await novaFicha(c);
      await c.query(`DROP INDEX idx_workers_phone_unique`);
      await c.query(`UPDATE workers SET phone = $2 WHERE id = $1`, [d.id, n]);
      await expect(
        c.query(
          `UPDATE workers SET phone_verified_normalized = phone_normalized, phone_verified_at = now(), phone_verified_method = 'otp_whatsapp_template' WHERE id = $1`,
          [d.id],
        ),
      ).rejects.toThrow(/uq_workers_phone_verified_now/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('T-F3c-166 o mesmo desafio não prova duas fichas; a prova sai com a ficha', () => {
  const MIGRATION = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '594_phone_verification.sql'), 'utf8');

  it('T-F3c-166 confirmar o mesmo desafio 2x: OTP_ALREADY_USED, e UMA ficha só guarda aquele phone_verified_otp_challenge_id', async () => {
    const h = await startPhoneVerificationHarness();
    try {
      const a = await novaFicha(h.pool, { phone: null });
      const phone = novoTelefone();
      const caller = h.as(a.id);
      const started = await caller.start({ phone });
      const body = { phone, challengeId: started.json.data.challengeId, code: h.lastCode() };
      expect((await caller.confirm(body)).status).toBe(200);

      const again = await caller.confirm(body);
      expect(again.status).toBe(400);
      expect(again.json).toMatchObject({ code: 'OTP_ALREADY_USED' });
      const holders = await h.pool.query(`SELECT count(*)::int AS n FROM workers WHERE phone_verified_otp_challenge_id = $1`, [body.challengeId]);
      expect(holders.rows[0].n).toBe(1);

      // a 2ª barreira, no banco: o índice único parcial da MIGRATION (recriado por ela) recusa outra ficha com o mesmo desafio
      const c = await h.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('DROP INDEX uq_workers_phone_verified_otp_challenge');
        await c.query(MIGRATION);
        const b = await novaFicha(c);
        await expect(gravarVerificacao(c, b.id, body.challengeId)).rejects.toThrow(/uq_workers_phone_verified_otp_challenge/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    } finally {
      await h.close();
    }
  });

  it('T-F3c-166 apagar a conta ("Eliminar mi cuenta"): as colunas phone_verified_* somem com a ficha, sem linha em outra tabela', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const w = await novaFicha(c);
      await gravarVerificacao(c, w.id);
      const norm = (await c.query(`SELECT phone_verified_normalized AS n FROM workers WHERE id = $1`, [w.id])).rows[0].n as string;
      expect(norm).toMatch(/^\d+$/);
      await c.query(`DELETE FROM workers WHERE id = $1`, [w.id]);
      expect((await c.query(`SELECT count(*)::int AS n FROM workers WHERE phone_verified_normalized = $1`, [norm])).rows[0].n).toBe(0);
      // nenhuma outra tabela guarda a prova (seria dado fora do alcance da exclusão)
      const outras = await c.query(
        `SELECT table_name FROM information_schema.columns WHERE column_name LIKE 'phone\\_verified\\_%' AND table_name <> 'workers'`,
      );
      expect(outras.rows).toEqual([]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
      await pool.end();
    }
  });
});
