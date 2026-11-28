/**
 * T-F3c-111 — limites de ENVIO de código por telefone e por ficha, contados no banco: PgOtpChallengeService contra POSTGRES
 * REAL (como `enlite_app`). O teto de 5 tentativas por desafio (adivinhação) já existe e tem teste próprio (T-F3c-110); aqui
 * é o de EMISSÃO. Sender = dublê (nenhuma chamada Twilio, nenhuma rede). Dados sintéticos; código e telefone não entram em log.
 */
import { Pool } from 'pg';
import { PgOtpChallengeService, DEFAULT_OTP_SEND_LIMITS } from '../../src/modules/auth/infrastructure/PgOtpChallengeService';
import { OTP_RATE_LIMITED, type OtpPurpose } from '../../src/modules/auth/ports/OtpChallengePort';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const PEPPER = 'p'.repeat(40);
const MAX = DEFAULT_OTP_SEND_LIMITS.perPhoneInWindow; // 3
let seq = 0;
/** Telefone sintético único por uso: um caso não herda a contagem do outro. */
const novoTelefone = () => `+54911${String(Date.now() % 100000).padStart(5, '0')}${String(seq++).padStart(3, '0')}`;

describe('PgOtpChallengeService — limites de envio por telefone e por ficha (no banco)', () => {
  let pool: Pool;
  let pool2: Pool;
  const workers: string[] = [];
  const sender = { send: jest.fn(async () => ({ twilioSid: 'SM_FAKE', suppressed: false })) };
  const service = (p: Pool = pool) => new PgOtpChallengeService(p, sender, () => PEPPER);

  async function novaFicha(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid) VALUES ($1) RETURNING id`, [`otp-lim-${Date.now()}-${Math.random()}`]);
    workers.push(rows[0].id);
    return rows[0].id;
  }
  const start = (svc: PgOtpChallengeService, workerId: string, phoneE164: string, purpose: OtpPurpose = 'claim') =>
    svc.start({ workerId, purpose, phoneE164, requesterUid: 'uid-teste-1' });
  const linhas = async (col: 'worker_id' | 'phone_e164', val: string) =>
    Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM otp_challenges WHERE ${col} = $1`, [val])).rows[0].n);

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 12 });
    pool2 = new Pool({ connectionString: DATABASE_URL, max: 12 });
  });
  afterAll(async () => {
    if (workers.length) await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [workers]);
    await pool.end();
    await pool2.end();
  });
  beforeEach(() => sender.send.mockClear());

  it('T-F3c-111 N envios para o mesmo telefone na janela → RATE_LIMITED; o excedente não grava, não cancela e não envia', async () => {
    const phone = novoTelefone();
    for (let i = 0; i < MAX; i++) await start(service(), await novaFicha(), phone);
    const pendentes = await pool.query(`SELECT id FROM otp_challenges WHERE phone_e164 = $1 AND status = 'pending'`, [phone]);

    await expect(start(service(), await novaFicha(), phone)).rejects.toThrow(OTP_RATE_LIMITED);

    expect(sender.send).toHaveBeenCalledTimes(MAX);
    expect(await linhas('phone_e164', phone)).toBe(MAX);
    const depois = await pool.query(`SELECT id FROM otp_challenges WHERE phone_e164 = $1 AND status = 'pending'`, [phone]);
    expect(depois.rowCount).toBe(pendentes.rowCount);
  });

  it('T-F3c-111 N envios para a mesma ficha na janela (telefones diferentes) → RATE_LIMITED; o excedente não envia', async () => {
    const w = await novaFicha();
    for (let i = 0; i < MAX; i++) await start(service(), w, novoTelefone());

    await expect(start(service(), w, novoTelefone())).rejects.toThrow(OTP_RATE_LIMITED);

    expect(sender.send).toHaveBeenCalledTimes(MAX);
    expect(await linhas('worker_id', w)).toBe(MAX);
  });

  it('T-F3c-111 a contagem vem do banco: 2 instâncias do serviço somam, e starts simultâneos não furam o teto', async () => {
    const phone = novoTelefone();
    await start(service(pool), await novaFicha(), phone);
    await start(service(pool2), await novaFicha(), phone);
    await start(service(pool), await novaFicha(), phone);
    await expect(start(service(pool2), await novaFicha(), phone)).rejects.toThrow(OTP_RATE_LIMITED);

    const phoneB = novoTelefone();
    const fichas = await Promise.all(Array.from({ length: 8 }, novaFicha));
    const results = await Promise.allSettled(fichas.map((w, i) => start(service(i % 2 ? pool : pool2), w, phoneB)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(MAX);
    expect(results.filter((r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason.message) === OTP_RATE_LIMITED)).toHaveLength(8 - MAX);
    expect(await linhas('phone_e164', phoneB)).toBe(MAX);
  });

  it('T-F3c-111 o envio do código nunca passa pelo teto diário de mensagens (D503): o 2º código do dia sai', async () => {
    // O teto de 1 mensagem/dia/número (D503, spec 053) mora no caminho de envio da plataforma (outbox / disparo). O OTP é a
    // exceção dita: ele NÃO pode depender desse caminho. A prova é negativa e estrutural — nenhum SQL do start toca o que o
    // teto conta (`messaging_outbox`, `whatsapp_bulk_dispatch_logs`) e dois códigos no mesmo dia, no mesmo número, saem.
    const sqls: string[] = [];
    const spy = {
      query: (q: string, v?: unknown[]) => (sqls.push(String(q)), pool.query(q, v as never)),
      connect: async () => {
        const c = await pool.connect();
        const original = c.query.bind(c) as (...a: unknown[]) => unknown;
        // Cliente grafado SÓ para esta chamada (o release o devolve ao pool, então o grampo é desfeito no release).
        const release = c.release.bind(c);
        (c as unknown as { query: unknown }).query = (...a: unknown[]) => (sqls.push(String((a[0] as { text?: string }).text ?? a[0])), original(...a));
        (c as unknown as { release: unknown }).release = (err?: boolean | Error) => {
          (c as unknown as { query: unknown }).query = original;
          (c as unknown as { release: unknown }).release = release;
          return release(err as never);
        };
        return c;
      },
    };
    const svc = new PgOtpChallengeService(spy as never, sender, () => PEPPER);
    const phone = novoTelefone();
    const w = await novaFicha();

    await start(svc, w, phone);
    await start(svc, w, phone);

    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.filter((q) => /messaging_outbox|whatsapp_bulk_dispatch_logs/.test(q))).toEqual([]);
  });

  it('T-F3c-111 os mesmos limites valem para a finalidade phone_verify (e somam com as outras)', async () => {
    const phone = novoTelefone();
    for (let i = 0; i < MAX; i++) await start(service(), await novaFicha(), phone, 'phone_verify');
    await expect(start(service(), await novaFicha(), phone, 'phone_verify')).rejects.toThrow(OTP_RATE_LIMITED);
    await expect(start(service(), await novaFicha(), phone, 'claim')).rejects.toThrow(OTP_RATE_LIMITED);

    const w = await novaFicha();
    await start(service(), w, novoTelefone(), 'claim');
    await start(service(), w, novoTelefone(), 'link');
    await start(service(), w, novoTelefone(), 'phone_verify');
    await expect(start(service(), w, novoTelefone(), 'phone_verify')).rejects.toThrow(OTP_RATE_LIMITED);
  });
});
