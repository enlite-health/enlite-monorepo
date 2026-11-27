/**
 * Harness HTTP do OTP (emenda 077, Fase E): as MESMAS fábricas e rotas que o `src/index.ts` monta (`createClaimController`,
 * `createPhoneVerificationController`, `createClaimRoutes`, `createPhoneVerificationRoutes`, `createAccountLinkRoutes`), numa
 * `express()` do teste com `express.json()`. Importar `src/index` sobe o servidor, por isso a montagem é refeita aqui.
 *
 * Só dois dublês: (1) a autenticação (`requireAuth` = o `mockAuthMiddleware` REAL, token `Bearer mock_<base64>`;
 * `requirePermission` = passa-direto, a decisão de permissão não é objeto destes cenários); (2) o cliente Twilio
 * (`jest.mock('twilio')`): guarda o último código e o destino em memória (o que a cuidadora leria) e pode ser mandado LANÇAR.
 * Nenhuma chamada sai da máquina. Fixtures: só `+5491100000000`, `+5511900000000`, `+12025550123`, uids `uid-teste-*`, `@enlite.test`.
 */
import express from 'express';
import pino from 'pino';
import request from 'supertest';
import type { Server } from 'http';
import { Pool } from 'pg';

// Estado do dublê do Twilio. O prefixo `mock` é o que o jest exige para uma variável ser citada dentro da fábrica do `jest.mock`.
const mockTwilioDuble = {
  /** Último código enviado (OTP próprio: `contentVariables["1"]`) e o destino, sem o prefixo `whatsapp:`. */
  lastCode: '' as string,
  lastTo: '' as string,
  /** Chamadas a `messages.create` (OTP próprio) e a `verifications.create` (plano B, Verify). */
  messagesCalls: 0,
  verifyCalls: 0,
  /** Modo-lança: o envio correspondente rejeita com este erro. */
  messagesThrows: null as Error | null,
  verifyThrows: null as Error | null,
};

jest.mock('twilio', () => {
  const client = {
    messages: {
      create: async (p: { to: string; contentVariables: string }) => {
        mockTwilioDuble.messagesCalls += 1;
        if (mockTwilioDuble.messagesThrows) throw mockTwilioDuble.messagesThrows;
        mockTwilioDuble.lastTo = p.to.replace(/^whatsapp:/, '');
        mockTwilioDuble.lastCode = JSON.parse(p.contentVariables)['1'];
        return { sid: 'SM' + 'a'.repeat(32) };
      },
    },
    verify: {
      v2: {
        services: () => ({
          verifications: {
            create: async (p: { to: string }) => {
              mockTwilioDuble.verifyCalls += 1;
              if (mockTwilioDuble.verifyThrows) throw mockTwilioDuble.verifyThrows;
              mockTwilioDuble.lastTo = p.to;
              return { sid: 'VE' + 'b'.repeat(32), status: 'pending', dateUpdated: new Date() };
            },
          },
          verificationChecks: {
            create: async () => ({ status: 'pending' }),
          },
        }),
      },
    },
  };
  return { __esModule: true, default: () => client };
});

export const twilioDuble = mockTwilioDuble;

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/** Configuração do OTP próprio (ContentSid + pepper + credenciais falsas): faz `createOtpChallengePort` escolher o adapter `own`. */
const ENV_BASE: Record<string, string> = {
  USE_MOCK_AUTH: 'true',
  GCP_PROJECT_ID: 'enlite-e2e',
  DATABASE_URL,
  TWILIO_ACCOUNT_SID: 'ACtesteteste',
  TWILIO_AUTH_TOKEN: 'token-de-teste',
  TWILIO_AUTH_TEMPLATE_CONTENT_SID: 'HXtesteteste',
  TWILIO_WHATSAPP_NUMBER: '+5491100000000',
  OTP_HMAC_PEPPER: 'p'.repeat(40),
  TWILIO_VERIFY_SERVICE_SID: 'VAtesteteste',
};

const envAntes: Record<string, string | undefined> = {};
const poolsAbertos: Pool[] = [];
const servers: Server[] = [];

function aplicarEnv(extra: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries({ ...ENV_BASE, ...extra })) {
    if (!(k in envAntes)) envAntes[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Pool de conexão admin do teste (semear, limpar e contar no banco). Fechado em `fechar()`. */
export function pgTeste(): Pool {
  const pool = new Pool({ connectionString: DATABASE_URL });
  poolsAbertos.push(pool);
  return pool;
}
let poolCompartilhado: Pool | null = null;
export function pool(): Pool {
  poolCompartilhado ??= pgTeste();
  return poolCompartilhado;
}

export interface AppOtp {
  server: Server;
  /** supertest sobre o servidor desta instância (porta efêmera). */
  http: ReturnType<typeof request>;
}

/**
 * Monta a app como o `index.ts`. `env` entra por `process.env` ANTES de as fábricas rodarem (valor `undefined` remove a variável:
 * `{ TWILIO_AUTH_TEMPLATE_CONTENT_SID: undefined }` cai no plano B, Verify). Pode ser chamada várias vezes (duas instâncias, mesmo banco).
 */
export async function montarApp(env: Record<string, string | undefined> = {}): Promise<AppOtp> {
  aplicarEnv(env);
  const { mockAuthMiddleware } = await import('../../../src/modules/identity/infrastructure/MockAuthMiddleware');
  const { createClaimController } = await import('../../../src/bootstrap/createClaimController');
  const { createPhoneVerificationController } = await import('../../../src/bootstrap/createPhoneVerificationController');
  const { createClaimRoutes } = await import('../../../src/modules/auth/interfaces/routes/claimRoutes');
  const { createPhoneVerificationRoutes } = await import('../../../src/modules/auth/interfaces/routes/phoneVerificationRoutes');
  const { createAccountLinkRoutes } = await import('../../../src/modules/account-link/accountLinkRoutes');

  const authMiddleware = {
    requireAuth: () => mockAuthMiddleware,
    requirePermission: () => (_q: express.Request, _s: express.Response, next: express.NextFunction) => next(),
  } as never;
  const accountLinkController = {} as never; // as rotas do vínculo não são exercitadas aqui; só a montagem igual à de produção.

  const app = express();
  app.use(express.json());
  app.use('/api', createClaimRoutes(createClaimController(), authMiddleware));
  app.use('/api', createAccountLinkRoutes(accountLinkController, authMiddleware));
  app.use('/api', createPhoneVerificationRoutes(createPhoneVerificationController(), authMiddleware));

  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  servers.push(server);
  return { server, http: request(server) };
}

/** Token `Bearer mock_<base64>` do cenário: uid `uid-teste-<cenário>`, e-mail `@enlite.test`, claim `country` AR. */
export function tokenDe(uid: string, email: string = `${uid}@enlite.test`): string {
  return 'Bearer mock_' + Buffer.from(JSON.stringify({ uid, email, country: 'AR' })).toString('base64');
}

/** Ficha `REGISTERED` de AR, sem telefone (para o start gravar o número digitado). */
export async function semearFicha(opts: { uid: string; isTest?: boolean; email?: string; phone?: string | null; authUid?: string }): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, phone, status, country, is_test) VALUES ($1, $2, $3, 'REGISTERED', 'AR', $4) RETURNING id`,
    [opts.authUid ?? opts.uid, opts.email ?? `${opts.uid}@enlite.test`, opts.phone ?? null, opts.isTest === true],
  );
  return rows[0].id;
}

/** Antes de cada caso: zera o ledger, os contadores, os desafios e as fichas `uid-teste-*` (banco descartável do projeto docker próprio). */
export async function limpar(): Promise<void> {
  const p = pool();
  await p.query('DELETE FROM otp_send_events');
  await p.query('DELETE FROM rate_limit_counters');
  await p.query('DELETE FROM otp_challenges');
  await p.query(`DELETE FROM workers WHERE auth_uid LIKE 'uid-teste-%' OR auth_uid LIKE 'import_uid-teste-%'`);
  twilioDuble.lastCode = '';
  twilioDuble.lastTo = '';
  twilioDuble.messagesCalls = 0;
  twilioDuble.verifyCalls = 0;
  twilioDuble.messagesThrows = null;
  twilioDuble.verifyThrows = null;
}

/**
 * Captura TODA a saída do processo durante o teste: o stream do pino (que escreve direto no fd 1, sem passar por
 * `process.stdout.write`), `process.stdout.write`, `process.stderr.write` e `console.*`. `reportError` sai pelo `logger.error`,
 * logo cai no stream do pino. Devolve as linhas capturadas e `parar()`.
 */
export async function capturarSaida(): Promise<{ linhas: string[]; parar: () => void }> {
  const { logger } = await import('../../../src/shared/logging');
  const linhas: string[] = [];
  const stream = (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym];
  (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = { write: (s: string) => { linhas.push(String(s)); }, flushSync: () => undefined };
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: unknown }).write = (c: unknown) => { linhas.push(String(c)); return true; };
  (process.stderr as unknown as { write: unknown }).write = (c: unknown) => { linhas.push(String(c)); return true; };
  const metodos = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originais = metodos.map((m) => console[m]);
  metodos.forEach((m) => { console[m] = (...a: unknown[]) => { linhas.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }; });
  return {
    linhas,
    parar: () => {
      (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = stream;
      (process.stdout as unknown as { write: unknown }).write = out;
      (process.stderr as unknown as { write: unknown }).write = err;
      metodos.forEach((m, i) => { console[m] = originais[i]; });
    },
  };
}

/** Fecha servidores, conexões e restaura o `process.env`. */
export async function fechar(): Promise<void> {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().close();
  for (const p of poolsAbertos.splice(0)) await p.end();
  poolCompartilhado = null;
  for (const [k, v] of Object.entries(envAntes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const k of Object.keys(envAntes)) delete envAntes[k];
}
