/**
 * account-link.test.ts — unit (pool/twilio/merge mockados) do contrato v2.
 *
 * Cobre:
 *   linkToken   → roundtrip, purpose errado, expirado, adulterado, sem segredo
 *   maskers     → email/telefone nunca vazam identidade completa
 *   flagGate    → ACCOUNT_LINK_ENABLED!=='true' → 404
 *   Service:
 *     lookup    → NO_CONFLICT (livre/é a própria), USE_CLAIM (importada), ok mascarado
 *     start     → rate-limit 3/h por conta; OTP vai pro número DA FICHA (E164)
 *     confirm   → INVALID/EXPIRED_OTP; degrau alto-valor DEPOIS do OTP;
 *                 conflitos → linkToken (sem merge); sem conflito → merge direto
 *     finalize  → token de outra conta → INVALID_LINK_TOKEN
 */

jest.mock('@shared/logging', () => ({
  logger:      { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls:  { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));
jest.mock('../accountLinkNotice', () => ({ sendLinkedNoticeEmail: jest.fn().mockResolvedValue(undefined) }));

import type { Pool } from 'pg';
import { AccountLinkService } from '../AccountLinkService';
import { maskEmail, maskPhone } from '../AccountLinkService';
import { AccountLinkError } from '../AccountLinkTypes';
import { signLinkToken, verifyLinkToken, FINALIZE_TOKEN_TTL_MS } from '../linkToken';

const LOGGED = 'aaaaaaaa-0000-0000-0000-000000000001';
const OWNER  = 'bbbbbbbb-0000-0000-0000-000000000002';

beforeAll(() => { process.env.ACCOUNT_LINK_TOKEN_SECRET = 'unit-test-secret'; });

// ── linkToken ──────────────────────────────────────────────────────────────

describe('linkToken', () => {
  const payload = { purpose: 'finalize' as const, survivorId: LOGGED, absorbedId: OWNER, exp: Date.now() + FINALIZE_TOKEN_TTL_MS };

  it('roundtrip válido', () => {
    const t = signLinkToken(payload);
    expect(verifyLinkToken(t, 'finalize')).toMatchObject({ survivorId: LOGGED, absorbedId: OWNER });
  });

  it('purpose errado → null', () => {
    expect(verifyLinkToken(signLinkToken(payload), 'undo')).toBeNull();
  });

  it('expirado → null', () => {
    const t = signLinkToken({ ...payload, exp: Date.now() - 1000 });
    expect(verifyLinkToken(t, 'finalize')).toBeNull();
  });

  it('adulterado → null', () => {
    const t = signLinkToken(payload);
    const forged = Buffer.from(JSON.stringify({ ...payload, survivorId: OWNER })).toString('base64url');
    expect(verifyLinkToken(`${forged}.${t.split('.')[1]}`, 'finalize')).toBeNull();
  });

  it('sem segredo configurado → lança (nunca default previsível)', () => {
    const saved = process.env.ACCOUNT_LINK_TOKEN_SECRET;
    delete process.env.ACCOUNT_LINK_TOKEN_SECRET;
    expect(() => signLinkToken(payload)).toThrow(/not configured/);
    process.env.ACCOUNT_LINK_TOKEN_SECRET = saved;
  });
});

// ── maskers ────────────────────────────────────────────────────────────────

describe('maskers', () => {
  it('maskEmail preserva domínio e esconde o miolo', () => {
    expect(maskEmail('ketekoso.srl1969@gmail.com')).toBe('kete•••@gmail.com');
    expect(maskEmail(null)).toBe('•••');
  });
  it('maskPhone mostra só os 4 finais', () => {
    expect(maskPhone('5491133336012')).toBe('•••••••••6012');
  });
});

// ── Service (pool roteado por padrão de SQL) ───────────────────────────────

type Row = Record<string, unknown>;

function makeService(opts: {
  logged?: Row | null;
  owner?: Row | null;
  startedLastHour?: number;
  highValue?: boolean;
  conflictRows?: Row[];
  twilioCheck?: { valid: boolean; status: 'approved' | 'pending' | 'expired' | 'canceled' };
}) {
  const {
    logged = { id: LOGGED, email: 'nueva@x.com', auth_uid: 'FirebaseNew', phone: null, updated_at: new Date('2026-08-01'), merged_into_id: null },
    owner  = { id: OWNER, email: 'vieja@x.com', auth_uid: 'FirebaseOld', phone: '5491133336012', updated_at: new Date('2026-07-01') },
    startedLastHour = 0,
    highValue = false,
    conflictRows = [],
    twilioCheck = { valid: true, status: 'approved' as const },
  } = opts;

  const calls: string[] = [];
  const pool = {
    query: jest.fn().mockImplementation((sql: string) => {
      calls.push(sql);
      if (sql.includes('WHERE auth_uid')) return Promise.resolve({ rows: logged ? [logged] : [] });
      if (sql.includes('phone = ANY')) return Promise.resolve({ rows: owner ? [owner] : [] });
      if (sql.includes("event = 'started'")) return Promise.resolve({ rows: [{ cnt: String(startedLastHour) }] });
      if (sql.includes('INSERT INTO account_link_events')) return Promise.resolve({ rows: [] });
      if (sql.includes('worker_job_applications')) return Promise.resolve({ rows: [{ high: highValue }] });
      if (sql.includes('SELECT id, updated_at')) return Promise.resolve({ rows: conflictRows });
      if (sql.includes('rows_reparented')) return Promise.resolve({ rows: [{ rows_reparented: { worker_availability: 1 } }] });
      if (sql.includes('SELECT status FROM workers')) return Promise.resolve({ rows: [{ status: 'REGISTERED' }] });
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;

  const twilio = {
    startVerification: jest.fn().mockResolvedValue({ verificationSid: 'VE-test' }),
    checkVerification: jest.fn().mockResolvedValue(twilioCheck),
  };
  const adminMerge = { execute: jest.fn().mockResolvedValue({ audit_ids: [77], survivor_id: LOGGED, absorbed_ids: [OWNER] }) };

  const service = new AccountLinkService(pool, {
    twilio: twilio as never,
    adminMerge: adminMerge as never,
    encryption: { decrypt: jest.fn().mockResolvedValue('') } as never,
  });
  return { service, twilio, adminMerge, calls };
}

describe('AccountLinkService.lookup', () => {
  it('telefone livre → NO_CONFLICT', async () => {
    const { service } = makeService({ owner: null });
    await expect(service.lookup('FirebaseNew', '1133336012')).rejects.toMatchObject({ code: 'NO_CONFLICT' });
  });

  it('dona é a própria conta logada → NO_CONFLICT', async () => {
    const { service } = makeService({ owner: { id: LOGGED, email: 'nueva@x.com', auth_uid: 'FirebaseNew', phone: '549', updated_at: new Date() } });
    await expect(service.lookup('FirebaseNew', '1133336012')).rejects.toMatchObject({ code: 'NO_CONFLICT' });
  });

  it('dona importada → USE_CLAIM', async () => {
    const { service } = makeService({ owner: { id: OWNER, email: 'x@enlite.import', auth_uid: 'base1import_z', phone: '549', updated_at: new Date() } });
    await expect(service.lookup('FirebaseNew', '1133336012')).rejects.toMatchObject({ code: 'USE_CLAIM' });
  });

  it('dona real → mascarados, sem valores', async () => {
    const { service, twilio } = makeService({});
    const out = await service.lookup('FirebaseNew', '1133336012');
    expect(out).toEqual({ otherEmailMasked: 'vie•••@x.com', phoneMasked: '•••••••••6012' });
    expect(twilio.startVerification).not.toHaveBeenCalled(); // lookup NUNCA envia SMS
  });
});

describe('AccountLinkService.start', () => {
  it('4º start na hora → RATE_LIMITED (sem tocar o Twilio)', async () => {
    const { service, twilio } = makeService({ startedLastHour: 3 });
    await expect(service.start('FirebaseNew', '1133336012')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(twilio.startVerification).not.toHaveBeenCalled();
  });

  it('OTP vai pro número DA FICHA em E164 (anti-hijack)', async () => {
    const { service, twilio } = makeService({});
    const out = await service.start('FirebaseNew', '9999999999');
    expect(twilio.startVerification).toHaveBeenCalledWith('+5491133336012');
    expect(out.verificationSid).toBe('VE-test');
  });
});

describe('AccountLinkService.confirm', () => {
  it('código errado → INVALID_OTP; expirado → EXPIRED_OTP', async () => {
    const bad = makeService({ twilioCheck: { valid: false, status: 'pending' } });
    await expect(bad.service.confirm('FirebaseNew', '1133336012', 'VE', '000000')).rejects.toMatchObject({ code: 'INVALID_OTP' });
    const exp = makeService({ twilioCheck: { valid: false, status: 'expired' } });
    await expect(exp.service.confirm('FirebaseNew', '1133336012', 'VE', '000000')).rejects.toMatchObject({ code: 'EXPIRED_OTP' });
  });

  it('conta antiga de alto valor → REQUIRES_REVIEW e NENHUM merge', async () => {
    const { service, adminMerge } = makeService({ highValue: true });
    const out = await service.confirm('FirebaseNew', '1133336012', 'VE', '123456');
    expect(out).toEqual({ status: 'REQUIRES_REVIEW' });
    expect(adminMerge.execute).not.toHaveBeenCalled();
  });

  it('conflito real → linkToken + suggested mais recente, SEM merge ainda', async () => {
    const { service, adminMerge } = makeService({
      conflictRows: [
        { id: LOGGED, updated_at: new Date('2026-08-01'), profession: 'AT', knowledge_level: null, years_experience: null },
        { id: OWNER, updated_at: new Date('2026-07-01'), profession: 'CAREGIVER', knowledge_level: null, years_experience: null },
      ],
    });
    const out = await service.confirm('FirebaseNew', '1133336012', 'VE', '123456');
    if (out.status !== 'conflicts') throw new Error(`esperava conflicts, veio ${out.status}`);
    expect(out.conflicts.map(c => c.field)).toEqual(['profession']);
    expect(out.conflicts[0].suggested).toBe(LOGGED); // updated_at mais recente
    expect(verifyLinkToken(out.linkToken, 'finalize')).toMatchObject({ survivorId: LOGGED, absorbedId: OWNER });
    expect(adminMerge.execute).not.toHaveBeenCalled();
  });

  it('sem conflito → merge direto com source self_service_link + recovered', async () => {
    const { service, adminMerge } = makeService({});
    const out = await service.confirm('FirebaseNew', '1133336012', 'VE', '123456');
    expect(out).toMatchObject({ status: 'merged', recovered: { worker_availability: 1 }, workerStatus: 'REGISTERED' });
    expect(adminMerge.execute).toHaveBeenCalledWith(expect.objectContaining({
      survivorId: LOGGED, absorbedIds: [OWNER],
      audit: expect.objectContaining({ source: 'self_service_link' }),
    }));
  });
});

describe('AccountLinkService.finalize', () => {
  it('token de OUTRA conta logada → INVALID_LINK_TOKEN', async () => {
    const { service } = makeService({});
    const stolen = { purpose: 'finalize' as const, survivorId: OWNER, absorbedId: LOGGED, exp: Date.now() + 60000 };
    await expect(service.finalize('FirebaseNew', stolen, undefined)).rejects.toMatchObject({ code: 'INVALID_LINK_TOKEN' });
  });
});

// ── flagGate (rotas) ───────────────────────────────────────────────────────

describe('flag ACCOUNT_LINK_ENABLED', () => {
  it('OFF → toda rota responde 404 (prod neutro)', async () => {
    const saved = process.env.ACCOUNT_LINK_ENABLED;
    delete process.env.ACCOUNT_LINK_ENABLED;
    const { createAccountLinkRoutes } = await import('../accountLinkRoutes');
    const router = createAccountLinkRoutes(
      {} as never,
      { requireAuth: () => (_r: unknown, _s: unknown, n: () => void) => n(),
        requirePermission: () => (_r: unknown, _s: unknown, n: () => void) => n() } as never,
    );
    // Percorre o stack do router simulando um request na rota de lookup
    const layer = (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: (req: unknown, res: unknown, next: () => void) => void }> } }> })
      .stack.find(l => l.route?.path === '/workers/me/account-link/lookup');
    expect(layer).toBeDefined();
    const res = { statusCode: 0, body: null as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; } };
    layer!.route!.stack[0].handle({ headers: {} }, res, () => { throw new Error('não deveria passar do gate'); });
    expect(res.statusCode).toBe(404);
    if (saved !== undefined) process.env.ACCOUNT_LINK_ENABLED = saved;
  });
});

// ── AccountLinkError shape ────────────────────────────────────────────────

describe('AccountLinkError', () => {
  it('carrega código estável', () => {
    const e = new AccountLinkError('USE_CLAIM');
    expect(e.code).toBe('USE_CLAIM');
    expect(e.name).toBe('AccountLinkError');
  });
});
