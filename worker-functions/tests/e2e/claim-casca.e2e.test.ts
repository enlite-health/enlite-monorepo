/**
 * POST /api/auth/claim/confirm — conta que JÁ tem ficha (D764; era o 500 `workers_auth_uid_key` da M-7).
 * HTTP real numa porta efêmera, ClaimController + ConfirmClaimUseCase + ClaimShellAbsorber + WorkerPhoneMergeService +
 * WorkerRepository REAIS, Postgres real, sem mock de dado. Só o Twilio é dublê (checkVerification aprova o código do
 * telefone da ficha; nenhum canal real). Fixtures `@e2e.local`, telefones derivados do carimbo (sem PII).
 */
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createHash } from 'crypto';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('claim confirm com ficha própria (D764)', () => {
  let pool: Pool;
  let server: Server;
  let url = '';
  const stamp = String(Date.now());
  const uid = (n: string) => `e2e-claim-${n}-${stamp}`;
  const email = (n: string) => `${uid(n)}@e2e.local`;
  const phone = (n: number) => `549${String(Number(stamp.slice(-7)) * 10 + n).padStart(10, '0').slice(-10)}`;
  const envAntes: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { if (!(k in envAntes)) envAntes[k] = process.env[k]; process.env[k] = v; };

  const importada = async (n: string, tel: string, isTest = false) =>
    (await pool.query(
      `INSERT INTO workers (auth_uid, email, phone, status, country, is_test) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', $4) RETURNING id`,
      [`anacareimport_${uid(n)}`, `${uid(n)}@anacareimport.invalid`, tel, isTest],
    )).rows[0].id as string;
  const propria = async (n: string, tel: string | null = null, isTest = false) =>
    (await pool.query(
      `INSERT INTO workers (auth_uid, email, phone, status, country, is_test) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', $4) RETURNING id`,
      [uid(n), email(n), tel, isTest],
    )).rows[0].id as string;
  const row = async (id: string) =>
    (await pool.query('SELECT auth_uid, phone, merged_into_id FROM workers WHERE id = $1', [id])).rows[0] as { auth_uid: string; phone: string | null; merged_into_id: string | null };
  const audits = async (survivor: string, absorbed: string) =>
    (await pool.query('SELECT source, executed_by FROM worker_merge_audit WHERE survivor_id = $1 AND absorbed_id = $2', [survivor, absorbed])).rows;

  // B4: o confirm não leva id de ficha; a ficha sai do desafio emitido para o MESMO uid (ledger `otp_send_events`, o que o start grava).
  let sidSeq = 0;
  async function confirm(n: string, candidate: string, candidatePhone: string, extra: Record<string, unknown> = {}) {
    const sid = `VE_STUB_${stamp}_${++sidSeq}`;
    await pool.query(
      `INSERT INTO otp_send_events (challenge_id, adapter, purpose, requester_hash, target_worker_id, suppressed) VALUES ($1, 'verify', 'claim', $2, $3, false)`,
      [sid, createHash('sha256').update(uid(n)).digest('hex'), candidate],
    );
    const res = await fetch(url + '/api/auth/claim/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-uid': uid(n), 'x-test-email': email(n), 'x-test-to': `+${candidatePhone}` },
      body: JSON.stringify({ verificationSid: sid, otp: '123456', ...extra }),
    });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', 'enlite-e2e');
    setEnv('DATABASE_URL', DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
    const { ClaimController } = await import('../../src/modules/auth/interfaces/controllers/ClaimController');
    const { ConfirmClaimUseCase } = await import('../../src/modules/auth/application/ConfirmClaimUseCase');
    const { ClaimShellAbsorber } = await import('../../src/modules/auth/application/ClaimShellAbsorber');
    const { TwilioVerifyOtpAdapter } = await import('../../src/modules/auth/infrastructure/TwilioVerifyOtpAdapter');
    const { WorkerRepository } = await import('../../src/modules/worker/infrastructure/WorkerRepository');
    const { ResolveClaimTarget } = await import('../../src/modules/auth/application/ResolveClaimTarget');
    const { PgOtpSendLedger } = await import('../../src/modules/auth/infrastructure/PgOtpSendLedger');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    // Twilio: o único dublê. `to` vem do cabeçalho do teste (telefone da ficha reclamada).
    let to = '';
    const twilio = { startVerification: async () => ({ verificationSid: 'VE_STUB' }), checkVerification: async () => ({ valid: true, status: 'approved', to }) };
    const useCase = new ConfirmClaimUseCase(new WorkerRepository(), new TwilioVerifyOtpAdapter(twilio as never), new ClaimShellAbsorber(DatabaseConnection.getInstance().getPool()));
    const controller = new ClaimController({} as never, useCase, new ResolveClaimTarget(new PgOtpSendLedger(pool)));
    const app = express();
    app.use(express.json());
    app.post('/api/auth/claim/confirm', (req, res) => {
      (req as any).user = { uid: req.headers['x-test-uid'], email: req.headers['x-test-email'] };
      to = String(req.headers['x-test-to']);
      return controller.confirm(req, res);
    });
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    const ids = (await pool.query('SELECT id FROM workers WHERE auth_uid LIKE $1 OR auth_uid LIKE $2', [`e2e-claim-%-${stamp}`, `anacareimport_e2e-claim-%-${stamp}`])).rows.map((r) => r.id);
    await pool.query('DELETE FROM otp_send_events WHERE challenge_id LIKE $1', [`VE_STUB_${stamp}_%`]).catch(() => {});
    await pool.query('DELETE FROM worker_merge_audit WHERE survivor_id = ANY($1::uuid[]) OR absorbed_id = ANY($1::uuid[])', [ids]).catch(() => {});
    await pool.query('DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])', [ids]).catch(() => {});
    await pool.query('UPDATE workers SET merged_into_id = NULL WHERE id = ANY($1::uuid[])', [ids]).catch(() => {});
    await pool.query('DELETE FROM workers WHERE id = ANY($1::uuid[])', [ids]).catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await pool.end();
    for (const [k, v] of Object.entries(envAntes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('T-D764 (a) uid com casca + importada: 200, X segura o uid e herda o telefone, importada absorvida e auditada', async () => {
    const x = await propria('a');
    const imp = await importada('a', phone(1));
    const r = await confirm('a', imp, phone(1));
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/duplicate key|workers_auth_uid_key/);
    expect(await row(imp)).toMatchObject({ merged_into_id: x });
    expect(await row(x)).toMatchObject({ auth_uid: uid('a'), phone: phone(1), merged_into_id: null });
    expect(await audits(x, imp)).toEqual([{ source: 'claim_shell', executed_by: uid('a') }]);
    const consent = (await pool.query('SELECT lgpd_consent_at, terms_accepted_at, privacy_accepted_at FROM workers WHERE id = $1', [x])).rows[0];
    // O OTP prova a posse do telefone, não o aceite: sem a caixa marcada (lgpdOptIn) o trio continua NULL.
    expect(consent).toEqual({ lgpd_consent_at: null, terms_accepted_at: null, privacy_accepted_at: null });
  });

  it('T-D764 (a) com lgpdOptIn:true (a web marcou a caixa) o aceite é gravado em X, na transação da absorção', async () => {
    const x = await propria('aopt');
    const imp = await importada('aopt', phone(9));
    const r = await confirm('aopt', imp, phone(9), { lgpdOptIn: true });
    expect(r.status).toBe(200);
    const consent = (await pool.query('SELECT lgpd_consent_at, terms_accepted_at, privacy_accepted_at FROM workers WHERE id = $1', [x])).rows[0];
    expect(consent.lgpd_consent_at).not.toBeNull();
    expect(consent.terms_accepted_at).not.toBeNull();
    expect(consent.privacy_accepted_at).not.toBeNull();
  });

  it('T-D764 (b) ficha própria com telefone: 409 CLAIM_CONFLICT, rollback total (nada mudou, sem texto do banco)', async () => {
    const x = await propria('b', phone(3));
    const imp = await importada('b', phone(2));
    const r = await confirm('b', imp, phone(2));
    expect(r.status).toBe(409);
    expect(JSON.parse(r.text)).toEqual({ success: false, error: 'CLAIM_CONFLICT', code: 'CLAIM_CONFLICT' });
    expect(await row(imp)).toMatchObject({ merged_into_id: null, phone: phone(2) });
    expect(await row(x)).toMatchObject({ phone: phone(3), merged_into_id: null });
    expect(await audits(x, imp)).toEqual([]);
  });

  it('T-D764 (b) ficha própria com documento: 409 CLAIM_CONFLICT e nada mudou', async () => {
    const x = await propria('bdoc');
    await pool.query('INSERT INTO worker_documents (worker_id) VALUES ($1)', [x]);
    const imp = await importada('bdoc', phone(4));
    const r = await confirm('bdoc', imp, phone(4));
    expect(r.status).toBe(409);
    expect(await row(imp)).toMatchObject({ merged_into_id: null });
    expect(await audits(x, imp)).toEqual([]);
  });

  it('T-D764 (b) is_test diferente entre a ficha própria e a importada: 409 CLAIM_CONFLICT', async () => {
    const x = await propria('btest', null, true);
    const imp = await importada('btest', phone(5), false);
    const r = await confirm('btest', imp, phone(5));
    expect(r.status).toBe(409);
    expect(await row(imp)).toMatchObject({ merged_into_id: null });
    expect(await audits(x, imp)).toEqual([]);
  });

  it('T-D764 (c) uid sem ficha: comportamento de hoje (200, a importada ganha o uid do token)', async () => {
    const imp = await importada('c', phone(6));
    const r = await confirm('c', imp, phone(6));
    expect(r.status).toBe(200);
    expect(await row(imp)).toMatchObject({ auth_uid: uid('c'), merged_into_id: null });
  });
});
