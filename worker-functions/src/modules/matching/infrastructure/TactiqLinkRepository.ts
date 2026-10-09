import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { TactiqLinkState } from '../application/ports/TactiqPorts';

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

  /** Rotação: o refresh token novo SUBSTITUI o antigo (grava sempre que o Tactiq devolver um). */
  async rotateToken(email: string, tokenEncrypted: string, ex: Db = this.db): Promise<void> {
    await ex.query(
      `UPDATE tactiq_link_secrets s SET refresh_token_encrypted = $2, updated_at = now()
         FROM tactiq_links l
        WHERE l.id = s.link_id AND lower(l.host_email) = lower($1) AND l.status = 'linked'`,
      [email, tokenEncrypted],
    );
  }

  async recordCheck(email: string, outcome: string, now: Date, ex: Db = this.db): Promise<void> {
    await ex.query(`UPDATE tactiq_links SET last_check_at = $2, last_check_outcome = $3 WHERE lower(host_email) = lower($1)`, [email, now, outcome]);
  }

  /** `linked → broken | wrong_account`. `true` só quando MUDOU de verdade (quem perde a corrida não repete o evento). */
  async degrade(email: string, to: 'broken' | 'wrong_account', outcome: string, now: Date, ex: Db = this.db): Promise<boolean> {
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
    event: { email: string; kind: string; outcome?: string | null; reason?: string | null; at: Date },
    ex: Db = this.db,
  ): Promise<void> {
    await ex.query(
      `INSERT INTO admission_events (host_email, kind, outcome, reason, at) VALUES (lower($1), $2, $3, $4, $5)`,
      [event.email, event.kind, event.outcome ?? null, event.reason ?? null, event.at],
    );
  }

  /** Quem NÃO tem linha: já avisei `missing`? (lock por e-mail serializa duas execuções simultâneas). */
  async claimMissingNotification(email: string, ex: Db): Promise<boolean> {
    await ex.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tactiq_missing:${email.toLowerCase()}`]);
    const { rows } = await ex.query(
      `SELECT 1 FROM admission_events WHERE kind = 'tactiq_link.notified' AND reason = 'missing' AND lower(host_email) = lower($1) LIMIT 1`,
      [email],
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
