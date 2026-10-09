import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { TactiqLinkRepository } from '../infrastructure/TactiqLinkRepository';
import { hashState, newOAuthState, newPkcePair } from '../infrastructure/tactiq/pkce';
import {
  TactiqInvalidGrantError,
  TactiqUnauthorizedError,
  type TactiqLinkGate,
  type TactiqLinkState,
  type TactiqMcpPort,
  type TactiqOAuthPort,
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

export const STATE_TTL_MS = 10 * 60 * 1000;
/** Operadora do roster sem vínculo vivo há MAIS de 48 h (estritamente maior) → alarme ao gestor. */
export const MISSING_ALARM_HOURS = 48;

export interface OwnLinkView {
  status: TactiqLinkState;
  linkedAt: string | null;
  lastCheckAt: string | null;
  statusChangedAt: string | null;
}

export interface TactiqCheckSummary {
  rosterHosts: number;
  pinged: number;
  ok: number;
  broken: number;
  transient: number;
  notified: number;
  alarms: number;
}

interface Cipher {
  encrypt(plain: string): Promise<string | null>;
  decrypt(cipher: string): Promise<string>;
}

export interface TactiqLinkServiceDeps {
  repo: TactiqLinkRepository;
  oauth: TactiqOAuthPort;
  mcp: TactiqMcpPort;
  cipher?: Cipher;
  publisher?: SystemNotificationPublisher;
  db?: Pool;
  clientId?: () => string | null;
  log?: AdmissionLogger;
  now?: () => Date;
}

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
export class TactiqLinkService implements TactiqLinkGate {
  private readonly repo: TactiqLinkRepository;
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
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
    this.now = deps.now ?? (() => new Date());
  }

  // ── a trava ────────────────────────────────────────────────────────────────────────────────────────
  async statesFor(emails: string[]): Promise<Map<string, TactiqLinkState>> {
    const persisted = await this.repo.statusesByEmail(emails);
    return new Map(emails.map((e) => [e.toLowerCase(), persisted.get(e.toLowerCase()) ?? 'missing'] as const));
  }

  // ── o PRÓPRIO vínculo ──────────────────────────────────────────────────────────────────────────────
  async getOwn(email: string): Promise<OwnLinkView> {
    const row = await this.repo.findByEmail(email);
    if (!row) return { status: 'missing', linkedAt: null, lastCheckAt: null, statusChangedAt: null };
    return {
      status: row.status,
      linkedAt: row.linked_at ? row.linked_at.toISOString() : null,
      lastCheckAt: row.last_check_at ? row.last_check_at.toISOString() : null,
      statusChangedAt: row.status_changed_at.toISOString(),
    };
  }

  async startLink(input: { uid: string; email: string }): Promise<{ authorizeUrl: string }> {
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
    try {
      const verifier = await this.cipher.decrypt(consumed.verifierEncrypted);
      ({ refreshToken } = await this.deps.oauth.exchangeCode({ code: input.code, codeVerifier: verifier }));
    } catch (err) {
      const reason = err instanceof TactiqInvalidGrantError ? 'invalid_grant' : 'exchange_error';
      this.log.warn({ reason }, 'admission.tactiq_link.exchange_failed');
      throw new TactiqExchangeFailedError(reason);
    }

    const tokenEncrypted = await this.cipher.encrypt(refreshToken);
    if (!tokenEncrypted) throw new TactiqExchangeFailedError('empty_token');
    await this.repo.upsertLinked({
      email: consumed.email,
      uid: consumed.uid,
      tokenEncrypted,
      clientId: this.deps.clientId?.() ?? null,
      now,
    });
    await this.repo.appendEvent({ email: consumed.email, kind: 'tactiq_link.linked', outcome: 'linked', at: now });
    this.log.info({}, 'admission.tactiq_link.linked');
    return { email: consumed.email };
  }

  /** Autoverificação de conta (passo 5, chamada pela importação da F6): a conta vinculada não enxerga a reunião com o código. */
  async markWrongAccount(email: string): Promise<boolean> {
    const now = this.now();
    const changed = await this.repo.degrade(email, 'wrong_account', 'meeting_not_visible', now);
    if (!changed) return false;
    await this.repo.appendEvent({ email, kind: 'tactiq_link.wrong_account', outcome: 'wrong_account', reason: 'meeting_not_visible', at: now });
    await this.noticeOnTransition(email, 'wrong_account');
    return true;
  }

  // ── o teste diário ─────────────────────────────────────────────────────────────────────────────────
  async runDailyCheck(): Promise<TactiqCheckSummary> {
    const summary: TactiqCheckSummary = { rosterHosts: 0, pinged: 0, ok: 0, broken: 0, transient: 0, notified: 0, alarms: 0 };

    for (const link of await this.repo.listLinkedWithToken()) {
      summary.pinged += 1;
      const verdict = await this.checkOne(link);
      summary[verdict] += 1;
    }

    const roster = await this.repo.listActiveRoster();
    summary.rosterHosts = roster.length;
    for (const host of roster) {
      const row = await this.repo.findByEmail(host.email);
      if (!row) await this.ensureMissingEvent(host.email);
      const state: TactiqLinkState = row ? row.status : 'missing';
      if (state === 'linked') continue;

      if (await this.noticeOnTransition(host.email, state, row?.firebase_uid ?? null)) summary.notified += 1;
      if (await this.alarmIfStale(host.id, host.email, state, row)) summary.alarms += 1;
    }

    this.log.info({ ...summary }, 'admission.tactiq_link.check_done');
    return summary;
  }

  private async checkOne(link: { id: string; host_email: string; refresh_token_encrypted: string }): Promise<'ok' | 'broken' | 'transient'> {
    const now = this.now();
    try {
      const current = await this.cipher.decrypt(link.refresh_token_encrypted);
      const tokens = await this.deps.oauth.refresh(current);
      // Rotação: grava o refresh novo ANTES do ping — se o ping falhar, o token novo (o único válido) não se perde.
      if (tokens.refreshToken && tokens.refreshToken !== current) {
        const enc = await this.cipher.encrypt(tokens.refreshToken);
        if (enc) await this.repo.rotateToken(link.host_email, enc);
      }
      await this.deps.mcp.ping(tokens.accessToken);
      await this.repo.recordCheck(link.host_email, 'ok', now);
      return 'ok';
    } catch (err) {
      if (err instanceof TactiqInvalidGrantError || err instanceof TactiqUnauthorizedError) {
        const outcome = err instanceof TactiqInvalidGrantError ? 'invalid_grant' : 'unauthorized';
        if (await this.repo.degrade(link.host_email, 'broken', outcome, now)) {
          await this.repo.appendEvent({ email: link.host_email, kind: 'tactiq_link.broken', outcome: 'broken', reason: outcome, at: now });
        }
        this.log.warn({ linkId: link.id, outcome }, 'admission.tactiq_link.broken');
        return 'broken';
      }
      // Rede, 5xx, KMS: não prova vínculo quebrado. Registra e tenta amanhã (derrubar por soluço geraria aviso falso).
      await this.repo.recordCheck(link.host_email, 'transient_error', now);
      this.log.warn({ linkId: link.id, reason: (err as { reason?: string })?.reason ?? 'unexpected' }, 'admission.tactiq_link.check_transient');
      return 'transient';
    }
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
    const reason = noticeReason(state);
    const uid = knownUid ?? (await this.repo.activeUserUidByEmail(email));
    if (!uid) return false; // sem usuário não há sino; NÃO carimba (quando o usuário existir, avisa). O alarme das 48 h cobre.
    const hasRow = (await this.repo.findByEmail(email)) !== null;
    const now = this.now();
    return withActorContext(this.db, async (cli) => {
      const claimed = hasRow ? await this.repo.claimNotification(email, reason, cli) : await this.repo.claimMissingNotification(email, cli);
      if (!claimed) return false;
      await this.publisher.publishAdmissionTactiqLinkRequired(cli, { recipientUid: uid, reason });
      await this.repo.appendEvent({ email, kind: 'tactiq_link.notified', outcome: 'sent', reason, at: now }, cli);
      return true;
    });
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
