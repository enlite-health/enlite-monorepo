/**
 * AccountLinkService — vínculo self-service de contas por colisão de telefone.
 *
 * Contrato v2 (emenda 04/08): lookup (sem SMS, só mascarados) → start (OTP pro
 * número DA CONTA ANTIGA, só na intenção) → confirm (posse provada: merge direto
 * OU conflitos+linkToken) → finalize (linkToken + fieldChoices → merge).
 *
 * O merge é o MESMO do Dedup admin (ExecuteAdminMergeUseCase →
 * WorkerPhoneMergeService.executeSingleMerge: snapshot + audit + undo +
 * move de phone/whatsapp/ana_care_id da fundação do Bloco 1), com
 * source='self_service_link'.
 */

import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { normalizePhoneAR, generatePhoneCandidates } from '@shared/utils/phoneNormalization';
import { resolveCanonicalWorkerId } from '@shared/database/resolveCanonicalWorkerId';
import { TwilioVerifyService } from '../auth/infrastructure/TwilioVerifyService';
import { ExecuteAdminMergeUseCase } from '../../application/dedup/ExecuteAdminMergeUseCase';
import { buildFieldComparisons } from '../../application/dedup/dedupFieldComparison';
import { SYNTHETIC_AUTH_UID_PREFIXES } from '../../infrastructure/services/WorkerPhoneMergeTypes';
import {
  AccountLinkError,
  type AccountLinkLookupResult,
  type AccountLinkStartResult,
  type AccountLinkConfirmResult,
  type AccountLinkConflict,
  WORKER_COMPARE_FIELDS,
  HIGH_VALUE_WJA_STAGES,
} from './AccountLinkTypes';
import { signLinkToken, FINALIZE_TOKEN_TTL_MS } from './linkToken';
import { recordAccountLinkEvent, canStartWithinRateLimit } from './accountLinkEvents';
import { sendLinkedNoticeEmail } from './accountLinkNotice';
import { maskEmail as maskEmailShared } from '@shared/utils/emailMask';

const log = () => logger.child({ source: 'AccountLinkService' });

interface WorkerLite {
  id: string;
  email: string | null;
  auth_uid: string | null;
  phone: string | null;
  updated_at: Date;
}

export class AccountLinkService {
  private readonly encryption: KMSEncryptionService;
  private readonly twilio: TwilioVerifyService;
  private readonly adminMerge: ExecuteAdminMergeUseCase;

  constructor(
    private readonly pool: Pool,
    deps?: {
      encryption?: KMSEncryptionService;
      twilio?: TwilioVerifyService;
      adminMerge?: ExecuteAdminMergeUseCase;
    },
  ) {
    this.encryption = deps?.encryption ?? new KMSEncryptionService();
    this.twilio = deps?.twilio ?? new TwilioVerifyService();
    this.adminMerge = deps?.adminMerge ?? new ExecuteAdminMergeUseCase(pool);
  }

  // ── lookup — SEM SMS, SÓ mascarados ─────────────────────────────────────

  async lookup(authUid: string, phoneEntered: string): Promise<AccountLinkLookupResult> {
    const me = await this.resolveLoggedWorker(authUid);
    const owner = await this.resolvePhoneOwner(phoneEntered, me.id);

    await recordAccountLinkEvent(this.pool, {
      event: 'lookup', workerId: me.id, otherWorkerId: owner.id,
    });

    return {
      otherEmailMasked: maskEmail(owner.email),
      phoneMasked: maskPhone(owner.phone ?? phoneEntered),
    };
  }

  // ── start — OTP pro número DA CONTA ANTIGA, só na intenção ──────────────

  async start(authUid: string, phoneEntered: string): Promise<AccountLinkStartResult> {
    const me = await this.resolveLoggedWorker(authUid);
    const owner = await this.resolvePhoneOwner(phoneEntered, me.id);

    if (!(await canStartWithinRateLimit(this.pool, me.id))) {
      throw new AccountLinkError('RATE_LIMITED');
    }

    // Anti-hijack (padrão do claim): o código vai pro número DA FICHA, nunca
    // pro digitado no request.
    const phoneForOtp = owner.phone!;
    const phoneE164 = phoneForOtp.startsWith('+') ? phoneForOtp : `+${normalizePhoneAR(phoneForOtp) ?? phoneForOtp}`;
    const { verificationSid } = await this.twilio.startVerification(phoneE164);

    await recordAccountLinkEvent(this.pool, {
      event: 'started', workerId: me.id, otherWorkerId: owner.id,
      detail: { verificationSid },
    });

    return { verificationSid, phoneMasked: maskPhone(phoneForOtp) };
  }

  // ── confirm — posse provada: REQUIRES_REVIEW | conflitos | merge direto ──

  async confirm(authUid: string, phoneEntered: string, verificationSid: string, otp: string): Promise<AccountLinkConfirmResult> {
    const me = await this.resolveLoggedWorker(authUid);
    const owner = await this.resolvePhoneOwner(phoneEntered, me.id);

    const check = await this.twilio.checkVerification(verificationSid, otp);
    if (!check.valid) {
      throw new AccountLinkError(check.status === 'expired' ? 'EXPIRED_OTP' : 'INVALID_OTP');
    }

    await recordAccountLinkEvent(this.pool, {
      event: 'confirmed', workerId: me.id, otherWorkerId: owner.id,
    });

    // Degrau de alto valor: roda DEPOIS do OTP de propósito — posse provada
    // antes de criar pendência (terceiro sem o chip não enche a fila do admin).
    if (await this.isHighValue(owner.id)) {
      await recordAccountLinkEvent(this.pool, {
        event: 'requires_review', workerId: me.id, otherWorkerId: owner.id,
        detail: { reason: 'high_value_absorbed' },
      });
      return { status: 'REQUIRES_REVIEW' };
    }

    const conflicts = await this.buildWorkerConflicts(me.id, owner.id);
    if (conflicts.length > 0) {
      const linkToken = signLinkToken({
        purpose: 'finalize', survivorId: me.id, absorbedId: owner.id,
        exp: Date.now() + FINALIZE_TOKEN_TTL_MS,
      });
      await recordAccountLinkEvent(this.pool, {
        event: 'conflicts_shown', workerId: me.id, otherWorkerId: owner.id,
        detail: { fields: conflicts.map(c => c.field) },
      });
      return { status: 'conflicts', conflicts, linkToken, accounts: { current: me.id, other: owner.id } };
    }

    return this.executeMerge(me.id, owner.id, authUid, undefined);
  }

  // ── finalize — linkToken + fieldChoices → merge ─────────────────────────

  async finalize(
    authUid: string,
    payload: import('./linkToken').LinkTokenPayload,
    fieldChoices: Record<string, string> | undefined,
  ): Promise<AccountLinkConfirmResult> {
    const me = await this.resolveLoggedWorker(authUid);
    // O token só vale pra ESTA conta logada (roubo de token de outra sessão não linka).
    if (payload.survivorId !== me.id) {
      throw new AccountLinkError('INVALID_LINK_TOKEN');
    }
    return this.executeMerge(payload.survivorId, payload.absorbedId, authUid, fieldChoices);
  }

  // ── Merge compartilhado (confirm sem conflito + finalize) ───────────────

  private async executeMerge(
    survivorId: string,
    absorbedId: string,
    authUid: string,
    fieldChoices: Record<string, string> | undefined,
  ): Promise<AccountLinkConfirmResult> {
    const result = await this.adminMerge.execute({
      survivorId,
      absorbedIds: [absorbedId],
      fieldChoices,
      audit: {
        source: 'self_service_link',
        executedBy: authUid,
        confirmedSamePerson: true,
      },
    });
    const auditId = result.audit_ids[0] ?? null;

    const recovered = auditId != null ? await this.fetchRecovered(auditId) : {};
    const statusRes = await this.pool.query<{ status: string }>(
      `SELECT status FROM workers WHERE id = $1::uuid`, [survivorId],
    );
    const workerStatus = statusRes.rows[0]?.status ?? null;

    await recordAccountLinkEvent(this.pool, {
      event: 'merged', workerId: survivorId, otherWorkerId: absorbedId,
      mergeAuditId: auditId ?? undefined, detail: { recovered, workerStatus },
    });

    // Email de aviso com undo assinado (7d) — best-effort; falha não desfaz o merge.
    if (auditId != null) {
      await sendLinkedNoticeEmail(this.pool, { survivorId, absorbedId, mergeAuditId: auditId });
    }

    return { status: 'merged', recovered, workerStatus };
  }

  private async fetchRecovered(auditId: number): Promise<Record<string, number>> {
    const res = await this.pool.query<{ rows_reparented: Record<string, number> }>(
      `SELECT rows_reparented FROM worker_merge_audit WHERE id = $1`, [auditId],
    );
    return res.rows[0]?.rows_reparented ?? {};
  }

  // ── Resolvers/validações ────────────────────────────────────────────────

  private async resolveLoggedWorker(authUid: string): Promise<WorkerLite> {
    const res = await this.pool.query<WorkerLite & { merged_into_id: string | null }>(
      `SELECT id, email, auth_uid, phone, updated_at, merged_into_id
       FROM workers WHERE auth_uid = $1`,
      [authUid],
    );
    if (res.rows.length === 0) throw new AccountLinkError('WORKER_NOT_FOUND');
    let row = res.rows[0];
    if (row.merged_into_id != null) {
      const canonical = await resolveCanonicalWorkerId(this.pool, row.id);
      if (canonical && canonical !== row.id) {
        const c = await this.pool.query<WorkerLite & { merged_into_id: string | null }>(
          `SELECT id, email, auth_uid, phone, updated_at, merged_into_id FROM workers WHERE id = $1::uuid`,
          [canonical],
        );
        if (c.rows.length > 0) row = c.rows[0];
      }
    }
    return row;
  }

  /**
   * Dona do telefone digitado. Regras (espelham resolvePhoneToPersist):
   *  - ninguém ativo com o número → NO_CONFLICT (o save vai passar; sem vínculo)
   *  - dona é a própria conta logada → NO_CONFLICT
   *  - dona é ficha importada (auth_uid sintético / email @enlite.import) → USE_CLAIM
   *  - dona é conta REAL → candidata ao vínculo (retorna a linha)
   */
  private async resolvePhoneOwner(phoneEntered: string, loggedId: string): Promise<WorkerLite> {
    const candidates = generatePhoneCandidates(phoneEntered ?? '');
    if (candidates.length === 0) throw new AccountLinkError('NO_CONFLICT');

    const res = await this.pool.query<WorkerLite>(
      `SELECT id, email, auth_uid, phone, updated_at
       FROM workers
       WHERE phone = ANY($1::text[])
         AND merged_into_id IS NULL
         AND deleted_at IS NULL
       LIMIT 1`,
      [candidates],
    );
    const owner = res.rows[0];
    if (!owner || owner.id === loggedId) throw new AccountLinkError('NO_CONFLICT');

    const uid = owner.auth_uid ?? '';
    const isImported =
      SYNTHETIC_AUTH_UID_PREFIXES.some(p => uid.startsWith(p)) ||
      (owner.email ?? '').toLowerCase().endsWith('@enlite.import');
    if (isImported) throw new AccountLinkError('USE_CLAIM');

    return owner;
  }

  private async isHighValue(workerId: string): Promise<boolean> {
    const res = await this.pool.query<{ high: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM worker_job_applications
         WHERE worker_id = $1::uuid
           AND (application_funnel_stage = ANY($2::text[])
                OR interview_scheduled_at IS NOT NULL
                OR hired_at IS NOT NULL)
       ) OR EXISTS (
         SELECT 1 FROM worker_payment_info WHERE worker_id = $1::uuid
       ) AS high`,
      [workerId, [...HIGH_VALUE_WJA_STAGES]],
    );
    return Boolean(res.rows[0]?.high);
  }

  /** Conflitos visíveis ao worker (subset público) + suggested = mais recente. */
  private async buildWorkerConflicts(meId: string, ownerId: string): Promise<AccountLinkConflict[]> {
    const fields = [...WORKER_COMPARE_FIELDS];
    const res = await this.pool.query<Record<string, unknown> & { id: string; updated_at: Date }>(
      `SELECT id, updated_at, ${fields.join(', ')}
       FROM workers WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
      [meId, ownerId],
    );
    if (res.rows.length < 2) return [];

    const comparisons = await buildFieldComparisons(fields, res.rows, this.encryption);
    const newest = res.rows.reduce((a, b) => (a.updated_at >= b.updated_at ? a : b));

    return comparisons
      .filter(c => c.has_conflict)
      .map(c => ({ ...c, suggested: String(newest.id) }));
  }
}

// ── Máscaras (não vazam identidade completa antes da posse) ────────────────
// A de e-mail mora em `shared/utils/emailMask` desde 31/08 — era duplicada.

/** Delega à política única (`shared/utils/emailMask`); aqui o fallback é '•••'. */
export function maskEmail(email: string | null): string {
  return maskEmailShared(email) ?? '•••';
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}
