/**
 * Harness HTTP do celular verificado (PR-INF-47): PhoneVerificationController + use cases + WorkerRepository + PgOtpChallengeService +
 * ClaimShellAbsorber REAIS, Postgres real como `enlite_app`. O único dublê é o ENVIO do código (nenhum canal real): o sender guarda o
 * último código em memória, que é o que a cuidadora leria no WhatsApp. Identidade do token por cabeçalho `x-test-*`.
 */
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const PEPPER = 'p'.repeat(40);

export interface PhoneVerificationHarness {
  pool: Pool;
  /** Último código "enviado" e o telefone de destino (o que a Twilio receberia). */
  sent: Array<{ toE164: string; code: string }>;
  lastCode(): string;
  /** Chama a rota como a ficha `workerId` (uid e e-mail lidos do banco). */
  as(workerId: string): {
    start(body: Record<string, unknown>): Promise<{ status: number; json: any }>;
    confirm(body: Record<string, unknown>): Promise<{ status: number; json: any }>;
  };
  /** Abre um desafio direto no port (sem passar pela rota), para cenários em que o `start` recusaria. */
  openChallenge(workerId: string, purpose: 'phone_verify' | 'claim', phoneE164: string): Promise<{ challengeId: string; code: string }>;
  setTokenEmail(email: string | null): void;
  close(): Promise<void>;
}

export async function startPhoneVerificationHarness(
  opts: { onClaimConflictLog?: (line: unknown) => void } = {},
): Promise<PhoneVerificationHarness> {
  process.env.USE_MOCK_AUTH = 'true';
  process.env.GCP_PROJECT_ID = 'enlite-e2e';
  process.env.DATABASE_URL = DATABASE_URL;
  void opts;
  const pool = new Pool({ connectionString: DATABASE_URL });
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  const { WorkerRepository } = await import('../../../src/modules/worker/infrastructure/WorkerRepository');
  const { PgPhoneVerificationRepository } = await import('../../../src/modules/worker/infrastructure/PgPhoneVerificationRepository');
  const { PgOtpChallengeService, DEFAULT_OTP_SEND_LIMITS } = await import('../../../src/modules/auth/infrastructure/PgOtpChallengeService');
  const { ConfirmClaimUseCase } = await import('../../../src/modules/auth/application/ConfirmClaimUseCase');
  const { ClaimShellAbsorber } = await import('../../../src/modules/auth/application/ClaimShellAbsorber');
  const { StartPhoneVerificationUseCase } = await import('../../../src/modules/auth/application/StartPhoneVerificationUseCase');
  const { ConfirmPhoneVerificationUseCase } = await import('../../../src/modules/auth/application/ConfirmPhoneVerificationUseCase');
  const { PhoneVerificationController } = await import('../../../src/modules/auth/interfaces/controllers/PhoneVerificationController');

  const sent: Array<{ toE164: string; code: string }> = [];
  const sender = { send: async ({ toE164, code }: { toE164: string; code: string }) => { sent.push({ toE164, code }); return { twilioSid: 'SM_FAKE', suppressed: false }; } };
  const semLimite = { ...DEFAULT_OTP_SEND_LIMITS, perPhoneInWindow: 1e6, perWorkerInWindow: 1e6, perPhonePerDay: 1e6, perWorkerPerDay: 1e6 };
  const appPool = DatabaseConnection.getInstance().getPool();
  const otp = new PgOtpChallengeService(appPool, sender, () => PEPPER, undefined, semLimite);
  const workers = new WorkerRepository();
  const verification = new PgPhoneVerificationRepository(appPool);
  const claim = new ConfirmClaimUseCase(workers, otp, new ClaimShellAbsorber(appPool));
  const controller = new PhoneVerificationController(
    new StartPhoneVerificationUseCase(workers, verification, otp),
    new ConfirmPhoneVerificationUseCase(workers, verification, otp, claim, appPool),
  );

  let tokenEmailOverride: string | null | undefined;
  const app = express();
  app.use(express.json());
  const withUser = (h: (req: express.Request, res: express.Response) => Promise<void>) => (req: express.Request, res: express.Response) => {
    (req as any).user = { uid: req.headers['x-test-uid'], email: tokenEmailOverride ?? req.headers['x-test-email'] };
    return h(req, res);
  };
  app.post('/start', withUser((q, s) => controller.start(q, s)));
  app.post('/confirm', withUser((q, s) => controller.confirm(q, s)));
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;

  async function post(path: string, workerId: string, body: Record<string, unknown>) {
    const { rows } = await pool.query<{ auth_uid: string; email: string }>(`SELECT auth_uid, email FROM workers WHERE id = $1`, [workerId]);
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-uid': rows[0].auth_uid, 'x-test-email': rows[0].email },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  return {
    pool,
    sent,
    lastCode: () => sent[sent.length - 1]?.code ?? '',
    as: (workerId) => ({ start: (b) => post('/start', workerId, b), confirm: (b) => post('/confirm', workerId, b) }),
    async openChallenge(workerId, purpose, phoneE164) {
      const { challengeId } = await otp.start({ workerId, purpose, phoneE164 });
      return { challengeId, code: sent[sent.length - 1].code };
    },
    setTokenEmail(e) { tokenEmailOverride = e; },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await DatabaseConnection.getInstance().close();
      await pool.end();
    },
  };
}
