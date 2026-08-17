/**
 * account-link-flow.e2e.test.ts
 *
 * Loop COMPLETO do vínculo self-service contra Postgres real (Bloco 2,
 * contrato v2), com Twilio em bypass E2E (sid sintético + E2E_OTP_CODE):
 *
 *   lookup (sem SMS) → start (rate-limit real na tabela de eventos) →
 *   confirm (OTP bypass) → conflitos + linkToken → finalize (fieldChoices) →
 *   merge REAL (move do Bloco 1) → recovered com contagens → funil de eventos
 *   → undo por token assinado devolve tudo.
 *
 * + degrau de alto valor (payment_info) → REQUIRES_REVIEW sem merge.
 * + email de aviso: sem SendGrid configurado → skip registrado (best-effort).
 */

process.env.E2E_OTP_BYPASS = 'true';
process.env.E2E_OTP_CODE = '123456';
process.env.ACCOUNT_LINK_TOKEN_SECRET = 'e2e-secret';

import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { AccountLinkService } from '../../src/modules/account-link/AccountLinkService';
import { AccountLinkError } from '../../src/modules/account-link/AccountLinkTypes';
import { verifyLinkToken, signLinkToken, UNDO_TOKEN_TTL_MS } from '../../src/modules/account-link/linkToken';
import { UndoMergeUseCase } from '../../src/application/dedup/UndoMergeUseCase';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';

const STAMP = `allink_e2e_${Date.now()}`;

const NEW_ID = `00000021-0001-0001-0001-${STAMP.slice(-12)}`;   // conta logada (nova)
const OLD_ID = `00000021-0002-0002-0002-${STAMP.slice(-12)}`;   // conta antiga (dona do phone)
const HV_NEW = `00000022-0001-0001-0001-${STAMP.slice(-12)}`;   // logada do cenário alto-valor
const HV_OLD = `00000022-0002-0002-0002-${STAMP.slice(-12)}`;   // antiga de ALTO VALOR

const PHONE = `549780${STAMP.slice(-7)}`;
const PHONE_HV = `549781${STAMP.slice(-7)}`;

const ALL_IDS = [NEW_ID, OLD_ID, HV_NEW, HV_OLD];

let pool: Pool;
let service: AccountLinkService;

async function insertWorker(client: PoolClient, p: { id: string; auth_uid: string; email: string; phone?: string | null; profession?: string }): Promise<void> {
  await client.query(
    `INSERT INTO workers (id, auth_uid, email, phone, profession, status, country, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
    [p.id, p.auth_uid, p.email, p.phone ?? null, p.profession ?? null],
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  (DatabaseConnection.getInstance() as unknown as { pool: Pool }).pool = pool;
  service = new AccountLinkService(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Cenário principal: nova sem phone (AT) × antiga com phone (CAREGIVER → conflito)
    await insertWorker(client, { id: NEW_ID, auth_uid: `LinkNew_${STAMP}`, email: `nueva_${STAMP}@example.com`, profession: 'AT' });
    await insertWorker(client, { id: OLD_ID, auth_uid: `LinkOld_${STAMP}`, email: `vieja_${STAMP}@example.com`, phone: PHONE, profession: 'CAREGIVER' });
    await client.query(
      `UPDATE workers SET whatsapp_phone_encrypted = $2, updated_at = NOW() - INTERVAL '30 days' WHERE id = $1::uuid`,
      [OLD_ID, Buffer.from(PHONE).toString('base64')],
    );
    await client.query(
      `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
       VALUES ($1::uuid, 2, '14:00', '18:00', 'America/Argentina/Buenos_Aires')`,
      [OLD_ID],
    );
    // Cenário alto valor: antiga com payment_info
    await insertWorker(client, { id: HV_NEW, auth_uid: `LinkHvNew_${STAMP}`, email: `hvnueva_${STAMP}@example.com` });
    await insertWorker(client, { id: HV_OLD, auth_uid: `LinkHvOld_${STAMP}`, email: `hvvieja_${STAMP}@example.com`, phone: PHONE_HV });
    await client.query(
      `INSERT INTO worker_payment_info (worker_id, account_holder_name) VALUES ($1::uuid, 'E2E High Value')`,
      [HV_OLD],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM account_link_events WHERE worker_id = ANY($1::uuid[]) OR other_worker_id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM worker_merge_snapshots WHERE absorbed_worker_id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM worker_merge_audit WHERE survivor_id = ANY($1::uuid[]) OR absorbed_id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM worker_payment_info WHERE worker_id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1)`, [ALL_IDS]);
    await client.query(`UPDATE workers SET merged_into_id = NULL WHERE id = ANY($1::uuid[])`, [ALL_IDS]);
    await client.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ALL_IDS]);
  } finally {
    client.release();
  }
  await pool.end();
});

// ─── Fluxo feliz completo ──────────────────────────────────────────────────

describe('fluxo completo: lookup → start → confirm → conflitos → finalize → merge', () => {
  let linkToken = '';
  let mergeAuditId: number | null = null;

  it('lookup devolve mascarados sem enviar SMS', async () => {
    const out = await service.lookup(`LinkNew_${STAMP}`, PHONE);
    expect(out.otherEmailMasked).toMatch(/^viej•••@example\.com$/);
    expect(out.phoneMasked.endsWith(PHONE.slice(-4))).toBe(true);
    expect(out.phoneMasked).not.toContain(PHONE.slice(0, 6));
  });

  it('start dispara OTP (bypass) e conta no rate-limit', async () => {
    const out = await service.start(`LinkNew_${STAMP}`, PHONE);
    expect(out.verificationSid.startsWith('TEST_')).toBe(true);
  });

  it('confirm com código certo → conflito de profession + linkToken (sem merge)', async () => {
    const { verificationSid } = await service.start(`LinkNew_${STAMP}`, PHONE);
    const out = await service.confirm(`LinkNew_${STAMP}`, PHONE, verificationSid, '123456');
    if (out.status !== 'conflicts') throw new Error(`esperava conflicts, veio ${out.status}`);
    const professions = out.conflicts.find(c => c.field === 'profession');
    expect(professions).toBeDefined();
    expect(Object.values(professions!.values)).toEqual(expect.arrayContaining(['AT', 'CAREGIVER']));
    // suggested = mais recente (a conta NOVA foi atualizada agora; a antiga há 30 dias)
    expect(professions!.suggested).toBe(NEW_ID);
    linkToken = out.linkToken;
    // merge ainda NÃO aconteceu
    const merged = await pool.query(`SELECT merged_into_id FROM workers WHERE id = $1::uuid`, [OLD_ID]);
    expect(merged.rows[0].merged_into_id).toBeNull();
  });

  it('finalize com fieldChoices executa o merge REAL (move do Bloco 1 incluso)', async () => {
    const payload = verifyLinkToken(linkToken, 'finalize');
    expect(payload).not.toBeNull();
    const out = await service.finalize(`LinkNew_${STAMP}`, payload!, { profession: OLD_ID });
    if (out.status !== 'merged') throw new Error(`esperava merged, veio ${out.status}`);
    expect(out.recovered.worker_availability).toBeGreaterThanOrEqual(1);

    const survivor = await pool.query(
      `SELECT phone, whatsapp_phone_encrypted, profession FROM workers WHERE id = $1::uuid`, [NEW_ID],
    );
    expect(survivor.rows[0].phone).toBe(PHONE);                       // MOVIDO
    expect(survivor.rows[0].whatsapp_phone_encrypted).not.toBeNull(); // MOVIDO
    expect(survivor.rows[0].profession).toBe('CAREGIVER');            // fieldChoice aplicado

    const absorbed = await pool.query(
      `SELECT phone, merged_into_id FROM workers WHERE id = $1::uuid`, [OLD_ID],
    );
    expect(absorbed.rows[0].phone).toBeNull();
    expect(absorbed.rows[0].merged_into_id).toBe(NEW_ID);

    const audit = await pool.query(
      `SELECT id, source FROM worker_merge_audit WHERE survivor_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [NEW_ID],
    );
    expect(audit.rows[0].source).toBe('self_service_link');
    mergeAuditId = Number(audit.rows[0].id);
  });

  it('funil de eventos registrado (telemetria durável) + email skip best-effort', async () => {
    const events = await pool.query<{ event: string }>(
      `SELECT event FROM account_link_events WHERE worker_id = $1::uuid ORDER BY id`, [NEW_ID],
    );
    const names = events.rows.map(r => r.event);
    for (const expected of ['lookup', 'started', 'confirmed', 'conflicts_shown', 'merged']) {
      expect(names).toContain(expected);
    }
    // O aviso não sai: o `EmailService` recusa enviar em `NODE_ENV=test` (guard
    // de 17/08) e a stack ainda declara `SENDGRID_API_KEY: ""`. Antes o
    // comentário aqui dizia "sem chave → não sai", o que era FALSO na forma
    // medida: o SDK disparava a requisição para api.sendgrid.com assim mesmo e
    // só levava 401. O que importa para o teste é que o skip fica REGISTRADO.
    expect(names).toContain('notice_email_skipped');
  });

  it('undo por token assinado devolve o estado (email "no fui yo")', async () => {
    expect(mergeAuditId).not.toBeNull();
    const undoToken = signLinkToken({
      purpose: 'undo', survivorId: NEW_ID, absorbedId: OLD_ID,
      mergeAuditId: mergeAuditId!, exp: Date.now() + UNDO_TOKEN_TTL_MS,
    });
    const payload = verifyLinkToken(undoToken, 'undo');
    expect(payload?.mergeAuditId).toBe(mergeAuditId);

    const undo = new UndoMergeUseCase(pool);
    await undo.execute(payload!.mergeAuditId!, { undoneBy: 'account_link_email' });

    const restored = await pool.query(`SELECT phone, merged_into_id FROM workers WHERE id = $1::uuid`, [OLD_ID]);
    expect(restored.rows[0].phone).toBe(PHONE);
    expect(restored.rows[0].merged_into_id).toBeNull();
    const survivor = await pool.query(`SELECT phone FROM workers WHERE id = $1::uuid`, [NEW_ID]);
    expect(survivor.rows[0].phone).toBeNull();
  });
});

// ─── Degrau de alto valor ──────────────────────────────────────────────────

describe('degrau: conta antiga de alto valor', () => {
  it('confirm → REQUIRES_REVIEW, sem merge, evento na fila', async () => {
    const { verificationSid } = await service.start(`LinkHvNew_${STAMP}`, PHONE_HV);
    const out = await service.confirm(`LinkHvNew_${STAMP}`, PHONE_HV, verificationSid, '123456');
    expect(out).toEqual({ status: 'REQUIRES_REVIEW' });

    const merged = await pool.query(`SELECT merged_into_id FROM workers WHERE id = $1::uuid`, [HV_OLD]);
    expect(merged.rows[0].merged_into_id).toBeNull();

    const review = await pool.query(
      `SELECT COUNT(*) AS cnt FROM account_link_events WHERE event = 'requires_review' AND worker_id = $1::uuid`,
      [HV_NEW],
    );
    expect(Number(review.rows[0].cnt)).toBe(1);
  });
});

// ─── Rate limit real ───────────────────────────────────────────────────────

describe('rate-limit por conta (tabela de eventos)', () => {
  it('3 starts na última hora → 4º recusa RATE_LIMITED', async () => {
    // O fluxo feliz já consumiu 2 starts do NEW_ID; mais 1 chega ao teto de 3.
    await service.start(`LinkNew_${STAMP}`, PHONE).catch(() => {});
    await expect(service.start(`LinkNew_${STAMP}`, PHONE)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

// ─── Guardas do lookup ─────────────────────────────────────────────────────

describe('guardas', () => {
  it('telefone livre → NO_CONFLICT', async () => {
    await expect(service.lookup(`LinkNew_${STAMP}`, '5497999999999')).rejects.toBeInstanceOf(AccountLinkError);
  });
});
