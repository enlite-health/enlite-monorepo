import * as crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { TalentumPrescreeningRepository } from '../infrastructure/TalentumPrescreeningRepository';
import { TalentumPrescreeningResponseParsed } from '@modules/integration';
import { PubSubClient } from '@shared/events/PubSubClient';
import { normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { resolveCanonicalWorkerId, MAX_MERGE_DEPTH } from '@shared/database/resolveCanonicalWorkerId';
import { reportError } from '@shared/logging';
import { PrescreeningQuestionsWriter } from './PrescreeningQuestionsWriter';

const TAG = '[ProcessTalentumPrescreening]';

export type WebhookEnvironment = 'production' | 'test';

export interface ProcessTalentumPrescreeningOptions {
  environment?: WebhookEnvironment;
  dryRun?: boolean;
}

export interface ProcessTalentumPrescreeningResult {
  prescreeningId: string;
  talentumPrescreeningId: string;
  workerId: string | null;
  jobPostingId: string | null;
  resolved: { worker: boolean; jobPosting: boolean };
}

export interface IWorkerLookup {
  findByEmail(email: string): Promise<{ getValue(): { id: string } | null } | { isSuccess: boolean; getValue(): { id: string } | null }>;
  findByPhone(phone: string): Promise<{ getValue(): { id: string } | null } | { isSuccess: boolean; getValue(): { id: string } | null }>;
  findByCuit(cuit: string): Promise<{ getValue(): { id: string } | null } | { isSuccess: boolean; getValue(): { id: string } | null }>;
}

export interface IJobPostingLookup {
  findByTitleILike(name: string): Promise<{ id: string } | null>;
}

export class ProcessTalentumPrescreening {
  private readonly questionsWriter: PrescreeningQuestionsWriter;

  constructor(
    private readonly prescreeningRepo: TalentumPrescreeningRepository,
    private readonly workerLookup: IWorkerLookup,
    private readonly jobPostingLookup: IJobPostingLookup,
    private readonly pool: Pool,
    private readonly pubsub: PubSubClient,
  ) {
    this.questionsWriter = new PrescreeningQuestionsWriter(prescreeningRepo);
  }

  async execute(
    payload: TalentumPrescreeningResponseParsed,
    options?: ProcessTalentumPrescreeningOptions,
  ): Promise<ProcessTalentumPrescreeningResult> {
    const environment = options?.environment ?? 'production';
    const dryRun = options?.dryRun ?? false;

    const workerId = await this.resolveOrCreateWorker(payload, dryRun);
    const jobPostingId = await this.resolveJobPosting(payload.data.prescreening.name);

    if (dryRun) {
      return this.buildResult(payload.data.prescreening.id, payload.data.prescreening.id, workerId, jobPostingId);
    }

    const prescreening = await this.persistPrescreening(payload, workerId, jobPostingId, environment);

    await this.syncFunnelAndEncuadre(prescreening, payload);
    await this.questionsWriter.persist(prescreening.id, payload);

    return this.buildResult(prescreening.id, prescreening.talentumPrescreeningId, prescreening.workerId, prescreening.jobPostingId);
  }

  // ── Worker resolution ────────────────────────────────────────────

  private async resolveOrCreateWorker(
    payload: TalentumPrescreeningResponseParsed,
    dryRun: boolean,
  ): Promise<string | null> {
    const { email, phoneNumber, cuil } = payload.data.profile;
    console.log(`${TAG} resolveWorker | email=${email} | phone=${phoneNumber} | cuil=${cuil ?? 'none'}`);

    const workerId = await this.resolveWorkerId(payload);
    if (workerId) {
      console.log(`${TAG} resolveWorker → found ${workerId}`);
      return workerId;
    }

    if (dryRun) {
      console.log(`${TAG} resolveWorker → NOT FOUND (dryRun, skip auto-create)`);
      return null;
    }

    console.log(`${TAG} resolveWorker → NOT FOUND, auto-creating...`);
    const created = await this.autoCreateWorker(payload);
    console.log(`${TAG} resolveWorker → auto-created: ${created ?? 'FAILED'}`);
    return created;
  }

  /**
   * Resolve o registro vivo da pessoa antes de escrever.
   *
   * Os lookups por e-mail/telefone/CUIL devolvem a linha crua de `workers`,
   * inclusive uma que já foi fundida em outra (`merged_into_id`). Escrever nela
   * fura a trava `UNIQUE (worker_id, job_posting_id)` — os dois IDs são da mesma
   * pessoa, mas a constraint só enxerga IDs — e o recrutamento vê a candidata
   * duas vezes na mesma vaga.
   *
   * Divergência deliberada do contrato de `resolveCanonicalWorkerId`, que
   * devolve `null` quando a cadeia não resolve (ciclo/corrupção) esperando que o
   * chamador se recuse a escrever: aqui `null` faria o fluxo cair no
   * `autoCreateWorker` e abrir um cadastro NOVO — mais uma duplicata da mesma
   * pessoa, pior que o bug que estamos consertando. Numa cadeia quebrada
   * mantemos o ID cru (o comportamento de hoje, que não regride) e alertamos.
   */
  private async toCanonical(workerId: string): Promise<string> {
    const canonical = await resolveCanonicalWorkerId(this.pool, workerId);

    if (!canonical) {
      console.error(
        `${TAG} ALERT: cadeia de merge não resolveu para worker=${workerId} ` +
          `(ciclo ou > ${MAX_MERGE_DEPTH} saltos). Seguindo com o ID cru.`,
      );
      return workerId;
    }

    if (canonical !== workerId) {
      console.log(`${TAG} resolveWorker → ${workerId} está mergeado, usando canônico ${canonical}`);
    }

    return canonical;
  }

  private async resolveWorkerId(payload: TalentumPrescreeningResponseParsed): Promise<string | null> {
    const { email, phoneNumber, cuil } = payload.data.profile;

    const byEmail = this.extractId(await this.workerLookup.findByEmail(email));
    if (byEmail) return this.toCanonical(byEmail);

    const byPhone = this.extractId(await this.workerLookup.findByPhone(phoneNumber));
    if (byPhone) return this.toCanonical(byPhone);

    if (cuil) {
      const byCuil = this.extractId(await this.workerLookup.findByCuit(cuil));
      if (byCuil) return this.toCanonical(byCuil);
    }

    return null;
  }

  private async autoCreateWorker(payload: TalentumPrescreeningResponseParsed): Promise<string | null> {
    const phone = normalizePhoneAR(payload.data.profile.phoneNumber) || null;
    const authUid = `talentum_${payload.data.profile.id}`;

    try {
      const result = await this.pool.query(
        `INSERT INTO workers (auth_uid, email, phone, status, country)
         VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR')
         RETURNING id`,
        [authUid, payload.data.profile.email, phone],
      );
      return result.rows[0].id;
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      if (pgErr.code === '23505') {
        // Colisão: o cadastro já existe. Pode ser um registro já fundido em
        // outro — resolver o canônico antes de devolver, mesma razão do
        // `toCanonical` (ver `shared/database/canonicalWorker.ts`).
        const existing = await this.pool.query(
          `SELECT id FROM workers WHERE auth_uid = $1 OR LOWER(email) = LOWER($2) LIMIT 1`,
          [authUid, payload.data.profile.email],
        );
        const existingId = existing.rows[0]?.id ?? null;
        return existingId ? await this.toCanonical(existingId) : null;
      }
      console.error(`${TAG} autoCreateWorker failed:`, pgErr.message);
      return null;
    }
  }

  // ── Job posting resolution ───────────────────────────────────────

  private async resolveJobPosting(caseName: string): Promise<string | null> {
    console.log(`${TAG} resolveJobPosting | name="${caseName}"`);
    try {
      const casoMatch = caseName.match(/CASO\s+\d+/i);
      const searchTerm = casoMatch ? casoMatch[0] : caseName;
      const posting = await this.jobPostingLookup.findByTitleILike(searchTerm);
      const id = posting?.id ?? null;
      console.log(`${TAG} resolveJobPosting → ${id ?? 'NOT FOUND'} (searchTerm="${searchTerm}")`);
      return id;
    } catch {
      console.log(`${TAG} resolveJobPosting → ERROR (returning null)`);
      return null;
    }
  }

  // ── Prescreening persistence ─────────────────────────────────────

  private async persistPrescreening(
    payload: TalentumPrescreeningResponseParsed,
    workerId: string | null,
    jobPostingId: string | null,
    environment: WebhookEnvironment,
  ) {
    // For ANALYZED, store the statusLabel (QUALIFIED/NOT_QUALIFIED/IN_DOUBT/PENDING)
    // instead of the generic 'ANALYZED' subtype — more granular for Kanban tags.
    const effectiveStatus = payload.subtype === 'ANALYZED' && payload.data.response.statusLabel
      ? payload.data.response.statusLabel
      : payload.subtype;

    console.log(`${TAG} persistPrescreening | extId=${payload.data.prescreening.id} | status=${effectiveStatus}`);
    const { prescreening } = await this.prescreeningRepo.upsertPrescreening({
      talentumPrescreeningId: payload.data.prescreening.id,
      talentumProfileId:      payload.data.profile.id,
      workerId,
      jobPostingId,
      jobCaseName: payload.data.prescreening.name,
      status:      effectiveStatus,
      environment,
    });
    console.log(`${TAG} persistPrescreening → id=${prescreening.id}`);
    return prescreening;
  }

  // ── Funnel stage sync + encuadre ─────────────────────────────────

  private async syncFunnelAndEncuadre(
    prescreening: { id: string; workerId: string | null; jobPostingId: string | null; talentumPrescreeningId: string },
    payload: TalentumPrescreeningResponseParsed,
  ): Promise<void> {
    if (!prescreening.workerId || !prescreening.jobPostingId) {
      console.error(
        `${TAG} ALERT: syncFunnel SKIPPED — missing mandatory field! workerId=${prescreening.workerId}, ` +
        `jobPostingId=${prescreening.jobPostingId}, prescreeningId=${prescreening.id}, ` +
        `talentumId=${prescreening.talentumPrescreeningId}. This should NEVER happen.`,
      );
      return;
    }

    const funnelStage = this.deriveFunnelStage(payload);
    console.log(`${TAG} syncFunnel | subtype=${payload.subtype} | statusLabel=${payload.data.response.statusLabel ?? 'none'} → funnelStage=${funnelStage} | score=${payload.data.response.score ?? 0}`);

    await this.ensureEncuadre(prescreening.workerId, prescreening.jobPostingId, payload);

    if (funnelStage !== 'ANALYZED') {
      await this.upsertApplicationAndEmitEvent(
        prescreening.workerId,
        prescreening.jobPostingId,
        funnelStage,
        payload.data.response.score ?? 0,
        prescreening.id,
      );
    } else {
      console.log(`${TAG} syncFunnel: skipped WJA upsert (ANALYZED without statusLabel)`);
    }
  }

  /**
   * Derives the internal funnel stage from a Talentum webhook payload.
   *
   * Migration 230 (2026-06-26): subtype='INITIATED' (Talentum) → 'PRE_SCREENING' (canônico interno).
   * O Zod do webhook NÃO foi alterado — Talentum continua enviando subtype='INITIATED'.
   * A conversão é INTERNA aqui, antes de qualquer persistência em worker_job_applications.
   */
  deriveFunnelStage(payload: TalentumPrescreeningResponseParsed): string {
    if (payload.subtype === 'ANALYZED' && payload.data.response.statusLabel) {
      // 'ANALYZED' é sentinel local — usa-se pra pular upsert em WJA quando statusLabel === 'PENDING';
      // nunca persiste em application_funnel_stage (não consta em ApplicationFunnelStage)
      if (payload.data.response.statusLabel === 'PENDING') return 'ANALYZED';
      return payload.data.response.statusLabel;
    }
    if (payload.subtype === 'INITIATED') return 'PRE_SCREENING';
    return payload.subtype;
  }

  private async upsertApplicationAndEmitEvent(
    workerId: string,
    jobPostingId: string,
    funnelStage: string,
    matchScore: number,
    prescreeningId?: string,
  ): Promise<void> {
    // F3 (mig 191): NOT_QUALIFIED não existe mais no enum — converter pra REJECTED antes do upsert.
    const effectiveFunnelStage = funnelStage === 'NOT_QUALIFIED' ? 'REJECTED' : funnelStage;

    let qualifiedEventId: string | null = null;
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const { previousStage } = await this.prescreeningRepo.upsertWorkerJobApplicationFromTalentum(
        { workerId, jobPostingId, applicationFunnelStage: effectiveFunnelStage, matchScore },
        client,
      );
      console.log(`${TAG} WJA: ${previousStage ?? 'NEW'} → ${effectiveFunnelStage} | worker=${workerId} | job=${jobPostingId} | score=${matchScore}`);

      qualifiedEventId = await this.handleQualifiedTransition(client, workerId, jobPostingId, effectiveFunnelStage, previousStage);
      // Passa o funnelStage ORIGINAL (NOT_QUALIFIED) para handleNotQualifiedTransition identificar a transição,
      // mas o upsert já gravou REJECTED — handleNotQualifiedTransition só cuida do encuadre + domain events agora.
      await this.handleNotQualifiedTransition(client, workerId, jobPostingId, funnelStage, previousStage, prescreeningId);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await this.publishQualifiedEvent(qualifiedEventId);
  }

  private async handleQualifiedTransition(
    client: PoolClient, workerId: string, jobPostingId: string, funnelStage: string, previousStage: string | null,
  ): Promise<string | null> {
    if (funnelStage !== 'QUALIFIED' || previousStage === 'QUALIFIED') return null;

    const result = await client.query(
      `INSERT INTO domain_events (event, payload) VALUES ('funnel_stage.qualified', $1::jsonb) RETURNING id`,
      [JSON.stringify({ workerId, jobPostingId })],
    );
    const eventId = result.rows[0].id;
    console.log(`${TAG} QUALIFIED transition → domain_event id=${eventId}`);
    return eventId;
  }

  private async handleNotQualifiedTransition(
    client: PoolClient, workerId: string, jobPostingId: string, funnelStage: string, previousStage: string | null,
    prescreeningId?: string,
  ): Promise<void> {
    // Guard: skip if not NOT_QUALIFIED transition, or already auto-rejected
    if (funnelStage !== 'NOT_QUALIFIED' || previousStage === 'REJECTED') return;

    console.log(`${TAG} NOT_QUALIFIED transition → marking encuadre RECHAZADO + auto-rejecting WJA`);
    await client.query(
      `UPDATE encuadres
       SET resultado = 'RECHAZADO', rejection_reason_category = 'TALENTUM_NOT_QUALIFIED', updated_at = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2 AND resultado IS NULL`,
      [workerId, jobPostingId],
    );
    // Evento AUDIT-ONLY: o efeito (encuadre RECHAZADO + WJA REJECTED) é síncrono
    // aqui; este domain_event é só rastreabilidade da classificação e NÃO tem
    // consumidor (diferente de funnel_stage.qualified, que agenda entrevista).
    // Nasce `processed` para não virar órfão pending (que empilhava e falseava o
    // health check + exigia exclusão de métrica no terraform).
    await client.query(
      `INSERT INTO domain_events (event, payload, status, processed_at) VALUES ('funnel_stage.not_qualified', $1::jsonb, 'processed', NOW())`,
      [JSON.stringify({ workerId, jobPostingId })],
    );

    // Auto-reject: immediately promote WJA to REJECTED so NOT_QUALIFIED is never persisted
    await client.query(
      `UPDATE worker_job_applications
       SET application_funnel_stage = 'REJECTED', updated_at = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, jobPostingId],
    );
    // Idem: audit-only, sem consumidor → nasce `processed`.
    await client.query(
      `INSERT INTO domain_events (event, payload, status, processed_at) VALUES ('funnel_stage.rejected', $1::jsonb, 'processed', NOW())`,
      [JSON.stringify({ workerId, jobPostingId, prescreeningId: prescreeningId ?? null, source: 'auto_not_qualified' })],
    );
    console.log(`${TAG} NOT_QUALIFIED auto-reject complete → WJA stage=REJECTED | worker=${workerId} | job=${jobPostingId}`);
  }

  private async publishQualifiedEvent(eventId: string | null): Promise<void> {
    if (!eventId) return;
    try {
      await this.pubsub.publish('talentum-prescreening-qualified', { eventId });
      console.log(`${TAG} Pub/Sub published talentum-prescreening-qualified eventId=${eventId}`);
    } catch (err) {
      console.error(`${TAG} Pub/Sub publish failed (safety net will retry):`, (err as Error)?.message ?? err);
    }
  }

  // ── Encuadre ─────────────────────────────────────────────────────

  private async ensureEncuadre(
    workerId: string,
    jobPostingId: string,
    payload: TalentumPrescreeningResponseParsed,
  ): Promise<void> {
    const phone = normalizePhoneAR(payload.data.profile.phoneNumber) || null;
    const workerName = `${payload.data.profile.firstName} ${payload.data.profile.lastName}`;
    const dedupHash = crypto.createHash('md5')
      .update(`talentum|${payload.data.prescreening.id}|${payload.data.profile.id}`)
      .digest('hex');

    console.log(`${TAG} ensureEncuadre | worker=${workerId} | job=${jobPostingId} | name=${workerName}`);
    try {
      await this.pool.query(
        `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, import_source_audit, dedup_hash)
         VALUES ($1, $2, $3, $4, 'Talentum', $5)
         ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
           worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id), updated_at = NOW()`,
        [workerId, jobPostingId, workerName, phone, dedupHash],
      );
      console.log(`${TAG} ensureEncuadre → done`);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'ProcessTalentumPrescreening:ensureEncuadre', workerId, jobPostingId });
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private extractId(
    result: { getValue(): { id: string } | null } | { isSuccess: boolean; getValue(): { id: string } | null },
  ): string | null {
    if ('isSuccess' in result && !result.isSuccess) return null;
    return result.getValue()?.id ?? null;
  }

  private buildResult(
    prescreeningId: string, talentumPrescreeningId: string, workerId: string | null, jobPostingId: string | null,
  ): ProcessTalentumPrescreeningResult {
    return {
      prescreeningId,
      talentumPrescreeningId,
      workerId,
      jobPostingId,
      resolved: { worker: workerId !== null, jobPosting: jobPostingId !== null },
    };
  }
}
