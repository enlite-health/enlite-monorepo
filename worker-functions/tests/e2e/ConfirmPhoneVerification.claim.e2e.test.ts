/**
 * T-F3c-136 — `confirm` da finalidade `claim` (AC-6): une com a ficha importada e grava a prova NA MESMA transação; ficha da conta
 * nova com conteúdo → 409 CLAIM_CONFLICT com `handoffUrl`. HTTP real + Postgres real como `enlite_app`; só o envio do código é
 * dublê. Nenhuma mensagem é enviada: o teste confere o link montado.
 */
import { randomUUID } from 'crypto';
import { novaFicha, novoTelefone } from './helpers/phoneVerificationFixtures';
import { startPhoneVerificationHarness, PhoneVerificationHarness } from './helpers/phoneVerificationHarness';

describe('confirm claim: une e verifica na mesma transação', () => {
  let h: PhoneVerificationHarness;
  const envAntes = process.env.TWILIO_WHATSAPP_NUMBER;
  const LUZ = '+5491100009999'; // número FICTÍCIO: o código lê da env, nunca literal
  const digits = (p: string) => p.replace(/\D/g, '');
  beforeAll(async () => {
    process.env.TWILIO_WHATSAPP_NUMBER = LUZ;
    h = await startPhoneVerificationHarness();
  });
  afterAll(async () => {
    if (envAntes === undefined) delete process.env.TWILIO_WHATSAPP_NUMBER; else process.env.TWILIO_WHATSAPP_NUMBER = envAntes;
    await h.close();
  });

  const importada = async (phone: string) =>
    (await h.pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
      [`anacareimport_pv-${randomUUID()}`, `pv-${randomUUID()}@anacareimport.invalid`, phone],
    )).rows[0].id;
  const proof = async (id: string) =>
    (await h.pool.query(
      `SELECT phone, merged_into_id, phone_verified_normalized AS vn, phone_verified_at AS vat, phone_verified_method AS vm,
              phone_verified_otp_challenge_id AS vch, fn_worker_phone_verification_state(id) AS state FROM workers WHERE id = $1`, [id])).rows[0];

  it('T-F3c-136 casca une e grava as colunas na mesma transação (falha ao gravar a prova desfaz a união)', async () => {
    const Q = novoTelefone();
    const x = await novaFicha(h.pool, { phone: null });
    const imp = await importada(Q);
    const caller = h.as(x.id);

    // 1ª rodada: a gravação da prova FALHA (gatilho de teste) → a união inteira desfaz
    await h.pool.query(`CREATE OR REPLACE FUNCTION public.fn_t136_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom t136'; END $$`);
    await h.pool.query(`CREATE TRIGGER trg_t136_boom BEFORE UPDATE OF phone_verified_at ON workers FOR EACH ROW WHEN (NEW.id = '${x.id}') EXECUTE FUNCTION public.fn_t136_boom()`);
    try {
      const s1 = await caller.start({ phone: Q });
      expect(s1.json.data).toMatchObject({ status: 'SENT', code: 'CLAIM_PENDING' });
      const failed = await caller.confirm({ phone: Q, challengeId: s1.json.data.challengeId, code: h.lastCode() });
      expect(failed.status).toBe(500);
      expect(await proof(imp)).toMatchObject({ merged_into_id: null, phone: Q });
      expect(await proof(x.id)).toMatchObject({ phone: null, vn: null, state: 'no_phone' });
    } finally {
      await h.pool.query(`DROP TRIGGER IF EXISTS trg_t136_boom ON workers`);
      await h.pool.query(`DROP FUNCTION IF EXISTS public.fn_t136_boom()`);
    }

    // 2ª rodada: sem a falha, une e verifica juntas
    const s2 = await caller.start({ phone: Q });
    const ok = await caller.confirm({ phone: Q, challengeId: s2.json.data.challengeId, code: h.lastCode() });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ status: 'VERIFIED' });
    expect(await proof(imp)).toMatchObject({ merged_into_id: x.id });
    const after = await proof(x.id);
    expect(after).toMatchObject({ state: 'verified', vn: digits(Q), vm: 'otp_whatsapp_template', vch: s2.json.data.challengeId, merged_into_id: null });
    expect(digits(after.phone)).toBe(digits(Q));
  });

  async function conflito() {
    const Q = novoTelefone();
    const x = await novaFicha(h.pool, { phone: null });
    await h.pool.query(`INSERT INTO worker_documents (worker_id) VALUES ($1)`, [x.id]); // conteúdo: deixa de ser casca
    const imp = await importada(Q);
    const caller = h.as(x.id);
    const s = await caller.start({ phone: Q });
    return { Q, x, imp, caller, s };
  }

  it('T-F3c-136 não-casca: 409 CLAIM_CONFLICT e as colunas phone_verified_* de TODAS as fichas iguais antes e depois', async () => {
    const { Q, x, imp, caller, s } = await conflito();
    const antes = [await proof(x.id), await proof(imp)];
    const r = await caller.confirm({ phone: Q, challengeId: s.json.data.challengeId, code: h.lastCode() });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ success: false, error: 'CLAIM_CONFLICT', code: 'CLAIM_CONFLICT' });
    expect([await proof(x.id), await proof(imp)]).toEqual(antes);
    expect((await proof(x.id)).vn).toBeNull();
  });

  it('T-F3c-136 o 409 traz handoffUrl https://wa.me/ com o texto codificado e o número lido da env', async () => {
    const { Q, caller, s } = await conflito();
    const r = await caller.confirm({ phone: Q, challengeId: s.json.data.challengeId, code: h.lastCode() });
    expect(r.status).toBe(409);
    const url = new URL(r.json.handoffUrl);
    expect(r.json.handoffUrl.startsWith('https://wa.me/')).toBe(true);
    expect(url.pathname).toBe(`/${digits(LUZ)}`);
    expect(url.searchParams.get('text')).toMatch(/^Quiero unir mis datos \(ref\. [A-Z2-9]{4}\)$/);
    expect(r.json.handoffUrl).toContain(encodeURIComponent('Quiero unir mis datos'));
  });

  it('T-F3c-136 o log claim_conflict sai sem telefone, sem nome e sem e-mail', async () => {
    const { logger } = await import('@shared/logging');
    const linhas: string[] = [];
    const orig = logger.child.bind(logger);
    const spy = jest.spyOn(logger, 'child').mockImplementation(((b: Record<string, unknown>) => {
      const real = orig(b);
      for (const nivel of ['info', 'warn', 'error', 'debug'] as const) {
        const f = real[nivel].bind(real);
        (real as any)[nivel] = (...a: unknown[]) => { linhas.push(JSON.stringify([b, a])); return (f as any)(...a); };
      }
      return real;
    }) as never);
    try {
      const { Q, x, caller, s } = await conflito();
      const email = (await h.pool.query(`SELECT email FROM workers WHERE id = $1`, [x.id])).rows[0].email as string;
      const code = h.lastCode();
      const r = await caller.confirm({ phone: Q, challengeId: s.json.data.challengeId, code });
      expect(r.status).toBe(409);
      const conflict = linhas.filter((l) => l.includes('claim_conflict'));
      expect(conflict.length).toBeGreaterThan(0); // controle positivo: o log existe
      const tudo = linhas.join('\n');
      expect(tudo).not.toContain(digits(Q).slice(-8));
      expect(tudo).not.toContain(email);
      expect(tudo).not.toContain(email.split('@')[0]);
      expect(tudo).not.toMatch(new RegExp(`"${code}"|\\b${code}\\b`));
    } finally {
      spy.mockRestore();
    }
  });
});
