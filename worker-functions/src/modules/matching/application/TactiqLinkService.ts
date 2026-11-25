import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { withSessionAdvisoryLock } from '@shared/database/sessionAdvisoryLock';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { TactiqLinkRepository, type TactiqLinkRow } from '../infrastructure/TactiqLinkRepository';
import { ChromeReportRepository } from '../infrastructure/ChromeReportRepository';
import type { ExtensionState } from '../domain/chromeExtensionState';
import {
  CONSENT_SCOPE_FROZEN,
  effectiveScopeHasDetails,
  isRecheckable,
  isSeatCause,
  type LastDegrade,
} from '../domain/tactiqRecheck';
import { canStartLink, SEAT_DECLARED_KIND, SEAT_UNDECLARED_KIND } from '../domain/tactiqSeatGate';
import { hashState, newOAuthState, newPkcePair } from '../infrastructure/tactiq/pkce';
import {
  denyReason,
  sanitizeAccessTitle,
  sanitizeScopeList,
  type AccessVerdict,
  type BrokenSource,
  TactiqInvalidGrantError,
  TactiqTransientError,
  TactiqUnauthorizedError,
  type HostAccessResult,
  type TactiqLinkGate,
  type TactiqLinkState,
  type TactiqMcpPort,
  type TactiqOAuthPort,
  type TactiqTokenProvider,
} from './ports/TactiqPorts';
import type { AdmissionLogger } from './AdmissionMessagingService';

/** `state` do callback inexistente, vencido (10 min), já usado ou adulterado → 400, nada gravado. */
export class TactiqStateInvalidError extends Error {
  readonly code = 'TACTIQ_STATE_INVALID';
  constructor() {
    super('Invalid or expired state');
    this.name = 'TactiqStateInvalidError';
  }
}

/** O Tactiq recusou a troca do código (ou não devolveu refresh token). Só o motivo fechado, nunca o corpo. */
export class TactiqExchangeFailedError extends Error {
  readonly code = 'TACTIQ_EXCHANGE_FAILED';
  constructor(readonly reason: string) {
    super(`tactiq_exchange_failed:${reason}`);
    this.name = 'TactiqExchangeFailedError';
  }
}

/**
 * O vínculo NÃO foi gravado: a conta não provou acesso (`access_denied`), o formato do teste não foi reconhecido
 * (`access_unrecognized`) ou o teste falhou por rede/5xx (`ping_transient`, fail closed). `redirectReason` é o que o controller
 * devolve ao navegador; `reason` (a causa tipada) só vai à trilha. Sem token, e-mail nem corpo de resposta.
 */
export class TactiqAccessDeniedError extends Error {
  readonly code = 'TACTIQ_ACCESS_DENIED';
  constructor(readonly redirectReason: 'access_denied' | 'access_unrecognized' | 'ping_transient') {
    super(`tactiq_${redirectReason}`);
    this.name = 'TactiqAccessDeniedError';
  }
}

/** Sem a licença declarada pelo Acesso Master e sem vínculo anterior, o vínculo não começa (F5, D16). A tela esconde o botão pela mesma regra. */
export class TactiqSeatNotDeclaredError extends Error {
  readonly code = 'TACTIQ_SEAT_NOT_DECLARED';
  constructor() {
    super('Tactiq seat not declared');
    this.name = 'TactiqSeatNotDeclaredError';
  }
}

export const STATE_TTL_MS = 10 * 60 * 1000;
/** Operadora do roster sem vínculo vivo há MAIS de 48 h (estritamente maior) → alarme ao gestor. */
export const MISSING_ALARM_HOURS = 48;

export interface OwnLinkView {
  status: TactiqLinkState;
  linkedAt: string | null;
  lastCheckAt: string | null;
  statusChangedAt: string | null;
  /** Extensão do Tactiq no Chrome da PRÓPRIA pessoa (a linha que o `ChromeReportJob` grava e de onde sai o aviso do sino). */
  extension: OwnExtensionView;
  /** Negativa de acesso pendente (a última tentativa de vínculo foi recusada por acesso); `null` = nenhuma. Derivado da trilha, nunca gravado. */
  accessDenial: OwnAccessDenial | null;
  /** Pode começar o vínculo (F5, D16): dono da regra é `canStartLink` (domínio); a tela lê ISTO e nunca recalcula. */
  canStartLink: boolean;
}

export interface OwnAccessDenial {
  /** `scope_without_details` | `access_action:<v>` | `access_unrecognized` | `mcp_transport_401_403` — código interno, a tela não o exibe. */
  reason: string;
  /** Título do Tactiq, já sanitizado; pode ser nulo. */
  title: string | null;
  at: string;
  /** Falta de assento (`isSeatCause`, D9): a tela lê ISTO, nunca o `reason`. */
  seatMissing: boolean;
  /** O Acesso Master já foi avisado neste episódio (D12). Só significa algo com `seatMissing`. */
  adminNotified: boolean;
  /** O teste diário volta a vincular sozinho quando o assento chegar (`isRecheckable` ∧ escopo efetivo com `details`, D13). Só com `seatMissing`. */
  autoReactivates: boolean;
}

/** `sem_relatorio` também cobre "nunca reportou" (sem linha): o job trata a falta de linha assim; nunca `null`, nunca `ausente`. */
export interface OwnExtensionView {
  state: ExtensionState;
  reportedAt: string | null;
}

export interface TactiqCheckSummary {
  rosterHosts: number;
  pinged: number;
  ok: number;
  broken: number;
  transient: number;
  /** Linhas `broken`/`wrong_account` re-testadas nesta rodada (F2) e as que voltaram a `linked`. */
  rechecked: number;
  reactivated: number;
  notified: number;
  alarms: number;
}

interface Cipher {
  encrypt(plain: string): Promise<string | null>;
  decrypt(cipher: string): Promise<string>;
}

export interface TactiqLinkServiceDeps {
  repo: TactiqLinkRepository;
  /** Padrão: `ChromeReportRepository` sobre `db`. */
  chromeReports?: ChromeReportRepository;
  oauth: TactiqOAuthPort;
  mcp: TactiqMcpPort;
  cipher?: Cipher;
  publisher?: SystemNotificationPublisher;
  db?: Pool;
  clientId?: () => string | null;
  log?: AdmissionLogger;
  now?: () => Date;
  /** Escopo congelado no consentimento (design D5). Padrão: `CONSENT_SCOPE_FROZEN`; o teste injeta os dois valores. */
  consentScopeFrozen?: boolean;
}

/** Chave da trava por responsável: e-mail em minúsculas, sem nunca ir para log, erro ou trilha. */
const hostLockKey = (email: string): string => `tactiq_link:${email.toLowerCase()}`;

type NoticeState = Exclude<TactiqLinkState, 'linked'>;
const noticeReason = (s: NoticeState): 'missing' | 'broken' | 'wrong_account' => (s === 'revoked' ? 'missing' : s);

/**
 * TactiqLinkService — o vínculo do responsável de admissão com a conta dele no Tactiq (spec 049 F4, §3.0.1).
 *
 *  - vincular: `startLink` (PKCE S256, cliente público; verifier cifrado e guardado por state, 10 min, uso único) e
 *    `completeLink` (callback: troca o código, cifra o refresh token com o KMS, grava `linked`);
 *  - a trava: `statesFor` (o `POST` de agenda recusa responsável sem `linked`);
 *  - o teste diário: `runDailyCheck` — refresh com ROTAÇÃO, `ping`, `broken` se o Tactiq recusou; operadora do roster sem
 *    linha é `missing`; AVISO NO SINO por TRANSIÇÃO de estado (não a cada rodada); ALARME ao gestor > 48 h.
 *
 * Token: cifrado em repouso, nunca em log, erro, resposta HTTP nem evento. Logs só com ids (`linkId`, `hostId`).
 */
export class TactiqLinkService implements TactiqLinkGate, TactiqTokenProvider {
  private readonly repo: TactiqLinkRepository;
  private readonly chromeReports: ChromeReportRepository;
  private readonly cipher: Cipher;
  private readonly publisher: SystemNotificationPublisher;
  private readonly db: Pool;
  private readonly log: AdmissionLogger;
  private readonly now: () => Date;

  constructor(private readonly deps: TactiqLinkServiceDeps) {
    this.repo = deps.repo;
    const kms = new KMSEncryptionService();
    this.cipher = deps.cipher ?? {
      encrypt: (p) => kms.encrypt(p),
      decrypt: (c) => kms.decrypt(c),
    };
    this.publisher = deps.publisher ?? new SystemNotificationPublisher();
    this.db = deps.db ?? DatabaseConnection.getInstance().getPool();
    this.chromeReports = deps.chromeReports ?? new ChromeReportRepository(this.db);
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
    this.now = deps.now ?? (() => new Date());
  }

  // ── a trava ────────────────────────────────────────────────────────────────────────────────────────
  async statesFor(emails: string[]): Promise<Map<string, TactiqLinkState>> {
    const persisted = await this.repo.statusesByEmail(emails);
    return new Map(emails.map((e) => [e.toLowerCase(), persisted.get(e.toLowerCase()) ?? 'missing'] as const));
  }

  /** Quais e-mails (minúsculos) têm a licença declarada — a listagem de Entrevistadores lê da trilha, nunca recalcula (F5, D16). */
  seatsDeclaredFor(emails: string[]): Promise<Set<string>> {
    return this.repo.seatDeclaredAmong(emails);
  }

  // ── o PRÓPRIO vínculo ──────────────────────────────────────────────────────────────────────────────
  async getOwn(email: string): Promise<OwnLinkView> {
    const row = await this.repo.findByEmail(email);
    const report = await this.chromeReports.findByEmail(email);
    const extension: OwnExtensionView = report
      ? { state: report.state, reportedAt: report.report_at ? report.report_at.toISOString() : null }
      : { state: 'sem_relatorio', reportedAt: null };
    const accessDenial = await this.accessDenialOf(email, row);
    const startable = canStartLink({ hasRow: row !== null, seatDeclared: await this.repo.seatDeclared(email) });
    if (!row) return { status: 'missing', linkedAt: null, lastCheckAt: null, statusChangedAt: null, extension, accessDenial, canStartLink: startable };
    return {
      status: row.status,
      linkedAt: row.linked_at ? row.linked_at.toISOString() : null,
      lastCheckAt: row.last_check_at ? row.last_check_at.toISOString() : null,
      statusChangedAt: row.status_changed_at.toISOString(),
      extension,
      accessDenial,
      canStartLink: startable,
    };
  }

  /**
   * Só a ÚLTIMA tentativa conta: `linked` ou `reactivated` (re-teste diário) mais novo limpa a negativa. `exchange_failed` e `ping_transient` não são orientação de
   * acesso (a tela mostra o banner genérico) → `null`. A queda `broken` só vira negativa quando a causa é ASSENTO (D13); qualquer outra queda → `null`.
   * Sem e-mail, sem token: só reason, título sanitizado, data e os 3 derivados.
   */
  private async accessDenialOf(email: string, row: TactiqLinkRow | null): Promise<OwnAccessDenial | null> {
    const last = await this.repo.latestLinkAttempt(email);
    if (!last || !last.reason) return null;
    const seatMissing = isSeatCause(last.reason);
    if (last.kind === 'tactiq_link.broken') {
      if (!seatMissing) return null;
    } else if (last.kind !== 'tactiq_link.link_rejected' || (last.outcome !== 'access_denied' && last.outcome !== 'access_unrecognized')) {
      return null;
    }
    const base = { reason: last.reason, title: sanitizeAccessTitle(last.ref?.title), at: last.at.toISOString() };
    if (!seatMissing) return { ...base, seatMissing: false, adminNotified: false, autoReactivates: false };
    const lastDegrade = row ? await this.repo.lastDegrade(email) : null;
    return {
      ...base,
      seatMissing: true,
      adminNotified: await this.repo.seatEpisodeNotified(email),
      autoReactivates: row ? this.seatAutoReactivates(row.status, lastDegrade, await this.repo.lastLinkScope(email)) : false,
    };
  }

  /**
   * Esta falta de assento volta sozinha? (D13) O teste diário tem de poder re-testar a linha (`isRecheckable`) E o escopo efetivo
   * ter `details` (escopo congelado + `own` → não: o Tactiq não amplia a autorização, F25). Dono único: o aviso do host, o do Master e o perfil.
   */
  private seatAutoReactivates(status: string, lastDegrade: LastDegrade | null, lastLinkScope: string | null): boolean {
    return (
      isRecheckable({ status, lastDegrade }) &&
      effectiveScopeHasDetails({
        refreshScope: null,
        lastLinkScope,
        frozen: this.deps.consentScopeFrozen ?? CONSENT_SCOPE_FROZEN,
      })
    );
  }

  async startLink(input: { uid: string; email: string }): Promise<{ authorizeUrl: string }> {
    const seatDeclared = await this.repo.seatDeclared(input.email);
    const hasRow = (await this.repo.findByEmail(input.email)) !== null;
    if (!canStartLink({ hasRow, seatDeclared })) throw new TactiqSeatNotDeclaredError();
    const now = this.now();
    const state = newOAuthState();
    const { codeVerifier, codeChallenge } = newPkcePair();
    const verifierEncrypted = await this.cipher.encrypt(codeVerifier);
    if (!verifierEncrypted) throw new Error('tactiq_verifier_not_encrypted');
    const authorizeUrl = await this.deps.oauth.buildAuthorizeUrl({ state, codeChallenge });
    await this.repo.insertOAuthState({
      stateHash: hashState(state),
      uid: input.uid,
      email: input.email,
      verifierEncrypted,
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
      now,
    });
    this.log.info({}, 'admission.tactiq_link.start');
    return { authorizeUrl };
  }

  /** Callback do OAuth. O state é a identidade: dono (uid + e-mail) e verifier saem dele. Nada é gravado antes de ele valer. */
  async completeLink(input: { state: string; code: string }): Promise<{ email: string }> {
    const now = this.now();
    const consumed = await this.repo.consumeOAuthState(hashState(input.state), now);
    if (!consumed) throw new TactiqStateInvalidError();

    let refreshToken: string;
    let accessToken: string;
    let scope: string | undefined;
    try {
      const verifier = await this.cipher.decrypt(consumed.verifierEncrypted);
      ({ refreshToken, accessToken, scope } = await this.deps.oauth.exchangeCode({ code: input.code, codeVerifier: verifier }));
    } catch (err) {
      const reason = err instanceof TactiqInvalidGrantError ? 'invalid_grant' : 'exchange_error';
      if (err instanceof TactiqUnauthorizedError) {
        await this.repo.appendEvent({
          email: consumed.email, kind: 'tactiq_link.link_rejected', outcome: 'exchange_failed', reason: denyReason(err.cause), at: now,
        });
      }
      this.log.warn({ reason }, 'admission.tactiq_link.exchange_failed');
      throw new TactiqExchangeFailedError(reason);
    }

    // O acesso é provado ANTES de cifrar ou gravar qualquer coisa: quem não passa não deixa token nem linha (D1, fail closed D6).
    const scopeRef = sanitizeScopeList(scope)?.join(' ');
    const ref = scopeRef ? { scope: scopeRef } : undefined;
    const reject = async (
      outcome: 'access_denied' | 'access_unrecognized' | 'ping_transient',
      reason: string,
      extra: Record<string, unknown> = {},
    ): Promise<never> => {
      await this.repo.appendEvent({
        email: consumed.email, kind: 'tactiq_link.link_rejected', outcome, reason, at: now, ref: { ...ref, ...extra },
      });
      this.log.warn({ outcome, reason }, 'admission.tactiq_link.link_rejected');
      throw new TactiqAccessDeniedError(outcome);
    };
    let verdict: AccessVerdict;
    try {
      verdict = await this.deps.mcp.ping(accessToken);
    } catch (err) {
      if (err instanceof TactiqUnauthorizedError) return reject('access_denied', denyReason(err.cause));
      return reject('ping_transient', err instanceof TactiqTransientError ? err.reason : 'unexpected');
    }
    if (verdict.kind === 'denied') {
      const reason = denyReason({ kind: 'access_action', action: verdict.action });
      if (isSeatCause(reason)) {
        const falseDeclaration = await this.repo.seatDeclared(consumed.email);
        await this.keepTokenOnSeatRejection(consumed, refreshToken, now, ref, reason);
        if (falseDeclaration) await this.dropFalseSeatDeclaration(consumed.email, now);
        await this.noticeMastersOfSeatAtLink(consumed, ref?.scope ?? null, now, reason, falseDeclaration);
      }
      return reject('access_denied', reason, verdict.title ? { title: verdict.title } : {});
    }
    if (verdict.kind === 'unrecognized') return reject('access_unrecognized', 'access_unrecognized');

    const tokenEncrypted = await this.cipher.encrypt(refreshToken);
    if (!tokenEncrypted) throw new TactiqExchangeFailedError('empty_token');
    await this.repo.upsertLinked({
      email: consumed.email,
      uid: consumed.uid,
      tokenEncrypted,
      clientId: this.deps.clientId?.() ?? null,
      now,
    });
    await this.repo.appendEvent({ email: consumed.email, kind: 'tactiq_link.linked', outcome: 'linked', at: now, ...(ref ? { ref } : {}) });
    this.log.info({}, 'admission.tactiq_link.linked');
    return { email: consumed.email };
  }

  /**
   * Recusa por falta de assento (F1, reverte D754-D1): guarda o token cifrado numa linha `broken` para a trilha e o re-teste.
   * O evento `broken` só sai se o repositório gravou (linha nova ou token morto trocado): linha `linked` ou outra queda ficam intocadas.
   */
  private async keepTokenOnSeatRejection(
    consumed: { uid: string; email: string },
    refreshToken: string,
    now: Date,
    ref: { scope: string } | undefined,
    seatReason: string,
  ): Promise<void> {
    const tokenEncrypted = await this.cipher.encrypt(refreshToken);
    if (!tokenEncrypted) throw new TactiqExchangeFailedError('empty_token');
    const stored = await this.repo.insertBrokenFromRejection({
      email: consumed.email, uid: consumed.uid, tokenEncrypted, clientId: this.deps.clientId?.() ?? null, now,
    });
    if (!stored) return;
    await this.repo.appendEvent({
      email: consumed.email, kind: 'tactiq_link.broken', outcome: 'broken', reason: seatReason, at: now,
      ref: { source: 'link', ...ref },
    });
    this.log.info({}, 'admission.tactiq_link.token_kept_on_rejection');
  }

  /**
   * Recusa por assento no ATO de vincular (D12): o Acesso Master é avisado 1× por episódio (trilha + trava transacional). O host está na tela,
   * não leva sino. Nunca derruba a recusa: se o aviso falhar, a pessoa ainda recebe o redirect certo e o erro vai ao log (sem e-mail nem nome).
   */
  private async noticeMastersOfSeatAtLink(
    consumed: { uid: string; email: string },
    scope: string | null,
    now: Date,
    seatReason: string,
    falseDeclaration = false,
  ): Promise<void> {
    try {
      const lastDegrade: LastDegrade = { kind: 'tactiq_link.broken', reason: seatReason, source: 'link' };
      // Marcação falsa (F5, D16): a pessoa cai no caminho do legado — o Tactiq congelou o que ela acabou de autorizar. Nunca "volta sozinho".
      const autoReactivates = falseDeclaration ? false : this.seatAutoReactivates('broken', lastDegrade, scope);
      await withActorContext(this.db, (cli) =>
        this.noticeMastersOfSeat(cli, { email: consumed.email, hostUid: consumed.uid, autoReactivates, now, source: 'link' }),
      );
    } catch (err) {
      this.log.error({ reason: (err as { code?: string })?.code ?? 'unexpected' }, 'admission.tactiq_link.master_notice.failed');
    }
  }

  /**
   * Marcação falsa (F5, D16): o Acesso Master declarou a licença e o Tactiq recusou por assento no consentimento. A declaração cai
   * (`seat_undeclared`, ator `system`) para o perfil e a listagem não mentirem; a pessoa segue pelo caminho do legado (tem linha).
   */
  private async dropFalseSeatDeclaration(email: string, now: Date): Promise<void> {
    await this.repo.appendEvent({
      email, kind: SEAT_UNDECLARED_KIND, outcome: 'undeclared', reason: 'seat_not_assigned', at: now, ref: { actorUid: 'system' },
    });
    this.log.warn({}, 'admission.tactiq_link.seat_declaration_dropped');
  }

  // ── licença antes do 1º vínculo (F5, D16) ──────────────────────────────────────────────────────────
  /**
   * O Acesso Master marca/desmarca "Licencia asignada" (rota `interview_host:update`). Grava `seat_declared|seat_undeclared` (`ref.actorUid`, sem
   * e-mail) só quando MUDA a declaração vigente; dentro da transação do chamador. Ao marcar: sem linha → host `seat_ready firstLink=true` 1× por
   * pessoa; com linha cujo escopo efetivo não tem `details` (legado congelado) → `seat_arrived` + host `firstLink=false` (D0.b).
   */
  async declareSeat(input: { email: string; assigned: boolean; actorUid: string }, cli: PoolClient): Promise<{ changed: boolean }> {
    const now = this.now();
    await this.repo.lockSeatTopic('seat_declaration', input.email, cli);
    if ((await this.repo.seatDeclared(input.email, cli)) === input.assigned) return { changed: false };
    await this.repo.appendEvent(
      {
        email: input.email,
        kind: input.assigned ? SEAT_DECLARED_KIND : SEAT_UNDECLARED_KIND,
        outcome: input.assigned ? 'declared' : 'undeclared',
        at: now,
        ref: { actorUid: input.actorUid },
      },
      cli,
    );
    if (!input.assigned) return { changed: true };

    const hostUid = await this.repo.activeUserUidByEmail(input.email, cli);
    if (!(await this.repo.findByEmail(input.email, cli))) {
      await this.noticeSeatReadyFirst(cli, input.email, hostUid, now);
      return { changed: true };
    }
    const hasDetails = effectiveScopeHasDetails({
      refreshScope: null,
      lastLinkScope: await this.repo.lastLinkScope(input.email, cli),
      frozen: this.deps.consentScopeFrozen ?? CONSENT_SCOPE_FROZEN,
    });
    if (!hasDetails) await this.markSeatArrived(cli, { email: input.email, hostUid, now, source: 'declared' });
    return { changed: true };
  }

  /** Host: "já tenés licencia, vinculá una sola vez" — 1× por PESSOA (trava + trilha). Sem usuário não há sino e NÃO carimba. */
  private async noticeSeatReadyFirst(cli: PoolClient, email: string, hostUid: string | null, now: Date): Promise<void> {
    if (!hostUid) {
      this.log.warn({}, 'admission.tactiq_link.seat_ready.no_recipient');
      return;
    }
    await this.repo.lockSeatTopic('seat_ready_first', email, cli);
    if (await this.repo.oneTimeNoticeSent(email, 'seat_ready_first', cli)) return;
    await this.publisher.publishAdmissionTactiqLinkRequired(cli, { recipientUid: hostUid, reason: 'seat_ready', audience: 'host', firstLink: true });
    await this.repo.appendEvent({ email, kind: 'tactiq_link.notified', outcome: 'sent', reason: 'seat_ready_first', at: now }, cli);
  }

  /**
   * O assento CHEGOU para quem já tem linha com o escopo congelado sem `details` (legado, D0.b) — 1× por episódio (`tactiq_link.seat_arrived`).
   * Dois sinais, o que vier primeiro: a marcação "Licencia asignada" do Master (`declared`) ou o re-teste com `ready` sem `details` (`recheck`).
   * Efeito: o host recebe `seat_ready firstLink=false` (a pessoa precisa de UMA autorização nova). Revogação automática NÃO existe (P-C4 não medida).
   */
  private async markSeatArrived(
    cli: PoolClient,
    input: { email: string; hostUid: string | null; now: Date; source: 'declared' | 'recheck' },
  ): Promise<boolean> {
    await this.repo.lockSeatTopic('seat_arrived', input.email, cli);
    if (await this.repo.seatArrivedInEpisode(input.email, cli)) return false;
    await this.repo.appendEvent(
      { email: input.email, kind: 'tactiq_link.seat_arrived', outcome: 'seat_arrived', at: input.now, ref: { source: input.source } },
      cli,
    );
    if (!input.hostUid) {
      this.log.warn({}, 'admission.tactiq_link.seat_ready.no_recipient');
      return true;
    }
    await this.publisher.publishAdmissionTactiqLinkRequired(cli, { recipientUid: input.hostUid, reason: 'seat_ready', audience: 'host', firstLink: false });
    await this.repo.appendEvent({ email: input.email, kind: 'tactiq_link.notified', outcome: 'sent', reason: 'seat_ready_legacy', at: input.now }, cli);
    return true;
  }

  /** Re-teste: `ready` sem `details` com o escopo congelado = o assento chegou mas a autorização não cresce. Nunca derruba o re-teste. */
  private async noticeSeatArrivedFromRecheck(email: string): Promise<void> {
    try {
      await withActorContext(this.db, async (cli) =>
        this.markSeatArrived(cli, { email, hostUid: await this.repo.activeUserUidByEmail(email, cli), now: this.now(), source: 'recheck' }),
      );
    } catch (err) {
      this.log.error({ reason: (err as { code?: string })?.code ?? 'unexpected' }, 'admission.tactiq_link.seat_arrived.failed');
    }
  }

  /**
   * Roster sem linha e sem licença declarada: o Acesso Master é avisado 1× por PESSOA ("marque Licencia asignada"). Sem destinatário → `warn` e
   * tenta amanhã (nada carimbado). Nunca derruba o job.
   */
  private async noticeMastersOfSeatPending(email: string): Promise<void> {
    try {
      await withActorContext(this.db, async (cli) => {
        await this.repo.lockSeatTopic('seat_pending', email, cli);
        if (await this.repo.seatDeclared(email, cli)) return;
        if (await this.repo.oneTimeNoticeSent(email, 'seat_pending_master', cli)) return;
        const hostUid = await this.repo.activeUserUidByEmail(email, cli);
        const masters = (await this.repo.activeMasterUids(cli)).filter((uid) => uid !== hostUid);
        if (masters.length === 0) {
          this.log.warn({}, 'admission.tactiq_link.master_notice.no_recipient');
          return;
        }
        const hostName = (await this.repo.hostDisplayName(email, cli)) ?? undefined;
        for (const recipientUid of masters) {
          await this.publisher.publishAdmissionTactiqLinkRequired(cli, { recipientUid, reason: 'seat_pending', audience: 'master', hostName });
        }
        await this.repo.appendEvent(
          { email, kind: 'tactiq_link.notified', outcome: 'sent', reason: 'seat_pending_master', at: this.now(), ref: { recipients: masters.length } },
          cli,
        );
      });
    } catch (err) {
      this.log.error({ reason: (err as { code?: string })?.code ?? 'unexpected' }, 'admission.tactiq_link.master_notice.failed');
    }
  }

  /**
   * A cópia "{nome} não tem licença do Tactiq" aos membros vivos do Acesso Master, menos o próprio host (D12). Dentro da transação do chamador.
   * 1× por EPISÓDIO (`claimSeatEpisode`): quem já foi avisado neste episódio não recebe de novo. Devolve `adminNotified`: houve (ou já houve)
   * aviso ao Master? Sem destinatário → `warn` sem PII e evento `no_recipient`; o host vê `seatAskAdmin`.
   */
  private async noticeMastersOfSeat(
    cli: PoolClient,
    input: { email: string; hostUid: string | null; autoReactivates: boolean; now: Date; source: 'daily_check' | 'link' },
  ): Promise<boolean> {
    if (!(await this.repo.claimSeatEpisode(input.email, cli))) return true;
    const masters = (await this.repo.activeMasterUids(cli)).filter((uid) => uid !== input.hostUid);
    if (masters.length === 0) {
      this.log.warn({}, 'admission.tactiq_link.master_notice.no_recipient');
      await this.repo.appendEvent(
        { email: input.email, kind: 'tactiq_link.notified', outcome: 'no_recipient', reason: 'seat_missing_master', at: input.now, ref: { source: input.source } },
        cli,
      );
      return false;
    }
    const hostName = (await this.repo.hostDisplayName(input.email, cli)) ?? undefined;
    for (const recipientUid of masters) {
      await this.publisher.publishAdmissionTactiqLinkRequired(cli, {
        recipientUid, reason: 'seat_missing', audience: 'master', hostName, autoReactivates: input.autoReactivates,
      });
    }
    await this.repo.appendEvent(
      { email: input.email, kind: 'tactiq_link.notified', outcome: 'sent', reason: 'seat_missing_master', at: input.now, ref: { source: input.source, recipients: masters.length } },
      cli,
    );
    return true;
  }

  /**
   * Token MORTO (`invalid_grant`, D12): o vínculo não volta sozinho e SÓ a pessoa pode autorizar de novo → o Acesso Master fica sabendo (1× por
   * evento de queda: quem chama só chama quando a queda MUDOU o estado ou na `recheck_dead`). Falta de assento NÃO passa por aqui (T305 já avisa).
   * Nunca derruba quem chamou (o job): falha vai ao log, sem e-mail nem nome.
   */
  private async noticeMastersOfDeadToken(email: string): Promise<void> {
    try {
      await withActorContext(this.db, async (cli) => {
        const hostUid = await this.repo.activeUserUidByEmail(email, cli);
        const masters = (await this.repo.activeMasterUids(cli)).filter((uid) => uid !== hostUid);
        if (masters.length === 0) {
          this.log.warn({}, 'admission.tactiq_link.master_notice.no_recipient');
          return;
        }
        const hostName = (await this.repo.hostDisplayName(email, cli)) ?? undefined;
        for (const recipientUid of masters) {
          await this.publisher.publishAdmissionTactiqLinkRequired(cli, { recipientUid, reason: 'broken', audience: 'master', hostName });
        }
      });
    } catch (err) {
      this.log.error({ reason: (err as { code?: string })?.code ?? 'unexpected' }, 'admission.tactiq_link.master_notice.failed');
    }
  }

  /**
   * A ÚNICA porta para um token do RESPONSÁVEL (R-53): uma leitura do Tactiq por vez por responsável. A trava é advisory de SESSÃO
   * do Postgres (chave `tactiq_link:<e-mail em minúsculas>`, nunca logada): vale entre importação, job de 1 min, teste diário e
   * "Reintentar resumen", e entre instâncias. Dentro dela: a troca com ROTAÇÃO (refresh novo gravado ANTES de qualquer uso) e o
   * `fn(accessToken)` (busca, páginas). `invalid_grant` derruba o vínculo (`broken`, com aviso); rede/KMS não prova nada
   * (`transient`). Ocupada → `busy`, sem tocar estado. Cofre, Vertex e PDF ficam FORA: o chamador os faz depois de `fn`.
   */
  async withHostAccess<T>(email: string, fn: (accessToken: string) => Promise<T>): Promise<HostAccessResult<T>> {
    const locked = await withSessionAdvisoryLock(this.db, hostLockKey(email), async (): Promise<HostAccessResult<T>> => {
      const link = await this.repo.findLinkedTokenByEmail(email);
      if (!link) return { ok: false, reason: 'no_link' };
      let accessToken: string;
      try {
        accessToken = await this.refreshAndRotate(email, link.refresh_token_encrypted);
      } catch (err) {
        if (err instanceof TactiqInvalidGrantError) {
          await this.markBroken(email, 'invalid_grant', 'import');
          return { ok: false, reason: 'broken' };
        }
        this.log.warn({ linkId: link.id, reason: (err as { reason?: string })?.reason ?? 'unexpected' }, 'admission.tactiq_link.token_transient');
        return { ok: false, reason: 'transient' };
      }
      return { ok: true, value: await fn(accessToken) };
    });
    return locked.acquired ? locked.value : { ok: false, reason: 'busy' };
  }

  /** Refresh com ROTAÇÃO: o refresh novo é gravado ANTES de qualquer uso do access token (se o uso falhar, o único válido não se perde). */
  private async refreshAndRotate(email: string, refreshTokenEncrypted: string): Promise<string> {
    const current = await this.cipher.decrypt(refreshTokenEncrypted);
    const tokens = await this.deps.oauth.refresh(current);
    if (tokens.refreshToken && tokens.refreshToken !== current) {
      const enc = await this.cipher.encrypt(tokens.refreshToken);
      if (enc) await this.repo.rotateToken(email, enc);
    }
    return tokens.accessToken;
  }

  linkCreatedAfter(email: string, at: Date): Promise<boolean> {
    return this.repo.linkCreatedAfter(email, at);
  }

  /** Porta da importação (spec 083): o vínculo foi refeito depois do bloqueio? */
  hasLinkedSince(email: string, since: Date): Promise<boolean> {
    return this.repo.hasLinkedSince(email, since);
  }

  /** O Tactiq recusou o token (401/403) durante a importação: o vínculo caiu. `true` só quando MUDOU (uma transição, um aviso). */
  async markBroken(
    email: string,
    outcome: 'invalid_grant' | 'unauthorized' = 'unauthorized',
    source?: BrokenSource,
  ): Promise<boolean> {
    const now = this.now();
    if (!(await this.repo.degrade(email, 'broken', outcome, now))) return false;
    await this.repo.appendEvent({
      email, kind: 'tactiq_link.broken', outcome: 'broken', reason: outcome, at: now, ...(source ? { ref: { source } } : {}),
    });
    await this.noticeOnTransition(email, 'broken');
    if (outcome === 'invalid_grant') await this.noticeMastersOfDeadToken(email);
    return true;
  }

  // ── o teste diário ─────────────────────────────────────────────────────────────────────────────────
  async runDailyCheck(): Promise<TactiqCheckSummary> {
    const summary: TactiqCheckSummary = {
      rosterHosts: 0, pinged: 0, ok: 0, broken: 0, transient: 0, rechecked: 0, reactivated: 0, notified: 0, alarms: 0,
    };

    for (const link of await this.repo.listLinkedWithToken()) {
      const verdict = await this.checkOne(link);
      if (verdict === 'busy') continue; // responsável ocupado (ou sem vínculo vivo agora): não pingou, não rebaixa, não grava nada; amanhã
      summary.pinged += 1;
      summary[verdict] += 1;
    }

    for (const link of await this.repo.listRecheckableWithToken()) {
      if (!isRecheckable({ status: link.status, lastDegrade: link.lastDegrade })) continue;
      const result = await this.recheckOne(link);
      if (result === 'busy') continue;
      summary.rechecked += 1;
      if (result === 'reactivated') summary.reactivated += 1;
    }

    const roster = await this.repo.listActiveRoster();
    summary.rosterHosts = roster.length;
    for (const host of roster) {
      const row = await this.repo.findByEmail(host.email);
      if (!row) {
        await this.ensureMissingEvent(host.email);
        await this.noticeMastersOfSeatPending(host.email);
      }
      const state: TactiqLinkState = row ? row.status : 'missing';
      if (state === 'linked') continue;

      if (await this.noticeOnTransition(host.email, state, row?.firebase_uid ?? null)) summary.notified += 1;
      if (await this.alarmIfStale(host.id, host.email, state, row)) summary.alarms += 1;
    }

    this.log.info({ ...summary }, 'admission.tactiq_link.check_done');
    return summary;
  }

  private async checkOne(link: { id: string; host_email: string }): Promise<'ok' | 'broken' | 'transient' | 'busy'> {
    const now = this.now();
    const email = link.host_email;
    // Na trava: o token é relido AQUI (outra leitura pode ter rotacionado entre a listagem e a vez desta) e o `ping` é o uso.
    const locked = await withSessionAdvisoryLock(this.db, hostLockKey(email), async (): Promise<'ok' | 'broken' | 'transient' | 'skipped'> => {
      const current = await this.repo.findLinkedTokenByEmail(email);
      if (!current) return 'skipped'; // o vínculo caiu entre a listagem e a vez desta: não há o que testar
      try {
        const verdict = await this.deps.mcp.ping(await this.refreshAndRotate(email, current.refresh_token_encrypted));
        // Teste diário: `denied` derruba (com a causa); `unrecognized` segue como `ok` + aviso (formato nunca medido, design D4).
        if (verdict.kind === 'denied') throw new TactiqUnauthorizedError({ kind: 'access_action', action: verdict.action });
        if (verdict.kind === 'unrecognized') this.log.warn({ linkId: link.id }, 'admission.tactiq_link.access_unrecognized');
        await this.repo.recordCheck(email, 'ok', now);
        return 'ok';
      } catch (err) {
        if (err instanceof TactiqInvalidGrantError || err instanceof TactiqUnauthorizedError) {
          const outcome = err instanceof TactiqInvalidGrantError ? 'invalid_grant' : 'unauthorized';
          // `cause` = o motivo tipado; sem causa (`unspecified`, ex.: dublês antigos) o `reason` segue o `outcome`, como antes.
          const cause =
            err instanceof TactiqUnauthorizedError && err.cause.kind !== 'unspecified' ? denyReason(err.cause) : outcome;
          if (await this.repo.degrade(email, 'broken', outcome, now)) {
            await this.repo.appendEvent({
              email, kind: 'tactiq_link.broken', outcome: 'broken', reason: cause, at: now, ref: { source: 'daily_check' },
            });
            if (outcome === 'invalid_grant') await this.noticeMastersOfDeadToken(email);
          }
          this.log.warn({ linkId: link.id, outcome, cause }, 'admission.tactiq_link.broken');
          return 'broken';
        }
        // Rede, 5xx, KMS: não prova vínculo quebrado. Registra e tenta amanhã (derrubar por soluço geraria aviso falso).
        await this.repo.recordCheck(email, 'transient_error', now);
        this.log.warn({ linkId: link.id, reason: (err as { reason?: string })?.reason ?? 'unexpected' }, 'admission.tactiq_link.check_transient');
        return 'transient';
      }
    });
    return locked.acquired && locked.value !== 'skipped' ? locked.value : 'busy';
  }

  /**
   * Re-teste de uma linha `broken`/`wrong_account` com token (F2, design D4-D6), na trava do host. A renovação rotaciona o refresh: o novo
   * entra por compare-and-swap sobre o segredo lido (um revínculo concorrente vence, F23). Reativa só com `ready` E escopo efetivo com
   * `details`; `denied`/`unrecognized`/sem `details` ficam como estão; token morto sai do re-teste (`recheck_dead`); rede/KMS tenta amanhã.
   */
  private async recheckOne(link: {
    id: string;
    host_email: string;
    status: string;
    refresh_token_encrypted: string;
  }): Promise<'reactivated' | 'kept' | 'dead' | 'superseded' | 'transient' | 'busy'> {
    const now = this.now();
    const email = link.host_email;
    const locked = await withSessionAdvisoryLock(this.db, hostLockKey(email), async () => {
      let tokens: Awaited<ReturnType<TactiqOAuthPort['refresh']>>;
      try {
        const current = await this.cipher.decrypt(link.refresh_token_encrypted);
        tokens = await this.deps.oauth.refresh(current);
        if (tokens.refreshToken && tokens.refreshToken !== current) {
          const enc = await this.cipher.encrypt(tokens.refreshToken);
          if (enc && !(await this.repo.rotateTokenIfUnchanged(link.id, link.refresh_token_encrypted, enc))) {
            this.log.warn({ linkId: link.id }, 'admission.tactiq_link.recheck_superseded');
            return 'superseded' as const;
          }
        }
      } catch (err) {
        const dead =
          err instanceof TactiqInvalidGrantError
            ? 'invalid_grant'
            : err instanceof TactiqUnauthorizedError && err.cause.kind === 'token_endpoint'
              ? denyReason(err.cause)
              : null;
        if (dead) {
          await this.repo.recordCheck(email, dead, now);
          await this.repo.appendEvent({ email, kind: 'tactiq_link.recheck_dead', outcome: 'recheck_dead', reason: dead, at: now });
          this.log.warn({ linkId: link.id }, 'admission.tactiq_link.recheck_dead');
          await this.noticeMastersOfDeadToken(email);
          return 'dead' as const;
        }
        return this.recheckTransient(link.id, email, now, err);
      }

      let verdict: AccessVerdict;
      try {
        verdict = await this.deps.mcp.ping(tokens.accessToken);
      } catch (err) {
        if (err instanceof TactiqUnauthorizedError) {
          await this.repo.recordCheck(email, 'unauthorized', now);
          return 'kept' as const;
        }
        return this.recheckTransient(link.id, email, now, err);
      }
      if (verdict.kind !== 'ready') {
        await this.repo.recordCheck(email, verdict.kind, now);
        return 'kept' as const;
      }
      const refreshScope = sanitizeScopeList(tokens.scope)?.join(' ');
      const hasDetails = effectiveScopeHasDetails({
        refreshScope,
        lastLinkScope: await this.repo.lastLinkScope(email),
        frozen: this.deps.consentScopeFrozen ?? CONSENT_SCOPE_FROZEN,
      });
      if (!hasDetails) {
        await this.repo.recordCheck(email, 'scope_without_details', now);
        // `ready` sem `details` com o escopo congelado: o assento chegou, a autorização antiga não cresce (D0.b, F5).
        if (this.deps.consentScopeFrozen ?? CONSENT_SCOPE_FROZEN) await this.noticeSeatArrivedFromRecheck(email);
        return 'kept' as const;
      }
      if (!(await this.repo.reactivate(link.id, now))) return 'kept' as const;
      await this.repo.appendEvent({
        email, kind: 'tactiq_link.reactivated', outcome: 'linked', at: now, ref: { from: link.status, ...(refreshScope ? { scope: refreshScope } : {}) },
      });
      this.log.info({ linkId: link.id, from: link.status }, 'admission.tactiq_link.reactivated');
      return 'reactivated' as const;
    });
    return locked.acquired ? locked.value : 'busy';
  }

  /** Rede, 5xx, KMS: não prova nada; registra e tenta amanhã. */
  private async recheckTransient(linkId: string, email: string, now: Date, err: unknown): Promise<'transient'> {
    await this.repo.recordCheck(email, 'transient_error', now);
    this.log.warn({ linkId, reason: (err as { reason?: string })?.reason ?? 'unexpected' }, 'admission.tactiq_link.recheck_transient');
    return 'transient';
  }

  /** Operadora sem linha: o relógio das 48 h nasce AQUI (1ª vez que o sistema a viu sem vínculo), não na criação do roster. */
  private async ensureMissingEvent(email: string): Promise<void> {
    if (await this.repo.firstEventAt(email, 'tactiq_link.missing')) return;
    await this.repo.appendEvent({ email, kind: 'tactiq_link.missing', outcome: 'missing', at: this.now() });
  }

  /**
   * P7: UM aviso por transição. "Já avisei" mora na linha (`last_notified_status`) — ou, para quem nunca teve linha,
   * na trilha (`tactiq_link.notified` com `reason='missing'`). O claim e o INSERT do sino vão na MESMA transação: quem
   * perde a corrida (dois jobs) não avisa, e uma falha ao gravar o sino desfaz o carimbo.
   */
  private async noticeOnTransition(email: string, state: NoticeState, knownUid: string | null = null): Promise<boolean> {
    const uid = knownUid ?? (await this.repo.activeUserUidByEmail(email));
    if (!uid) return false; // sem usuário não há sino; NÃO carimba (quando o usuário existir, avisa). O alarme das 48 h cobre.
    const hasRow = (await this.repo.findByEmail(email)) !== null;
    const seat = state === 'broken' ? await this.seatCauseOf(email) : null;
    const reason = seat ? 'seat_missing' : noticeReason(state);
    const now = this.now();
    return withActorContext(this.db, async (cli) => {
      const claimed = hasRow ? await this.repo.claimNotification(email, reason, cli) : await this.repo.claimMissingNotification(email, cli);
      if (!claimed) return false;
      if (seat) {
        // A cópia do Master primeiro (o host só diz "já avisamos" se avisamos); o host que é Master só recebe a dele.
        const adminNotified = await this.noticeMastersOfSeat(cli, {
          email, hostUid: uid, autoReactivates: seat.autoReactivates, now, source: 'daily_check',
        });
        await this.publisher.publishAdmissionTactiqLinkRequired(cli, {
          recipientUid: uid, reason, audience: 'host', adminNotified, autoReactivates: seat.autoReactivates,
        });
      } else {
        await this.publisher.publishAdmissionTactiqLinkRequired(cli, { recipientUid: uid, reason });
      }
      await this.repo.appendEvent({ email, kind: 'tactiq_link.notified', outcome: 'sent', reason, at: now }, cli);
      return true;
    });
  }

  /** A queda MAIS NOVA foi por assento (D9)? Devolve o `autoReactivates` do host (D13), ou `null` quando não é assento. */
  private async seatCauseOf(email: string): Promise<{ autoReactivates: boolean } | null> {
    const lastDegrade = await this.repo.lastDegrade(email);
    if (!isSeatCause(lastDegrade?.reason)) return null;
    return { autoReactivates: this.seatAutoReactivates('broken', lastDegrade, await this.repo.lastLinkScope(email)) };
  }

  private async alarmIfStale(
    hostId: string,
    email: string,
    state: NoticeState,
    row: { missing_since: Date | null; status_changed_at: Date } | null,
  ): Promise<boolean> {
    const since = row ? (row.missing_since ?? row.status_changed_at) : await this.repo.firstEventAt(email, 'tactiq_link.missing');
    if (!since) return false;
    const hours = (this.now().getTime() - since.getTime()) / 3_600_000;
    if (!(hours > MISSING_ALARM_HOURS)) return false;
    // Sinal de ESTADO: uma linha por operadora por execução enquanto durar (molde `pt-contact-reminders/health`). Sem e-mail nem nome.
    this.log.warn({ hostId, state, hoursWithoutLink: Math.floor(hours) }, 'admission.tactiq_link.missing_48h');
    return true;
  }
}
