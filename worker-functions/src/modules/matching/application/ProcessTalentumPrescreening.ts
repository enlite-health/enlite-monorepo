import * as crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { TalentumPrescreeningRepository } from '../infrastructure/TalentumPrescreeningRepository';
import type { TalentumDivergenceKind } from '../domain/TalentumPrescreening';
import { TalentumPrescreeningResponseParsed } from '@modules/integration';
import { PubSubClient } from '@shared/events/PubSubClient';
import { normalizePhoneAR, generatePhoneCandidates } from '@shared/utils/phoneNormalization';
import { resolveCanonicalWorkerId, MAX_MERGE_DEPTH } from '@shared/database/resolveCanonicalWorkerId';
import { reportError, logger } from '@shared/logging';
import { maskPhoneForLog } from '@shared/utils/phoneMask';
import { maskEmailForLog } from '@shared/utils/emailMask';
import { deriveFunnelStage, toPersistedFunnelStage, applyNotQualifiedTransition, insertTalentumWorker } from './talentumFunnel';
import { PrescreeningQuestionsWriter } from './PrescreeningQuestionsWriter';
import { parseCaseTitleReference } from '@shared/utils/parseCaseTitleReference';
import { formatCaseNumberTitle } from '@shared/utils/caseNumberFormat';
import { vacancyIsDeBaja } from '../interfaces/controllers/vacancyDeBajaGuard';

const TAG = '[ProcessTalentumPrescreening]';

/**
 * Um Error DISTINTO por tipo de divergência: mensagem e stack sintético próprios, para o Cloud Error Reporting agrupar
 * cada tipo no seu grupo (a stack real seria a mesma para os cinco e eles cairiam num grupo só).
 */
function divergenceError(kind: TalentumDivergenceKind): Error {
  const err = new Error(`${TAG} divergência webhook × card: ${kind}`);
  err.name = `TalentumDivergence_${kind}`;
  err.stack = `${err.name}: ${err.message}\n    at ProcessTalentumPrescreening.divergence.${kind} (talentum-webhook)`;
  return err;
}

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

/** Vaga resolvida + o CAMINHO: `viaId` = pelo `talentum_prescreening_id` (a dona); false = só pelo título. */
interface ResolvedJobPosting {
  id: string | null;
  viaId: boolean;
}

export interface IWorkerLookup {
  /**
   * E-mail NORMALIZADO (LOWER/BTRIM), só worker vivo, determinístico. `ambiguousCount > 1` = mais de uma candidata
   * casa: `getValue()` é null e o webhook registra a divergência — nunca escolhe uma. (O `findByEmail` exato é do login.)
   */
  findByEmailNormalized(email: string): Promise<{ getValue(): { id: string } | null; isSuccess?: boolean; ambiguousCount?: number }>;
  /** Telefone por CANDIDATOS (`generatePhoneCandidates`): casa com/sem o 9 do móvel; ignora worker merged/deletado. */
  findByPhoneCandidates(candidates: string[]): Promise<{ getValue(): { id: string } | null } | { isSuccess: boolean; getValue(): { id: string } | null }>;
  findByCuit(cuit: string): Promise<{ getValue(): { id: string } | null } | { isSuccess: boolean; getValue(): { id: string } | null }>;
}

export interface IJobPostingLookup {
  /** Vaga viva pelo `_id` do prescreening (`job_postings.talentum_prescreening_id`, único entre vivas). */
  findByTalentumPrescreeningId(prescreeningId: string): Promise<{ id: string } | null>;
  /** Fallback por título: prefere a oficial; 2+ sem desempate oficial → null. */
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

    const { workerId, emailAmbiguous } = await this.resolveOrCreateWorker(payload, dryRun);
    const job = await this.resolveJobPosting(payload.data.prescreening.id, payload.data.prescreening.name);
    const jobPostingId = job.id;

    if (dryRun) {
      return this.buildResult(payload.data.prescreening.id, payload.data.prescreening.id, workerId, jobPostingId);
    }

    const prescreening = await this.persistPrescreening(payload, workerId, job, environment, emailAmbiguous);

    // Spec 084 (F4/R6/F17): projeto de vaga DADA DE BAJA que ainda recebe candidato — a resposta fica GUARDADA (nada se
    // perde) e MARCADA, mas NÃO entra no Kanban de trabalho: sem WJA, sem encuadre, sem evento de funil (logo, sem
    // mensagem ao prestador). A baixa nunca apaga o histórico; só impede que a vaga volte a ser trabalhada.
    if (jobPostingId && (await vacancyIsDeBaja(this.pool, jobPostingId))) {
      await this.pool.query(`UPDATE talentum_prescreenings SET held_for_baja = true WHERE id = $1`, [prescreening.id]);
      console.log(`${TAG} vaga em DE_BAJA → resposta guardada e marcada, fora do Kanban | prescreening=${prescreening.id}`);
      await this.questionsWriter.persist(prescreening.id, payload);
      return this.buildResult(prescreening.id, prescreening.talentumPrescreeningId, prescreening.workerId, prescreening.jobPostingId);
    }

    await this.syncFunnelAndEncuadre(prescreening, payload);
    await this.questionsWriter.persist(prescreening.id, payload);

    return this.buildResult(prescreening.id, prescreening.talentumPrescreeningId, prescreening.workerId, prescreening.jobPostingId);
  }

  // ── Worker resolution ────────────────────────────────────────────

  private async resolveOrCreateWorker(
    payload: TalentumPrescreeningResponseParsed,
    dryRun: boolean,
  ): Promise<{ workerId: string | null; emailAmbiguous: boolean }> {
    const { email, phoneNumber } = payload.data.profile;
    // PII: e-mail/telefone mascarados (maskEmailForLog/maskPhoneForLog); CUIL é documento —
    // nunca no log, nem mascarado (achado do gate, 11/09).
    console.log(`${TAG} resolveWorker | email=${maskEmailForLog(email)} | phone=${maskPhoneForLog(phoneNumber)}`);

    const { id: workerId, emailAmbiguous } = await this.resolveWorkerId(payload);
    if (workerId) {
      console.log(`${TAG} resolveWorker → found ${workerId}`);
      return { workerId, emailAmbiguous };
    }

    if (dryRun) {
      console.log(`${TAG} resolveWorker → NOT FOUND (dryRun, skip auto-create)`);
      return { workerId: null, emailAmbiguous };
    }

    console.log(`${TAG} resolveWorker → NOT FOUND, auto-creating...`);
    const created = await this.autoCreateWorker(payload);
    console.log(`${TAG} resolveWorker → auto-created: ${created ?? 'FAILED'}`);
    // O alarme de worker não resolvido é UM só: a divergência WORKER_NULL (linha + reportError) em persistPrescreening.
    // O status HTTP da resposta ao Talentum NÃO muda.
    return { workerId: created, emailAmbiguous };
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
      // reportError, não console.error: escrever deliberadamente num cadastro
      // possivelmente morto é a exceção que precisa de alarme de verdade — um
      // log solto ninguém lê.
      reportError(
        new Error(
          `cadeia de merge não resolveu para worker=${workerId} ` +
            `(ciclo ou > ${MAX_MERGE_DEPTH} saltos); seguindo com o ID cru`,
        ),
        { source: 'ProcessTalentumPrescreening:toCanonical', workerId },
      );
      return workerId;
    }

    if (canonical !== workerId) {
      console.log(`${TAG} resolveWorker → ${workerId} está mergeado, usando canônico ${canonical}`);
    }

    return canonical;
  }

  private async resolveWorkerId(
    payload: TalentumPrescreeningResponseParsed,
  ): Promise<{ id: string | null; emailAmbiguous: boolean }> {
    const { email, phoneNumber, cuil } = payload.data.profile;

    const emailLookup = await this.workerLookup.findByEmailNormalized(email);
    const emailAmbiguous = (emailLookup.ambiguousCount ?? 0) > 1;
    const byEmail = this.extractId(emailLookup);
    if (byEmail) return { id: await this.toCanonical(byEmail), emailAmbiguous };

    const byPhone = await this.findByPhoneAnyForm(phoneNumber);
    if (byPhone) return { id: await this.toCanonical(byPhone), emailAmbiguous };

    if (cuil) {
      const byCuil = this.extractId(await this.workerLookup.findByCuit(cuil));
      if (byCuil) return { id: await this.toCanonical(byCuil), emailAmbiguous };
    }

    return { id: null, emailAmbiguous };
  }

  /**
   * O Talentum manda o celular argentino SEM o "9" (54 11…), o worker está gravado COM ele (549 11…).
   * Igualdade exata no telefone cru não casava (prd 04/11: 29 candidatas sem worker). Os candidatos
   * cobrem as formas históricas; `findByPhoneCandidates` já exclui worker merged/deletado.
   */
  private async findByPhoneAnyForm(phoneNumber: string): Promise<string | null> {
    const candidates = generatePhoneCandidates(phoneNumber);
    if (candidates.length === 0) return null;
    return this.extractId(await this.workerLookup.findByPhoneCandidates(candidates));
  }

  private async autoCreateWorker(payload: TalentumPrescreeningResponseParsed): Promise<string | null> {
    const created = await insertTalentumWorker(this.pool, payload.data.profile);
    if (created.kind === 'CREATED') return created.id;
    if (created.kind === 'COLLISION') {
      // Colisão: o cadastro já existe. Pode ser um registro já fundido em
      // outro — resolver o canônico antes de devolver, mesma razão do
      // `toCanonical` (ver `shared/database/canonicalWorker.ts`).
      const existing = await this.pool.query(
        `SELECT id FROM workers WHERE auth_uid = $1 OR LOWER(email) = LOWER($2) LIMIT 1`,
        [`talentum_${payload.data.profile.id}`, payload.data.profile.email],
      );
      // Colisão no índice único de telefone: o dono está na forma com o 9 (o INSERT usa o normalizado).
      const existingId = existing.rows[0]?.id ?? (await this.findByPhoneAnyForm(payload.data.profile.phoneNumber));
      return existingId ? await this.toCanonical(existingId) : null;
    }
    console.error(`${TAG} autoCreateWorker failed:`, created.message);
    return null;
  }

  // ── Job posting resolution ───────────────────────────────────────

  private async resolveJobPosting(prescreeningId: string, caseName: string): Promise<ResolvedJobPosting> {
    // PII (achado do gate, C3 do parecer do lex, 11/09): `caseName`/`searchTerm`
    // são texto livre do título do projeto no Talentum, não um id — MEDIDO em prd
    // (7d, textPayload local, nunca colado): 400/590 nomes NÃO batem o formato
    // exato "CASO N" (só 190 batem 100%); do lado do searchTerm, 522/590 extraem
    // "CASO N" como SUBSTRING (a regex abaixo já faz isso), e os 68 restantes
    // caem no fallback pro texto livre inteiro. Como nem todos batem, nunca se
    // loga o texto livre — só o "CASO N" extraído (`caseRef`) ou o marcador fixo
    // `<outro>` quando a extração falha, nos dois logs.
    // Achado #6 (spec 027) fechado, D422 (24/09/2026): religa ao parser
    // COMPARTILHADO (`parseCaseTitleReference`) em vez da regex própria — a
    // antiga (`/CASO\s+\d+/i`) exigia dígito logo após "CASO ", então "CASO
    // EN1041-…" não casava e caía inteiro no fallback de texto livre. O termo
    // de busca é remontado via `formatCaseNumberTitle` (não o texto cru do título)
    // porque é EXATAMENTE o prefixo que `formatCaseTitle` grava no título real da
    // vaga (`CASO EN1041-…` para nativo, `CASO 1041-…` para legado) — usar o
    // número cru aqui não bateria via ILIKE contra o título formatado.
    const { caseNumber } = parseCaseTitleReference(caseName);
    const searchTerm = formatCaseNumberTitle(caseNumber);
    const caseRef = searchTerm ?? '<outro>';
    console.log(`${TAG} resolveJobPosting | caseRef=${caseRef}`);
    try {
      // Resolução primária pelo `_id` do prescreening (payload `prescreening.id`): o título
      // `CASO N` é do PACIENTE e também casa rascunho/outra vaga do mesmo paciente.
      const byPrescreening = await this.jobPostingLookup.findByTalentumPrescreeningId(prescreeningId);
      if (byPrescreening) {
        console.log(`${TAG} resolveJobPosting → ${byPrescreening.id} (caminho=por_prescreening_id)`);
        return { id: byPrescreening.id, viaId: true };
      }
      let posting = await this.jobPostingLookup.findByTitleILike(searchTerm ?? caseName);
      // Achado CI #515 (24/09/2026): o título formatado (prefixo `EN` decidido pela FAIXA
      // numérica, não pelo texto real) não bate quando o título gravado ainda não segue
      // essa convenção (ex.: número sintético de teste, ou título legado nunca reescrito).
      // Fallback preserva o comportamento anterior a D422: procura pelo texto LIVRE inteiro.
      if (!posting && searchTerm != null) {
        posting = await this.jobPostingLookup.findByTitleILike(caseName);
      }
      const id = posting?.id ?? null;
      console.log(`${TAG} resolveJobPosting → ${id ?? 'NOT FOUND'} (caminho=${id ? 'por_titulo_unico' : 'nao_resolvido'}, caseRef=${caseRef})`);
      return { id, viaId: false };
    } catch {
      console.log(`${TAG} resolveJobPosting → ERROR (returning null)`);
      return { id: null, viaId: false };
    }
  }

  // ── Prescreening persistence ─────────────────────────────────────

  private async persistPrescreening(
    payload: TalentumPrescreeningResponseParsed,
    workerId: string | null,
    job: ResolvedJobPosting,
    environment: WebhookEnvironment,
    emailAmbiguous = false,
  ) {
    // For ANALYZED, store the statusLabel (QUALIFIED/NOT_QUALIFIED/IN_DOUBT/PENDING)
    // instead of the generic 'ANALYZED' subtype — more granular for Kanban tags.
    const effectiveStatus = payload.subtype === 'ANALYZED' && payload.data.response.statusLabel
      ? payload.data.response.statusLabel
      : payload.subtype;

    console.log(`${TAG} persistPrescreening | extId=${payload.data.prescreening.id} | status=${effectiveStatus}`);

    // Card + divergência na MESMA transação: o espelho nunca fica gravado sem o registro do que não bateu.
    const client = await this.pool.connect();
    let prescreening;
    const divergences: Array<{ kind: TalentumDivergenceKind; jobPostingId: string | null; expectedJobPostingId: string | null }> = [];
    try {
      await client.query('BEGIN');
      const upserted = await this.prescreeningRepo.upsertPrescreening({
        talentumPrescreeningId: payload.data.prescreening.id,
        talentumProfileId:      payload.data.profile.id,
        workerId,
        jobPostingId:           job.id,
        jobPostingResolvedById: job.viaId,
        jobCaseName: payload.data.prescreening.name,
        status:      effectiveStatus,
        environment,
      }, client);
      prescreening = upserted.prescreening;

      divergences.push(...this.collectDivergences(workerId, job, upserted.previousJobPostingId ?? null, emailAmbiguous));
      for (const d of divergences) {
        await this.recordDivergence(client, payload, prescreening.id, workerId, d, environment);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    for (const d of divergences) {
      // BY_TITLE_ONLY é ruído esperado (vaga antiga sem id): só a linha na tabela, sem reporter.
      if (d.kind === 'JOB_POSTING_BY_TITLE_ONLY') continue;
      // Reporter oficial do projeto (Cloud Error Reporting). Só ids: sem telefone/e-mail/nome.
      reportError(divergenceError(d.kind), {
        source: 'ProcessTalentumPrescreening:divergence',
        kind: d.kind,
        // WORKER_NULL mantém o marcador histórico do log-based metric (jsonPayload.alert).
        ...(d.kind === 'WORKER_NULL' ? { alert: 'TALENTUM_WORKER_UNRESOLVED' } : {}),
        talentumPrescreeningId: payload.data.prescreening.id,
        talentumProfileId: payload.data.profile.id,
        workerId,
        jobPostingId: d.jobPostingId,
        expectedJobPostingId: d.expectedJobPostingId,
      });
    }
    console.log(`${TAG} persistPrescreening → id=${prescreening.id}`);
    return prescreening;
  }

  /**
   * O que NÃO bateu neste evento. `previous` = vaga gravada antes dele.
   * - worker/vaga null: o card fica sem vínculo (ou sem avanço de etapa);
   * - dona por id ≠ gravada: a dona venceu (M2) e a gravada foi trocada — o card antigo ainda pode estar na vaga errada;
   * - só título e ≠ gravada: a gravada foi MANTIDA (título não sobrescreve id), o título aponta outra vaga;
   * - só título (sem conflito): resolução frágil, não é a dona por id.
   */
  private collectDivergences(workerId: string | null, job: ResolvedJobPosting, previous: string | null, emailAmbiguous = false) {
    const out: Array<{ kind: TalentumDivergenceKind; jobPostingId: string | null; expectedJobPostingId: string | null }> = [];
    if (emailAmbiguous) out.push({ kind: 'WORKER_EMAIL_AMBIGUOUS', jobPostingId: job.id, expectedJobPostingId: null });
    if (!workerId) out.push({ kind: 'WORKER_NULL', jobPostingId: job.id, expectedJobPostingId: null });
    if (!job.id) {
      out.push({ kind: 'JOB_POSTING_NULL', jobPostingId: previous, expectedJobPostingId: null });
    } else if (job.viaId) {
      if (previous && previous !== job.id) {
        out.push({ kind: 'JOB_POSTING_REPOINTED_TO_OWNER', jobPostingId: previous, expectedJobPostingId: job.id });
      }
    } else if (previous && previous !== job.id) {
      out.push({ kind: 'JOB_POSTING_TITLE_DIFFERS_STORED', jobPostingId: previous, expectedJobPostingId: job.id });
    } else {
      out.push({ kind: 'JOB_POSTING_BY_TITLE_ONLY', jobPostingId: job.id, expectedJobPostingId: null });
    }
    return out;
  }

  /** SAVEPOINT: falha ao gravar a divergência não derruba o card (best-effort, mas nunca mudo: reportError). */
  private async recordDivergence(
    client: PoolClient,
    payload: TalentumPrescreeningResponseParsed,
    prescreeningRowId: string,
    workerId: string | null,
    d: { kind: TalentumDivergenceKind; jobPostingId: string | null; expectedJobPostingId: string | null },
    environment: WebhookEnvironment,
  ): Promise<void> {
    await client.query('SAVEPOINT talentum_divergence');
    try {
      await this.prescreeningRepo.insertDivergence({
        kind: d.kind,
        talentumPrescreeningId: payload.data.prescreening.id,
        talentumProfileId: payload.data.profile.id,
        prescreeningId: prescreeningRowId,
        workerId,
        jobPostingId: d.jobPostingId,
        expectedJobPostingId: d.expectedJobPostingId,
        environment,
      }, client);
      await client.query('RELEASE SAVEPOINT talentum_divergence');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT talentum_divergence');
      reportError(err instanceof Error ? err : new Error(String(err)), {
        source: 'ProcessTalentumPrescreening:recordDivergence',
        kind: d.kind,
      });
    }
  }

  // ── Funnel stage sync + encuadre ─────────────────────────────────

  private async syncFunnelAndEncuadre(
    prescreening: { id: string; workerId: string | null; jobPostingId: string | null; talentumPrescreeningId: string },
    payload: TalentumPrescreeningResponseParsed,
  ): Promise<void> {
    if (!prescreening.workerId || !prescreening.jobPostingId) {
      // O alarme (linha em talentum_webhook_divergences + reportError) já saiu em persistPrescreening.
      console.log(
        `${TAG} syncFunnel SKIPPED — sem worker/vaga: workerId=${prescreening.workerId}, ` +
        `jobPostingId=${prescreening.jobPostingId}, prescreeningId=${prescreening.id}`,
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
    return deriveFunnelStage(payload.subtype, payload.data.response.statusLabel);
  }

  private async upsertApplicationAndEmitEvent(
    workerId: string,
    jobPostingId: string,
    funnelStage: string,
    matchScore: number,
    prescreeningId?: string,
  ): Promise<void> {
    // F3 (mig 191): NOT_QUALIFIED não existe mais no enum — converter pra REJECTED antes do upsert.
    const effectiveFunnelStage = toPersistedFunnelStage(funnelStage);

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
      // `source` só MEDE quem disparou (webhook × arrasto humano no Kanban); lido por StageMessageHandler.
      [JSON.stringify({ workerId, jobPostingId, source: 'talentum' })],
    );
    const eventId = result.rows[0].id;
    console.log(`${TAG} QUALIFIED transition → domain_event id=${eventId}`);
    return eventId;
  }

  private async handleNotQualifiedTransition(
    client: PoolClient, workerId: string, jobPostingId: string, funnelStage: string, previousStage: string | null,
    prescreeningId?: string,
  ): Promise<void> {
    // Implementação única em talentumFunnel.ts (também usada pelo script de reconciliação).
    if (await applyNotQualifiedTransition(client, workerId, jobPostingId, funnelStage, previousStage, prescreeningId)) {
      console.log(`${TAG} NOT_QUALIFIED auto-reject complete → WJA stage=REJECTED | worker=${workerId} | job=${jobPostingId}`);
    }
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

    // PII: nunca o nome — worker/job já são o id estável pra achar a pessoa no banco;
    // `hasName` só confirma que o campo veio preenchido do Talentum.
    console.log(`${TAG} ensureEncuadre | worker=${workerId} | job=${jobPostingId} | hasName=${Boolean(workerName.trim())}`);
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
