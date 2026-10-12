import type { Pool, PoolClient } from 'pg';
import { withSessionAdvisoryLock } from '@shared/database/sessionAdvisoryLock';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { countryToTimezone } from '@shared/locale/CountryTimezone';
import {
  StoreAdmissionSummaryDocument,
} from '@modules/patient-documents/application/StoreAdmissionSummaryDocument';
import type { AdmissionEventRepository } from '../infrastructure/AdmissionEventRepository';
import type { AdmissionImportRepository, ImportCandidate } from '../infrastructure/AdmissionImportRepository';
import {
  REHEARSAL_BUCKET_MISSING,
  SKIPPED_TEST_EVENT,
  admissionRealm,
  isBlockedFromPaidPath,
  transcriptDestination,
} from '../domain/admissionRealm';
import { renderAdmissionSummaryPdf } from '../infrastructure/admissionSummaryPdf';
import {
  IMPORT_EXPIRE_AFTER_MS,
  IMPORT_MIN_DELAY_MS,
  WRONG_ACCOUNT_AFTER_MS,
  joinParts,
} from '../domain/admissionImport';
import type { AdmissionLogger } from './AdmissionMessagingService';
import { assertSummaryShape } from './admissionSummaryGate';
import { AdmissionTranscriptReader, sha256Hex } from './AdmissionTranscriptReader';
import {
  AdmissionSummaryError,
  MAX_SUMMARY_ATTEMPTS,
  SUMMARY_ATTEMPTS_EXHAUSTED,
  type AdmissionSummaryResult,
  TranscriptVaultError,
  type AdmissionSummaryPort,
  type RehearsalVaultPort,
  type TranscriptVaultPort,
} from './ports/AdmissionImportPorts';
import {
  TactiqUnauthorizedError,
  type TactiqMcpPort,
  type TactiqTokenProvider,
} from './ports/TactiqPorts';

export type ImportOutcome =
  | 'done'
  | 'already_done'
  | 'waiting'
  | 'rejected'
  | 'ambiguous'
  | 'expired'
  | 'blocked'
  | 'wrong_account'
  | 'vault_failed'
  | 'summary_failed'
  | 'transient'
  | 'too_early'
  | 'not_eligible'
  | 'skipped_test'
  | 'skipped_locked';

export interface ImportSummary {
  candidates: number;
  done: number;
  alreadyDone: number;
  waiting: number;
  rejected: number;
  ambiguous: number;
  expired: number;
  blocked: number;
  wrongAccount: number;
  failed: number;
  transient: number;
  skipped: number;
  errors: number;
}

const emptySummary = (): ImportSummary => ({
  candidates: 0, done: 0, alreadyDone: 0, waiting: 0, rejected: 0, ambiguous: 0, expired: 0, blocked: 0, wrongAccount: 0,
  failed: 0, transient: 0, skipped: 0, errors: 0,
});

const SUMMARY_KEY: Record<ImportOutcome, keyof ImportSummary> = {
  done: 'done', already_done: 'alreadyDone', waiting: 'waiting', rejected: 'rejected', ambiguous: 'ambiguous', expired: 'expired',
  blocked: 'blocked', wrong_account: 'wrongAccount', vault_failed: 'failed', summary_failed: 'failed', transient: 'transient',
  too_early: 'skipped', not_eligible: 'skipped', skipped_test: 'skipped', skipped_locked: 'skipped',
};

export interface AdmissionImportServiceDeps {
  repo: AdmissionImportRepository;
  events: AdmissionEventRepository;
  tokens: TactiqTokenProvider;
  mcp: TactiqMcpPort;
  vault: TranscriptVaultPort;
  /** Bucket de ENSAIO (R-29). Ausente = como não configurado: `ensaio` falha fechado. */
  rehearsalVault?: RehearsalVaultPort;
  summary: AdmissionSummaryPort;
  /** Fábrica (não instância): sem `PATIENT_DOCUMENTS_BUCKET` o `new` lança — só roda dentro de `importOne`. */
  documents?: StoreAdmissionSummaryDocument;
  db?: Pool;
  log?: AdmissionLogger;
  now?: () => Date;
}

type Cli = PoolClient;

/** `dd/mm/aaaa` no fuso do país da reunião (a data que a operadora reconhece, não a UTC). */
/** Data da reunião em ISO (AAAA-MM-DD) no fuso do país — o `fecha` que o Gem pede. */
function isoDateLabel(slotStart: Date, country: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: countryToTimezone(country), year: 'numeric', month: '2-digit', day: '2-digit' }).format(slotStart);
}

function dateLabel(slotStart: Date, country: string): string {
  return new Intl.DateTimeFormat('es-AR', { timeZone: countryToTimezone(country), day: '2-digit', month: '2-digit', year: 'numeric' }).format(slotStart);
}

/**
 * AdmissionImportService — a importação do Tactiq (spec 049 F6, §3.3, §4.3, §4.4): MCP -> provas -> cofre -> Vertex -> PDF ->
 * documento. Quem chama é o job de 15 min (`AdmissionImportJob`).
 *
 * Por reunião: advisory lock de sessão (duas execuções sobrepostas não processam a mesma) e NENHUMA transação aberta durante chamada
 * externa. A rede (Tactiq, cofre, Vertex, bucket) roda fora de transação; cada mudança de estado é uma transação CURTA que leva
 * junto o evento da trilha (e, no fim, a linha do documento). Três travas contra duplicata, em camadas:
 *   1. o lock da reunião e o estado `done` (2ª passada = `already_done`);
 *   2. o cofre: nome determinístico `<país>/<appointmentId>/transcricao-<sha256>.txt` com `ifGenerationMatch=0` (nunca sobrescreve);
 *   3. o documento: `UNIQUE(source_appointment_id)` + `ON CONFLICT DO NOTHING`.
 *
 * Texto clínico: a transcrição crua só existe em memória, no cofre (CMEK, só escrita) e no Vertex. NUNCA em log, evento, erro,
 * `patient_documents` nem prompt além do Vertex. O resumo vai (como PDF cifrado) para `patient_documents`. Log e trilha: só ids,
 * contagens, hashes e motivos.
 */
export class AdmissionImportService {
  private readonly db: Pool;
  private readonly log: AdmissionLogger;
  private readonly now: () => Date;
  private readonly documents: StoreAdmissionSummaryDocument;
  private readonly reader: AdmissionTranscriptReader;

  constructor(private readonly deps: AdmissionImportServiceDeps) {
    this.db = deps.db ?? DatabaseConnection.getInstance().getPool();
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
    this.now = deps.now ?? (() => new Date());
    this.documents = deps.documents ?? new StoreAdmissionSummaryDocument();
    this.reader = new AdmissionTranscriptReader(deps.tokens, deps.mcp);
  }

  async runOnce(now: Date = this.now()): Promise<ImportSummary> {
    const summary = emptySummary();
    const ids = await this.deps.repo.listDueIds(now);
    summary.candidates = ids.length;
    for (const id of ids) {
      try {
        summary[SUMMARY_KEY[await this.importOne(id, now)]] += 1;
      } catch {
        // Uma reunião com defeito não derruba as outras. Sem o texto do erro: pode ecoar dado de terceiro.
        summary.errors += 1;
        this.log.error({ appointmentId: id }, 'admission.import.step_failed');
      }
    }
    this.log.info({ ...summary }, 'admission.import.run_done');
    return summary;
  }

  /**
   * Exclusão mútua por reunião: advisory lock de SESSÃO (não de transação). A conexão que o segura fica ociosa — NENHUMA
   * transação fica aberta enquanto se fala com Tactiq, cofre, Vertex ou bucket. Execução sobreposta não consegue o lock e pula.
   */
  async importOne(appointmentId: string, now: Date = this.now()): Promise<ImportOutcome> {
    const locked = await withSessionAdvisoryLock(this.db, `admission_import:${appointmentId}`, () => this.importHeld(appointmentId, now));
    return locked.acquired ? locked.value : 'skipped_locked';
  }

  /** Transação CURTA (estado + trilha + documento juntos). Nunca contém chamada externa. */
  private inTx<T>(fn: (cli: Cli) => Promise<T>): Promise<T> {
    return withActorContext(this.db, fn);
  }

  private async importHeld(id: string, now: Date): Promise<ImportOutcome> {
    const a = await this.deps.repo.find(id);
    if (!a) return 'not_eligible';
    if (a.import_status === 'done') return 'already_done';
    if (
      a.status !== 'booked' || !a.admission_code || !a.conference_ended_at ||
      !['pending', 'waiting', 'blocked'].includes(a.import_status ?? '')
    ) {
      return 'not_eligible';
    }
    // R-18: a função de domínio decide ANTES de qualquer porta (token do Tactiq, MCP, cofre, Vertex). `test` não entra: UM
    // `skipped_test` na trilha (sob o lock da reunião) e a reunião sai da fila (`listDueIds`).
    const realm = admissionRealm({ isTest: a.patient_is_test, rehearsalUntil: a.rehearsal_until, now });
    if (isBlockedFromPaidPath(realm)) {
      if (!(await this.deps.repo.hasSkippedTest(a.id, 'import'))) {
        await this.deps.events.append({ appointmentId: a.id, kind: SKIPPED_TEST_EVENT, outcome: 'skipped', reason: 'import', ref: { realm } });
      }
      this.log.info({ appointmentId: a.id, realm }, 'admission.import.skipped_test');
      return 'skipped_test';
    }
    // R-29, FALHA FECHADA: `ensaio` sem bucket de ensaio não chama NADA pago (token, Tactiq, cofre, Vertex) nem cai no cofre de 5
    // anos. `blocked` com o motivo na trilha (UM evento na transição); volta à fila e segue quando a env existir.
    if (transcriptDestination(realm) === 'rehearsal' && !this.deps.rehearsalVault?.isConfigured()) {
      await this.setBlocked(a, REHEARSAL_BUCKET_MISSING);
      this.log.error({ appointmentId: a.id, reason: REHEARSAL_BUCKET_MISSING, realm }, 'admission.import_blocked');
      return 'blocked';
    }
    // Teto de tentativas de resumo (custo do Vertex): contado pelos eventos, sob o lock da reunião (vale para execuções sobrepostas).
    if ((await this.deps.repo.countModelSummaryFailures(a.id)) >= MAX_SUMMARY_ATTEMPTS) {
      // O evento entra UMA vez, mesmo se a reunião já estava `blocked` por outro motivo (senão ela nunca sai da fila).
      if (!(await this.deps.repo.hasBlockedReason(a.id, SUMMARY_ATTEMPTS_EXHAUSTED))) {
        await this.inTx(async (cli) => {
          await this.deps.repo.setState(a.id, 'blocked', cli);
          await this.deps.events.append({ appointmentId: a.id, kind: 'import_blocked', outcome: 'blocked', reason: SUMMARY_ATTEMPTS_EXHAUSTED }, cli);
        });
      }
      this.log.error({ appointmentId: a.id, reason: SUMMARY_ATTEMPTS_EXHAUSTED }, 'admission.import_blocked');
      return 'blocked';
    }
    const endedAt = a.conference_ended_at;
    if (now.getTime() < endedAt.getTime() + IMPORT_MIN_DELAY_MS) return 'too_early';
    const expired = now.getTime() - endedAt.getTime() >= IMPORT_EXPIRE_AFTER_MS;

    // 1 a 4. a leitura do Tactiq (token, busca, provas, páginas, integridade), uma por vez por responsável (R-53).
    const read = await this.reader.read(a);
    switch (read.kind) {
      case 'busy':
        return this.transient(a, 'busy'); // outra leitura do mesmo responsável: sem estado, sem tentativa, na rodada seguinte
      case 'no_access':
        if (read.reason === 'transient') return this.transient(a, 'token');
        return expired ? this.expire(a, 'no_link') : this.block(a, 'no_link');
      case 'mcp_failed':
        return this.mcpFailure(a, read.err, read.where);
      case 'verdict':
        switch (read.decision.kind) {
          case 'none':
            return this.noMatch(a, read.decision.reason, now, expired);
          case 'rejected':
            return this.terminal(a, 'rejected', 'import_rejected', read.decision.reason);
          default:
            return this.terminal(a, 'ambiguous', 'import_ambiguous', read.decision.reason);
        }
      case 'integrity':
        return this.terminal(a, 'rejected', 'import_rejected', 'integrity');
      default:
        break;
    }
    const parts = read.parts;
    const fullText = joinParts(parts);
    const fullHash = sha256Hex(fullText);
    const body = Buffer.from(fullText, 'utf8');
    await this.deps.events.append({
      appointmentId: a.id, kind: 'import_matched', outcome: 'matched',
      ref: {
        parts: parts.length, meetingIds: parts.map((p) => p.meetingId).join(','),
        partSha256: parts.map((p) => p.sha256).join(','), chars: parts.reduce((n, p) => n + p.chars, 0), sha256: fullHash,
      },
    });
    this.log.info({ appointmentId: a.id, parts: parts.length, sha256: fullHash }, 'admission.import_matched');

    // 5. o cofre (real) ou o bucket de ensaio: só cria; 412 = já está lá (idempotente). O destino vem do `realm`, nunca do `is_test`.
    const objectName = `${a.country}/${a.id}/transcricao-${fullHash}.txt`;
    const destination = { vault: this.deps.vault, rehearsal: this.deps.rehearsalVault, none: undefined }[transcriptDestination(realm)];
    try {
      if (!destination) throw new TranscriptVaultError('not_configured');
      const put = await destination.putOnce(objectName, body, { sha256: fullHash });
      if (put.outcome === 'created') {
        await this.deps.events.append({ appointmentId: a.id, kind: 'transcript_vaulted', outcome: 'created', ref: { object: objectName, generation: put.generation, sha256: fullHash, bytes: body.byteLength } });
        this.log.info({ appointmentId: a.id, sha256: fullHash, bytes: body.byteLength }, 'admission.transcript_vaulted');
      } else {
        if (!(await this.deps.repo.hasEvent(a.id, 'transcript_vaulted'))) {
          await this.deps.events.append({ appointmentId: a.id, kind: 'transcript_vaulted', outcome: 'already_vaulted', ref: { object: objectName, sha256: fullHash, bytes: body.byteLength } });
        }
        this.log.info({ appointmentId: a.id, sha256: fullHash }, 'admission.transcript_already_vaulted');
      }
    } catch (err) {
      const reason = err instanceof TranscriptVaultError ? err.reason : 'unexpected';
      await this.deps.events.append({ appointmentId: a.id, kind: 'vault_write_failed', outcome: 'failed', reason });
      this.log.error({ appointmentId: a.id, reason }, 'admission.vault_write_failed');
      return 'vault_failed';
    }

    // 6. o resumo (Vertex) e o PDF.
    let generated: AdmissionSummaryResult;
    // R-20: o rastro contável sai ANTES da chamada paga (só ids e o `realm`). Se a chamada falhar, o log já existe.
    this.log.info({ provider: 'vertex', appointmentId: a.id, realm }, 'admission.paid_call');
    try {
      generated = assertSummaryShape(await this.deps.summary.generate({ transcript: fullText, entrevistaId: a.admission_code, fecha: isoDateLabel(a.slot_start, a.country) }));
    } catch (err) {
      const reason = err instanceof AdmissionSummaryError ? err.reason : 'unexpected';
      const placeholders = err instanceof AdmissionSummaryError ? err.placeholders : [];
      const errorClass = err instanceof AdmissionSummaryError ? err.errorClass : undefined;
      await this.deps.events.append({
        appointmentId: a.id, kind: 'summary_failed', outcome: 'failed', reason,
        ...(placeholders.length ? { ref: { placeholders: placeholders.join(',') } } : {}),
      });
      this.log.error({ appointmentId: a.id, reason, ...(placeholders.length ? { placeholders } : {}), ...(errorClass ? { errorClass } : {}) }, 'admission.summary_failed');
      // credencial quebrada: log ADICIONAL com nome próprio (alerta dedicado no futuro); o `admission.summary_failed` acima segue sendo o que o alerta vigia.
      if (reason === 'vertex_auth_failed') this.log.error({ appointmentId: a.id, reason }, 'admission.vertex_auth_failed');
      return 'summary_failed';
    }
    // Daqui em diante a chamada ao modelo JÁ foi paga: falha no PDF, no bucket ou na transação vira `post_model_failed` (conta no teto).
    const label = `Resumen de admisión · ${dateLabel(a.slot_start, a.country)}`;
    let prepared: Awaited<ReturnType<StoreAdmissionSummaryDocument['prepare']>> | undefined;
    let stored;
    try {
      const pdf = await renderAdmissionSummaryPdf({ title: label, body: generated.summary, structured: generated.structured });
      // o objeto do PDF sobe SEM transação; a linha do documento + `summary_saved` + `done` entram numa transação curta.
      prepared = await this.documents.prepare({
        patientId: a.patient_id, appointmentId: a.id, pdf, originalFilename: `resumen-admision-${a.admission_code}.pdf`, label,
      });
      const ready = prepared;
      stored = await this.inTx(async (cli) => {
        const r = await ready.commit(cli);
        if (r.outcome === 'stored') {
          await this.deps.events.append(
            { appointmentId: a.id, kind: 'summary_saved', outcome: 'saved', ref: { documentId: r.documentId, promptVersion: generated.promptVersion, bytes: r.sizeBytes, sha256: r.sha256 } },
            cli,
          );
        }
        await this.deps.repo.setState(a.id, 'done', cli);
        return r;
      });
    } catch (err) {
      if (prepared) await prepared.discard().catch(() => undefined); // sem objeto órfão no bucket
      await this.deps.events.append({ appointmentId: a.id, kind: 'summary_failed', outcome: 'failed', reason: 'post_model_failed' });
      this.log.error({ appointmentId: a.id, reason: 'post_model_failed', errorClass: err instanceof Error ? err.constructor.name : 'unknown' }, 'admission.summary_failed');
      return 'summary_failed';
    }
    if (stored.outcome === 'duplicate') {
      this.log.info({ appointmentId: a.id }, 'admission.import.already_done');
      return 'already_done';
    }
    this.log.info({ appointmentId: a.id, documentId: stored.documentId, promptVersion: generated.promptVersion }, 'admission.summary_saved');
    return 'done';
  }

  // ── caminhos sem importação (cada um: UMA transação curta com estado + trilha) ─────────────────────

  /** 0 candidatas: espera (tentativa n); 72 h -> `expired`; a conta não vê reunião nenhuma depois de 3 h -> conta errada. */
  private async noMatch(a: ImportCandidate, reason: 'not_found' | 'code_mismatch', now: Date, expired: boolean): Promise<ImportOutcome> {
    if (expired) return this.expire(a, reason);
    if (reason === 'not_found' && now.getTime() - (a.conference_ended_at as Date).getTime() >= WRONG_ACCOUNT_AFTER_MS) {
      const changed = await this.deps.tokens.markWrongAccount(a.host_email);
      await this.setBlocked(a, 'wrong_account');
      this.log.error({ appointmentId: a.id, reason: 'wrong_account', linkChanged: changed }, 'admission.import_blocked');
      return 'wrong_account';
    }
    await this.inTx(async (cli) => {
      if (a.import_status !== 'waiting') {
        await this.deps.events.append({ appointmentId: a.id, kind: 'import_waiting', outcome: 'waiting', reason }, cli);
      }
      await this.deps.repo.setState(a.id, 'waiting', cli, { countAttempt: true });
    });
    this.log.info({ appointmentId: a.id, reason, attempt: a.import_attempts + 1 }, 'admission.import_waiting');
    return 'waiting';
  }

  private async terminal(a: ImportCandidate, state: 'rejected' | 'ambiguous', kind: string, reason: string): Promise<ImportOutcome> {
    await this.inTx(async (cli) => {
      await this.deps.repo.setState(a.id, state, cli);
      await this.deps.events.append({ appointmentId: a.id, kind, outcome: state, reason }, cli);
    });
    this.log.error({ appointmentId: a.id, reason }, `admission.${kind}`);
    return state;
  }

  private async expire(a: ImportCandidate, reason: string): Promise<ImportOutcome> {
    await this.inTx(async (cli) => {
      await this.deps.repo.setState(a.id, 'expired', cli);
      await this.deps.events.append({ appointmentId: a.id, kind: 'import_expired', outcome: 'expired', reason }, cli);
    });
    this.log.error({ appointmentId: a.id, reason, hostEmailKnown: Boolean(a.host_email) }, 'admission.import_expired');
    return 'expired';
  }

  private async block(a: ImportCandidate, reason: 'no_link'): Promise<ImportOutcome> {
    await this.setBlocked(a, reason);
    this.log.error({ appointmentId: a.id, reason }, 'admission.import_blocked');
    return 'blocked';
  }

  /** `blocked` com motivo. O evento entra só na TRANSIÇÃO; o log de alarme sai a cada execução enquanto durar. */
  private async setBlocked(a: ImportCandidate, reason: string): Promise<void> {
    if (a.import_status === 'blocked') return;
    await this.inTx(async (cli) => {
      await this.deps.repo.setState(a.id, 'blocked', cli);
      await this.deps.events.append({ appointmentId: a.id, kind: 'import_blocked', outcome: 'blocked', reason }, cli);
    });
  }

  private transient(a: ImportCandidate, where: string): ImportOutcome {
    this.log.warn({ appointmentId: a.id, reason: where }, 'admission.import.transient');
    return 'transient';
  }

  /** 401/403 do MCP derruba o vínculo (e bloqueia); rede/5xx só adia. Nunca o corpo nem a mensagem do erro. */
  private async mcpFailure(a: ImportCandidate, err: unknown, where: string): Promise<ImportOutcome> {
    if (err instanceof TactiqUnauthorizedError) {
      await this.deps.tokens.markBroken(a.host_email);
      await this.setBlocked(a, 'no_link');
      this.log.error({ appointmentId: a.id, reason: 'unauthorized', where }, 'admission.import_blocked');
      return 'blocked';
    }
    return this.transient(a, `${where}:${(err as { reason?: string })?.reason ?? 'unexpected'}`);
  }
}
