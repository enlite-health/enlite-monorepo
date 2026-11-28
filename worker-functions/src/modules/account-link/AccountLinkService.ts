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
import { OTP_COUNTRY_NOT_SUPPORTED, OTP_RATE_LIMITED, type OtpChallengePort } from '../auth/ports/OtpChallengePort';
import type { ITwilioVerifyService } from '../auth/infrastructure/TwilioVerifyService';
import { TwilioVerifyOtpAdapter } from '../auth/infrastructure/TwilioVerifyOtpAdapter';
import { createOtpChallengePort } from '../../bootstrap/createOtpChallengePort';
import { IsTestOtpGuardedVerify } from '../auth/infrastructure/IsTestOtpGuardedVerify';
import { PgPhoneVerificationRepository } from '../worker/infrastructure/PgPhoneVerificationRepository';
import type { IPhoneVerificationRepository } from '../auth/ports/IPhoneVerificationRepository';
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
  is_test?: boolean;
}

export class AccountLinkService {
  private readonly encryption: KMSEncryptionService;
  private readonly otp: OtpChallengePort;
  private readonly adminMerge: ExecuteAdminMergeUseCase;
  private readonly verification: IPhoneVerificationRepository;

  constructor(
    private readonly pool: Pool,
    deps?: {
      encryption?: KMSEncryptionService;
      otp?: OtpChallengePort;
      /** Semente de teste do plano B: um Twilio Verify (dublê) embrulhado no adapter + guarda de ficha de teste. */
      twilio?: ITwilioVerifyService;
      adminMerge?: ExecuteAdminMergeUseCase;
      verification?: IPhoneVerificationRepository;
    },
  ) {
    this.encryption = deps?.encryption ?? new KMSEncryptionService();
    // Ponto único de envio do código: o port (a guarda de OTP de teste vive no adapter, FR-95/DP-23).
    this.otp =
      deps?.otp ??
      (deps?.twilio ? new TwilioVerifyOtpAdapter(new IsTestOtpGuardedVerify(deps.twilio)) : createOtpChallengePort());
    this.adminMerge = deps?.adminMerge ?? new ExecuteAdminMergeUseCase(pool);
    this.verification = deps?.verification ?? new PgPhoneVerificationRepository(pool);
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

  async start(authUid: string, phoneEntered: string, tokenEmail?: string | null): Promise<AccountLinkStartResult> {
    const me = await this.resolveLoggedWorker(authUid);
    const owner = await this.resolvePhoneOwner(phoneEntered, me.id);

    if (!(await canStartWithinRateLimit(this.pool, me.id))) {
      throw new AccountLinkError('RATE_LIMITED');
    }

    // Anti-hijack (padrão do claim): o código vai pro número DA FICHA, nunca
    // pro digitado no request.
    const phoneForOtp = owner.phone!;
    const phoneE164 = phoneForOtp.startsWith('+') ? phoneForOtp : `+${normalizePhoneAR(phoneForOtp) ?? phoneForOtp}`;
    let challengeId: string;
    try {
      ({ challengeId } = await this.otp.start({
        workerId: owner.id,
        purpose: 'link',
        phoneE164,
        requesterUid: authUid,
        ctx: { workerId: owner.id, fichaIsTest: owner.is_test === true, tokenEmail },
      }));
    } catch (err) {
      if (err instanceof Error && err.message === OTP_RATE_LIMITED) throw new AccountLinkError('RATE_LIMITED');
      if (err instanceof Error && err.message === OTP_COUNTRY_NOT_SUPPORTED) throw new AccountLinkError('PHONE_COUNTRY_NOT_SUPPORTED');
      throw err;
    }
    const verificationSid = challengeId; // o fio do vínculo segue chamando de verificationSid; carrega o id do desafio

    await recordAccountLinkEvent(this.pool, {
      event: 'started', workerId: me.id, otherWorkerId: owner.id,
      detail: { verificationSid },
    });

    return { verificationSid, phoneMasked: maskPhone(phoneForOtp) };
  }

  // ── confirm — posse provada: REQUIRES_REVIEW | conflitos | merge direto ──

  async confirm(
    authUid: string,
    phoneEntered: string,
    verificationSid: string,
    otp: string,
    tokenEmail?: string | null,
    // C-46/DT-50: `preview` valida o OTP e devolve o linkToken SEM merge (o merge é do finalize).
    input: { preview?: boolean } = {},
  ): Promise<AccountLinkConfirmResult> {
    const me = await this.resolveLoggedWorker(authUid);
    const owner = await this.resolvePhoneOwner(phoneEntered, me.id);

    // DP-21: o código tem de ter ido ao telefone GRAVADO na conta que vai ser absorvida (lido do banco aqui; o `phoneEntered`
    // é do cliente): o port confere o telefone do desafio contra este.
    const ownerPhone = owner.phone ?? '';
    const check = await this.otp.check({
      challengeId: verificationSid,
      workerId: owner.id,
      purpose: 'link',
      phoneOnRecord: ownerPhone.startsWith('+') ? ownerPhone : `+${normalizePhoneAR(ownerPhone) ?? ownerPhone}`,
      code: otp,
      // `owner` acabou de ser lido do banco por resolvePhoneOwner (inclui is_test) nesta mesma requisição.
      ctx: { workerId: owner.id, tokenEmail, fichaIsTest: async () => owner.is_test === true },
    });
    if (!check.ok) {
      throw new AccountLinkError(check.code === 'EXPIRED_OTP' ? 'EXPIRED_OTP' : 'INVALID_OTP');
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
    if (input.preview) {
      const linkToken = signLinkToken({
        purpose: 'finalize', survivorId: me.id, absorbedId: owner.id,
        exp: Date.now() + FINALIZE_TOKEN_TTL_MS,
      });
      return { status: 'preview', conflicts, linkToken, accounts: { current: me.id, other: owner.id } };
    }
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
    // O `confirm` já provou a posse do telefone da conta ABSORVIDA: lê a prova ANTES do merge (que reparenta os desafios).
    const proof = await this.verification.linkProof(absorbedId);
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
    await this.verifySurvivor(survivorId, proof);

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
    // FR-95/DP-23: absorvida `is_test` não manda e-mail (o e-mail de teste não chama o provedor real).
    if (auditId != null) {
      const absorbed = await this.fetchAbsorbedFlags(absorbedId);
      if (!absorbed.isTest) {
        await sendLinkedNoticeEmail(this.pool, { survivorId, absorbedId, mergeAuditId: auditId });
      } else {
        await recordAccountLinkEvent(this.pool, {
          event: 'notice_email_skipped', workerId: survivorId, otherWorkerId: absorbedId,
          mergeAuditId: auditId, detail: { reason: 'is_test' },
        });
      }
    }

    return { status: 'merged', recovered, workerStatus };
  }

  /**
   * A sobrevivente ficou com o telefone da conta absorvida (o merge o move) mas sem a prova que acompanha o número: grava a
   * prova que o `confirm` acabou de estabelecer. Se o merge já levou a prova junto (absorvida verificada) ou a sobrevivente
   * ficou com outro número, não faz nada. Falha aqui NÃO desfaz o merge: a ficha fica `unverified` (falha fechada).
   */
  private async verifySurvivor(
    survivorId: string,
    proof: Awaited<ReturnType<IPhoneVerificationRepository['linkProof']>>,
  ): Promise<void> {
    if (!proof) return;
    try {
      const state = await this.verification.readState(survivorId);
      if (!state || state.state !== 'unverified' || !state.phone || normalizePhoneAR(state.phone) !== proof.phoneNormalized) return;
      await this.verification.markPhoneVerified(this.pool, { workerId: survivorId, challengeId: proof.challengeId, method: proof.method });
    } catch (err: unknown) {
      log().warn({ msg: 'link_phone_verification_not_written', code: (err as { code?: string }).code ?? null });
    }
  }

  /** Marca de teste da ficha absorvida (a linha continua existindo, com `merged_into_id`). Sem linha = não é teste. */
  private async fetchAbsorbedFlags(absorbedId: string): Promise<{ isTest: boolean }> {
    const res = await this.pool.query<{ is_test: boolean }>(
      `SELECT is_test FROM workers WHERE id = $1::uuid`, [absorbedId],
    );
    return { isTest: res.rows[0]?.is_test === true };
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
      `SELECT id, email, auth_uid, phone, updated_at, is_test
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
