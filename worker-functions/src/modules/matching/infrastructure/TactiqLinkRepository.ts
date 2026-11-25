import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { TactiqLinkState } from '../application/ports/TactiqPorts';
import type { LastDegrade } from '../domain/tactiqRecheck';
import { activeMasterUids } from './MasterRecipients';
import { SEAT_DECLARED_KIND, SEAT_UNDECLARED_KIND } from '../domain/tactiqSeatGate';

type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** Colunas de `tactiq_links` (o token vive em `tactiq_link_secrets`, que o `app_runtime` lê com 0 linhas — migration 505). */
const SAFE_COLUMNS = `id, host_email, firebase_uid, status, client_id, linked_at, last_check_at, last_check_outcome,
  status_changed_at, last_notified_status, missing_since`;

export interface TactiqLinkRow {
  id: string;
  host_email: string;
  firebase_uid: string;
  status: Exclude<TactiqLinkState, 'missing'>;
  client_id: string | null;
  linked_at: Date | null;
  last_check_at: Date | null;
  last_check_outcome: string | null;
  status_changed_at: Date;
  last_notified_status: string | null;
  missing_since: Date | null;
}

export interface RosterHost {
  id: string;
  email: string;
  country: string;
}

/**
 * TactiqLinkRepository — SQL do vínculo do Tactiq (`tactiq_links`, 505), do estado do OAuth (`tactiq_oauth_states`, 508)
 * e da trilha `tactiq_link.*` (`admission_events`, 504). O relógio entra por parâmetro (`now`): o teste injeta, o banco
 * não decide o "agora" do vínculo. O token cifrado só sai por `listLinkedWithToken` (papel de sistema, o job).
 */
export class TactiqLinkRepository {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  // ── leitura (sem token) ────────────────────────────────────────────────────────────────────────────
  async findByEmail(email: string, ex: Db = this.db): Promise<TactiqLinkRow | null> {
    const { rows } = await ex.query<TactiqLinkRow>(`SELECT ${SAFE_COLUMNS} FROM tactiq_links WHERE lower(host_email) = lower($1)`, [email]);
    return rows[0] ?? null;
  }

  /** e-mail minúsculo → estado persistido. Quem não aparece é `missing` (decisão do serviço). */
  async statusesByEmail(emails: string[], ex: Db = this.db): Promise<Map<string, Exclude<TactiqLinkState, 'missing'>>> {
    const lowered = emails.map((e) => e.toLowerCase());
    if (lowered.length === 0) return new Map();
    const { rows } = await ex.query<{ e: string; status: TactiqLinkRow['status'] }>(
      `SELECT lower(host_email) AS e, status FROM tactiq_links WHERE lower(host_email) = ANY($1::text[])`,
      [lowered],
    );
    return new Map(rows.map((r) => [r.e, r.status]));
  }

  /** `created_at` é do 1º vínculo: `upsertLinked` reaproveita a linha no revínculo e não o toca. */
  async linkCreatedAfter(email: string, at: Date, ex: Db = this.db): Promise<boolean> {
    const { rows } = await ex.query(
      `SELECT 1 FROM tactiq_links WHERE lower(host_email) = lower($1) AND created_at > $2::timestamptz LIMIT 1`,
      [email, at],
    );
    return rows.length > 0;
  }

  /** `status_changed_at` só anda quando o status não era `linked` (`upsertLinked`): refazer o vínculo depois de `broken`/`wrong_account` o move. */
  async hasLinkedSince(email: string, since: Date, ex: Db = this.db): Promise<boolean> {
    const { rows } = await ex.query(
      `SELECT 1 FROM tactiq_links WHERE lower(host_email) = lower($1) AND status = 'linked' AND status_changed_at > $2::timestamptz LIMIT 1`,
      [email, since],
    );
    return rows.length > 0;
  }

  async listActiveRoster(ex: Db = this.db): Promise<RosterHost[]> {
    const { rows } = await ex.query<RosterHost>(`SELECT id, email, country FROM interview_hosts WHERE active = true ORDER BY email`);
    return rows;
  }

  /** Dono ativo do e-mail: quem recebe o sino. `null` = operadora sem usuário (o alarme das 48 h cobre). */
  async activeUserUidByEmail(email: string, ex: Db = this.db): Promise<string | null> {
    const { rows } = await ex.query<{ firebase_uid: string }>(
      `SELECT firebase_uid FROM users WHERE lower(email) = lower($1) AND is_active IS TRUE ORDER BY created_at LIMIT 1`,
      [email],
    );
    return rows[0]?.firebase_uid ?? null;
  }

  // ── leitura COM token (só o job, em papel de sistema) ──────────────────────────────────────────────
  async listLinkedWithToken(ex: Db = this.db): Promise<Array<{ id: string; host_email: string; refresh_token_encrypted: string }>> {
    const { rows } = await ex.query<{ id: string; host_email: string; refresh_token_encrypted: string }>(
      `SELECT l.id, l.host_email, s.refresh_token_encrypted
         FROM tactiq_links l JOIN tactiq_link_secrets s ON s.link_id = l.id
        WHERE l.status = 'linked' ORDER BY l.host_email`,
    );
    return rows;
  }

  /** Token cifrado de UM vínculo vivo (`linked`). `null` = sem vínculo vivo. Só o job de importação, em papel de sistema. */
  async findLinkedTokenByEmail(email: string, ex: Db = this.db): Promise<{ id: string; refresh_token_encrypted: string } | null> {
    const { rows } = await ex.query<{ id: string; refresh_token_encrypted: string }>(
      `SELECT l.id, s.refresh_token_encrypted
         FROM tactiq_links l JOIN tactiq_link_secrets s ON s.link_id = l.id
        WHERE lower(l.host_email) = lower($1) AND l.status = 'linked'`,
      [email],
    );
    return rows[0] ?? null;
  }

  /**
   * Re-teste diário (F2): linhas `broken`/`wrong_account` com segredo + o evento de queda MAIS NOVO (`lastDegrade`, LATERAL). Quem decide se
   * re-testa é `isRecheckable` (domínio, dono do conceito); aqui só vai o que a decisão precisa. Os kinds vão por parâmetro (sql-schema-sync).
   */
  async listRecheckableWithToken(
    ex: Db = this.db,
  ): Promise<Array<{ id: string; host_email: string; status: string; refresh_token_encrypted: string; lastDegrade: LastDegrade | null }>> {
    const { rows } = await ex.query<{
      id: string; host_email: string; status: string; refresh_token_encrypted: string;
      last_kind: string | null; last_reason: string | null; last_source: string | null;
    }>(
      `SELECT l.id, l.host_email, l.status, s.refresh_token_encrypted,
              d.kind AS last_kind, d.reason AS last_reason, d.source AS last_source
         FROM tactiq_links l
         JOIN tactiq_link_secrets s ON s.link_id = l.id
         LEFT JOIN LATERAL (SELECT e.kind, e.reason, e.ref->>'source' AS source
                              FROM admission_events e
                             WHERE lower(e.host_email) = lower(l.host_email) AND e.kind = ANY($1::text[])
                             ORDER BY e.at DESC, e.id DESC LIMIT 1) d ON true
        WHERE l.status IN ('broken', 'wrong_account')
        ORDER BY l.host_email`,
      [['tactiq_link.broken', 'tactiq_link.wrong_account', 'tactiq_link.recheck_dead']],
    );
    return rows.map((r) => ({
      id: r.id,
      host_email: r.host_email,
      status: r.status,
      refresh_token_encrypted: r.refresh_token_encrypted,
      lastDegrade: r.last_kind ? { kind: r.last_kind, reason: r.last_reason, source: r.last_source } : null,
    }));
  }

  /**
   * `scope` do último vínculo/recusa por assento do e-mail: o evento MAIS NOVO entre `tactiq_link.linked` e `tactiq_link.broken` com
   * `source='link'` (F1). `null` = nenhum evento ou sem escopo gravado (legado: "não apurado").
   */
  async lastLinkScope(email: string, ex: Db = this.db): Promise<string | null> {
    const { rows } = await ex.query<{ scope: string | null }>(
      `SELECT e.ref->>'scope' AS scope FROM admission_events e
        WHERE lower(e.host_email) = lower($1) AND (e.kind = $2 OR (e.kind = $3 AND e.ref->>'source' = 'link'))
        ORDER BY e.at DESC, e.id DESC LIMIT 1`,
      [email, 'tactiq_link.linked', 'tactiq_link.broken'],
    );
    return rows[0]?.scope ?? null;
  }

  // ── escrita ────────────────────────────────────────────────────────────────────────────────────────
  /** Vincula (ou revincula): estado `linked`, token novo, "já avisei" zerado para `linked`. Nunca devolve o token. */
  async upsertLinked(
    input: { email: string; uid: string; tokenEncrypted: string; clientId: string | null; now: Date },
    ex: Db = this.db,
  ): Promise<void> {
    await ex.query(
      `WITH l AS (
         INSERT INTO tactiq_links (host_email, firebase_uid, status, client_id, linked_at, last_check_at,
                                   last_check_outcome, status_changed_at, last_notified_status, missing_since)
         VALUES ($1, $2, 'linked', $4, $5, $5, 'linked', $5, 'linked', NULL)
         ON CONFLICT (lower(host_email)) DO UPDATE SET
           firebase_uid = EXCLUDED.firebase_uid,
           status = 'linked',
           client_id = EXCLUDED.client_id,
           linked_at = EXCLUDED.linked_at,
           last_check_at = EXCLUDED.last_check_at,
           last_check_outcome = 'linked',
           status_changed_at = CASE WHEN tactiq_links.status <> 'linked' THEN EXCLUDED.status_changed_at ELSE tactiq_links.status_changed_at END,
           last_notified_status = 'linked',
           missing_since = NULL
         RETURNING id)
       INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted, updated_at)
       SELECT id, $3, $5 FROM l
       ON CONFLICT (link_id) DO UPDATE SET refresh_token_encrypted = EXCLUDED.refresh_token_encrypted, updated_at = EXCLUDED.updated_at`,
      [input.email.toLowerCase(), input.uid, input.tokenEncrypted, input.clientId, input.now],
    );
  }

  /**
   * Recusa por falta de assento (F1): guarda o token de quem NÃO ficou `linked`. Linha nova nasce `broken` (`unauthorized`,
   * `last_notified_status` NULL: o aviso por transição ainda vai disparar). Linha `linked` nunca é tocada. Linha `broken`/`wrong_account`
   * só tem o segredo trocado quando o ÚLTIMO evento de queda é `recheck_dead` ou `invalid_grant` (token morto); qualquer outra, intocada.
   * `true` só quando gravou (linha nova ou token substituído). O kind da trilha vai como parâmetro (sql-schema-sync lê literal como tabela.coluna).
   */
  async insertBrokenFromRejection(
    input: { email: string; uid: string; tokenEncrypted: string; clientId: string | null; now: Date },
    ex: Db = this.db,
  ): Promise<boolean> {
    const { rowCount } = await ex.query(
      `WITH ins AS (
         INSERT INTO tactiq_links (host_email, firebase_uid, status, client_id, linked_at, last_check_at,
                                   last_check_outcome, status_changed_at, last_notified_status, missing_since)
         VALUES ($1, $2, 'broken', $4, NULL, $5, 'unauthorized', $5, NULL, $5)
         ON CONFLICT (lower(host_email)) DO NOTHING
         RETURNING id),
       dead AS (
         SELECT l.id FROM tactiq_links l
          WHERE lower(l.host_email) = lower($1) AND l.status IN ('broken', 'wrong_account')
            AND EXISTS (SELECT 1 FROM (SELECT e.kind, e.reason FROM admission_events e
                                        WHERE lower(e.host_email) = lower($1) AND e.kind = ANY($6::text[])
                                        ORDER BY e.at DESC, e.id DESC LIMIT 1) d
                         WHERE d.kind = $7 OR d.reason = 'invalid_grant')),
       target AS (SELECT id FROM ins UNION ALL SELECT id FROM dead)
       INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted, updated_at)
       SELECT id, $3, $5 FROM target
       ON CONFLICT (link_id) DO UPDATE SET refresh_token_encrypted = EXCLUDED.refresh_token_encrypted, updated_at = EXCLUDED.updated_at`,
      [
        input.email.toLowerCase(), input.uid, input.tokenEncrypted, input.clientId, input.now,
        ['tactiq_link.broken', 'tactiq_link.wrong_account', 'tactiq_link.recheck_dead'], 'tactiq_link.recheck_dead',
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Rotação: o refresh token novo SUBSTITUI o antigo (grava sempre que o Tactiq devolver um). */
  async rotateToken(email: string, tokenEncrypted: string, ex: Db = this.db): Promise<void> {
    await ex.query(
      `UPDATE tactiq_link_secrets s SET refresh_token_encrypted = $2, updated_at = now()
         FROM tactiq_links l
        WHERE l.id = s.link_id AND lower(l.host_email) = lower($1) AND l.status = 'linked'`,
      [email, tokenEncrypted],
    );
  }

  /**
   * Rotação do re-teste (D6): compare-and-swap sobre o segredo lido. `false` = o segredo mudou no meio (revínculo concorrente, F23):
   * quem chama NÃO reativa. Não filtra por `linked`: a linha re-testada está `broken`/`wrong_account`.
   */
  async rotateTokenIfUnchanged(linkId: string, oldEncrypted: string, newEncrypted: string, ex: Db = this.db): Promise<boolean> {
    const { rowCount } = await ex.query(
      `UPDATE tactiq_link_secrets SET refresh_token_encrypted = $3, updated_at = now()
        WHERE link_id = $1 AND refresh_token_encrypted = $2`,
      [linkId, oldEncrypted, newEncrypted],
    );
    return (rowCount ?? 0) > 0;
  }

  /** `broken | wrong_account → linked` (D6). `status_changed_at` anda: reabre os itens bloqueados da 083 (F14). `true` só quando MUDOU. */
  async reactivate(linkId: string, now: Date, ex: Db = this.db): Promise<boolean> {
    const { rowCount } = await ex.query(
      `UPDATE tactiq_links
          SET status = 'linked', status_changed_at = $2, missing_since = NULL, last_check_at = $2,
              last_check_outcome = 'ok', last_notified_status = 'linked'
        WHERE id = $1 AND status IN ('broken', 'wrong_account')`,
      [linkId, now],
    );
    return (rowCount ?? 0) > 0;
  }

  async recordCheck(email: string, outcome: string, now: Date, ex: Db = this.db): Promise<void> {
    await ex.query(`UPDATE tactiq_links SET last_check_at = $2, last_check_outcome = $3 WHERE lower(host_email) = lower($1)`, [email, now, outcome]);
  }

  /** `linked → broken`. `true` só quando MUDOU de verdade (quem perde a corrida não repete o evento). */
  async degrade(email: string, to: 'broken', outcome: string, now: Date, ex: Db = this.db): Promise<boolean> {
    const { rowCount } = await ex.query(
      `UPDATE tactiq_links
          SET status = $2, status_changed_at = $3, missing_since = $3, last_check_at = $3, last_check_outcome = $4
        WHERE lower(host_email) = lower($1) AND status = 'linked'`,
      [email, to, now, outcome],
    );
    return (rowCount ?? 0) > 0;
  }

  /** O "já avisei" de quem TEM linha: só quem muda o valor ganha o aviso. */
  async claimNotification(email: string, reason: string, ex: Db): Promise<boolean> {
    const { rowCount } = await ex.query(
      `UPDATE tactiq_links SET last_notified_status = $2
        WHERE lower(host_email) = lower($1) AND last_notified_status IS DISTINCT FROM $2`,
      [email, reason],
    );
    return (rowCount ?? 0) > 0;
  }

  // ── trilha `tactiq_link.*` ─────────────────────────────────────────────────────────────────────────
  async appendEvent(
    event: { email: string; kind: string; outcome?: string | null; reason?: string | null; at: Date; ref?: Record<string, unknown> | null },
    ex: Db = this.db,
  ): Promise<void> {
    const ref = event.ref && Object.keys(event.ref).length > 0 ? JSON.stringify(event.ref) : null;
    await ex.query(
      `INSERT INTO admission_events (host_email, kind, outcome, reason, at, ref) VALUES (lower($1), $2, $3, $4, $5, $6::jsonb)`,
      [event.email, event.kind, event.outcome ?? null, event.reason ?? null, event.at, ref],
    );
  }

  /** A ÚLTIMA tentativa de vínculo na trilha (`linked`, `reactivated` do re-teste, `link_rejected` ou a queda `broken`); sem evento → `null`. */
  async latestLinkAttempt(
    email: string,
    ex: Db = this.db,
  ): Promise<{ kind: string; outcome: string | null; reason: string | null; ref: Record<string, unknown> | null; at: Date } | null> {
    const { rows } = await ex.query(
      `SELECT kind, outcome, reason, ref, at FROM admission_events
        WHERE lower(host_email) = lower($1) AND kind = ANY($2::text[])
        ORDER BY at DESC, id DESC LIMIT 1`,
      [email, ['tactiq_link.linked', 'tactiq_link.link_rejected', 'tactiq_link.reactivated', 'tactiq_link.broken']],
    );
    return rows[0] ?? null;
  }

  /** Quem NÃO tem linha: já avisei `missing`? (lock por e-mail serializa duas execuções simultâneas). */
  async claimMissingNotification(email: string, ex: Db): Promise<boolean> {
    await ex.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tactiq_missing:${email.toLowerCase()}`]);
    const { rows } = await ex.query(
      `SELECT 1 FROM admission_events WHERE kind = $2 AND reason = 'missing' AND lower(host_email) = lower($1) LIMIT 1`,
      // kind vai como parâmetro: o literal 'tactiq_link.notified' dentro do SQL é lido como tabela.coluna pelo sql-schema-sync.
      [email, 'tactiq_link.notified'],
    );
    return rows.length === 0;
  }

  async firstEventAt(email: string, kind: string, ex: Db = this.db): Promise<Date | null> {
    const { rows } = await ex.query<{ at: Date | null }>(
      `SELECT min(at) AS at FROM admission_events WHERE kind = $2 AND lower(host_email) = lower($1)`,
      [email, kind],
    );
    return rows[0]?.at ?? null;
  }

  // ── aviso ao Acesso Master (change tactiq-vinculo-resiliente, F3) ──────────────────────────────────
  /** Membros vivos do Acesso Master (D12): só leitura, a consulta mora em `MasterRecipients`. */
  activeMasterUids(ex: Db = this.db): Promise<string[]> {
    return activeMasterUids(ex);
  }

  /** Nome de FUNCIONÁRIO da operadora (`interview_hosts.display_name`); `null` = fora do roster ou sem nome. Nunca dado de paciente. */
  async hostDisplayName(email: string, ex: Db = this.db): Promise<string | null> {
    const { rows } = await ex.query<{ display_name: string | null }>(
      `SELECT display_name FROM interview_hosts WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    const name = rows[0]?.display_name?.trim();
    return name ? name : null;
  }

  /** A queda MAIS NOVA do e-mail (`broken`, `wrong_account` ou `recheck_dead`), com a origem; `null` = nenhuma. Os kinds vão por parâmetro (sql-schema-sync). */
  async lastDegrade(email: string, ex: Db = this.db): Promise<LastDegrade | null> {
    const { rows } = await ex.query<{ kind: string; reason: string | null; source: string | null }>(
      `SELECT e.kind, e.reason, e.ref->>'source' AS source
         FROM admission_events e
        WHERE lower(e.host_email) = lower($1) AND e.kind = ANY($2::text[])
        ORDER BY e.at DESC, e.id DESC LIMIT 1`,
      [email, ['tactiq_link.broken', 'tactiq_link.wrong_account', 'tactiq_link.recheck_dead']],
    );
    const r = rows[0];
    return r ? { kind: r.kind, reason: r.reason, source: r.source } : null;
  }

  /**
   * O Acesso Master já foi avisado neste EPISÓDIO de falta de assento? Episódio = desde o último `linked`/`reactivated`; "avisado" = o evento
   * `notified` `seat_missing_master` com `outcome='sent'` mais novo vem depois deles. `no_recipient` não conta (tenta de novo). Só leitura.
   */
  async seatEpisodeNotified(email: string, ex: Db = this.db): Promise<boolean> {
    const { rows } = await ex.query<{ kind: string }>(
      `SELECT e.kind FROM admission_events e
        WHERE lower(e.host_email) = lower($1)
          AND (e.kind = ANY($2::text[]) OR (e.kind = $3 AND e.reason = $4 AND e.outcome = $5))
        ORDER BY e.at DESC, e.id DESC LIMIT 1`,
      [email, ['tactiq_link.linked', 'tactiq_link.reactivated'], 'tactiq_link.notified', 'seat_missing_master', 'sent'],
    );
    return rows[0]?.kind === 'tactiq_link.notified';
  }

  /** "Já avisei" por episódio (D12): trava transacional por e-mail + a leitura do episódio (molde `claimMissingNotification`). `true` = pode avisar. */
  async claimSeatEpisode(email: string, ex: Db): Promise<boolean> {
    await ex.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tactiq_seat:${email.toLowerCase()}`]);
    return !(await this.seatEpisodeNotified(email, ex));
  }

  // ── licença antes do 1º vínculo (change tactiq-vinculo-resiliente, F5, D16) ─────────────────────────
  /** A licença está declarada? = o evento MAIS NOVO entre `seat_declared` e `seat_undeclared` é o `declared`. Dono: a trilha (nenhuma coluna). */
  async seatDeclared(email: string, ex: Db = this.db): Promise<boolean> {
    const { rows } = await ex.query<{ kind: string }>(
      `SELECT e.kind FROM admission_events e
        WHERE lower(e.host_email) = lower($1) AND e.kind = ANY($2::text[])
        ORDER BY e.at DESC, e.id DESC LIMIT 1`,
      [email, [SEAT_DECLARED_KIND, SEAT_UNDECLARED_KIND]],
    );
    return rows[0]?.kind === SEAT_DECLARED_KIND;
  }

  /** Quais e-mails (minúsculos) têm a licença declarada — a listagem de Entrevistadores lê DAQUI, nunca recalcula. */
  async seatDeclaredAmong(emails: string[], ex: Db = this.db): Promise<Set<string>> {
    const lowered = emails.map((e) => e.toLowerCase());
    if (lowered.length === 0) return new Set();
    const { rows } = await ex.query<{ mail: string; kind: string }>(
      `SELECT DISTINCT ON (lower(e.host_email)) lower(e.host_email) AS mail, e.kind
         FROM admission_events e
        WHERE lower(e.host_email) = ANY($1::text[]) AND e.kind = ANY($2::text[])
        ORDER BY lower(e.host_email), e.at DESC, e.id DESC`,
      [lowered, [SEAT_DECLARED_KIND, SEAT_UNDECLARED_KIND]],
    );
    return new Set(rows.filter((r) => r.kind === SEAT_DECLARED_KIND).map((r) => r.mail));
  }

  /** Trava transacional por (assunto, e-mail): serializa quem declara/avisa ao mesmo tempo. Dentro da transação do chamador. */
  async lockSeatTopic(topic: string, email: string, ex: Db): Promise<void> {
    await ex.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tactiq_${topic}:${email.toLowerCase()}`]);
  }

  /** "Já avisei" 1× por PESSOA (o `notified` `sent` com este `reason` já existe?). Chamar DEPOIS de `lockSeatTopic`. Só leitura. */
  async oneTimeNoticeSent(email: string, reason: string, ex: Db): Promise<boolean> {
    const { rows } = await ex.query(
      `SELECT 1 FROM admission_events WHERE lower(host_email) = lower($1) AND kind = $2 AND reason = $3 AND outcome = $4 LIMIT 1`,
      [email, 'tactiq_link.notified', reason, 'sent'],
    );
    return rows.length > 0;
  }

  /**
   * O assento já CHEGOU neste episódio? Episódio = desde o último `linked`/`reactivated`; "chegou" = o `seat_arrived` mais novo vem depois deles.
   * Chamar DEPOIS de `lockSeatTopic('seat_arrived', …)`. Os kinds vão por parâmetro (sql-schema-sync).
   */
  async seatArrivedInEpisode(email: string, ex: Db): Promise<boolean> {
    const { rows } = await ex.query<{ kind: string }>(
      `SELECT e.kind FROM admission_events e
        WHERE lower(e.host_email) = lower($1) AND e.kind = ANY($2::text[])
        ORDER BY e.at DESC, e.id DESC LIMIT 1`,
      [email, ['tactiq_link.linked', 'tactiq_link.reactivated', 'tactiq_link.seat_arrived']],
    );
    return rows[0]?.kind === 'tactiq_link.seat_arrived';
  }

  // ── estado do OAuth (508) ──────────────────────────────────────────────────────────────────────────
  async insertOAuthState(
    input: { stateHash: string; uid: string; email: string; verifierEncrypted: string; expiresAt: Date; now: Date },
    ex: Db = this.db,
  ): Promise<void> {
    await ex.query(`DELETE FROM tactiq_oauth_states WHERE expires_at < $1::timestamptz - interval '1 day'`, [input.now]);
    await ex.query(
      `INSERT INTO tactiq_oauth_states (state_hash, firebase_uid, host_email, code_verifier_encrypted, expires_at, created_at)
       VALUES ($1, $2, lower($3), $4, $5, $6)`,
      [input.stateHash, input.uid, input.email, input.verifierEncrypted, input.expiresAt, input.now],
    );
  }

  /** USO ÚNICO e validade: o UPDATE condicional é a trava (state repetido, vencido ou inventado → `null`). */
  async consumeOAuthState(
    stateHash: string,
    now: Date,
    ex: Db = this.db,
  ): Promise<{ uid: string; email: string; verifierEncrypted: string } | null> {
    const { rows } = await ex.query<{ firebase_uid: string; host_email: string; code_verifier_encrypted: string }>(
      `UPDATE tactiq_oauth_states SET consumed_at = $2
        WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > $2
        RETURNING firebase_uid, host_email, code_verifier_encrypted`,
      [stateHash, now],
    );
    const r = rows[0];
    return r ? { uid: r.firebase_uid, email: r.host_email, verifierEncrypted: r.code_verifier_encrypted } : null;
  }
}
