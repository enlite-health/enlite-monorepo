import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { escapeIlikeWildcards } from '@shared/utils/ilikeEscape';
import type { AdmissionCountry } from '../domain/admissionCountries';

type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** Fluxo que lê o roster: cada um tem o seu interruptor (spec 055, R3). */
export type InterviewFlow = 'enquadre' | 'admission';
/** Coluna do interruptor por fluxo — constante nossa (nunca entrada de usuário), por isso entra no SQL por interpolação. */
const FLOW_COLUMN: Record<InterviewFlow, string> = { enquadre: 'does_enquadre', admission: 'does_admission' };

/**
 * Quem pode ser lido como entrevistador: a linha tem de apontar para um usuário staff ATIVO (JOIN, nunca LEFT JOIN — linha sem usuário,
 * ou com usuário desativado, não entra no agendamento: R1/R2 da spec 055).
 */
const ELIGIBLE_JOIN = `JOIN users u ON u.firebase_uid = h.user_uid AND u.account_type = 'staff' AND u.is_active = true`;

/**
 * InterviewHostRepository — quem atende entrevista (enquadre e admissão), por país e por fluxo.
 *
 * A tabela `interview_hosts` (migration 252; 523 = tela Entrevistadores) guarda identidade + países + um interruptor por fluxo +
 * o usuário dono da linha; a DISPONIBILIDADE não mora aqui, é lida da agenda Google de cada pessoa em tempo de consulta. Por isso
 * ligar/desligar vale na consulta seguinte, sem deploy.
 *
 * `display_name` existe para a operação saber de quem é a linha; **não vai para
 * o paciente** em lugar nenhum (nem no evento, nem na confirmação): quem o
 * paciente vê é sempre o nome genérico da equipe do país.
 */
export interface InterviewHost {
  email: string;
  displayName: string | null;
}

/** `InterviewHost` + o id da linha (UUID estável): o evento de enquadre (spec 052) identifica a entrevistadora por ele, nunca pelo e-mail. */
export interface InterviewHostWithId extends InterviewHost {
  id: string;
}

interface InterviewHostRow {
  email: string;
  display_name: string | null;
}

/** Linha da tela Entrevistadores (leitura admin). */
export interface InterviewHostAdminRow {
  id: string;
  email: string;
  displayName: string | null;
  countries: string[];
  doesEnquadre: boolean;
  doesAdmission: boolean;
  userUid: string | null;
  /** Sem usuário no sistema (`user_uid` NULL ou apontando para nada): fora do roster, só dá para "Quitar". */
  userMissing: boolean;
  /** Existe o usuário, mas está desativado (ou não é staff): fora do roster dos dois fluxos. */
  userInactive: boolean;
}

/** Linha crua de `interview_hosts` para as escritas. */
export interface InterviewHostRecord {
  id: string;
  email: string;
  userUid: string | null;
  countries: string[];
  doesEnquadre: boolean;
  doesAdmission: boolean;
  active: boolean;
}

export interface StaffCandidate {
  uid: string;
  displayName: string | null;
  email: string;
}

export interface InterviewHostWrite {
  countries: string[];
  doesEnquadre: boolean;
  doesAdmission: boolean;
  active: boolean;
  updatedBy: string;
}

interface RecordRow {
  id: string;
  email: string;
  user_uid: string | null;
  countries: string[];
  does_enquadre: boolean;
  does_admission: boolean;
  active: boolean;
}

const toRecord = (r: RecordRow): InterviewHostRecord => ({
  id: r.id,
  email: r.email,
  userUid: r.user_uid,
  countries: r.countries,
  doesEnquadre: r.does_enquadre,
  doesAdmission: r.does_admission,
  active: r.active,
});

export class InterviewHostRepository {
  /**
   * Atendentes ATIVAS do país e do fluxo, com usuário staff ativo, em ordem de e-mail ascendente — a ordem é parte
   * do contrato: é o desempate determinístico da atribuição (D5), então não pode depender da ordem física das linhas.
   */
  async listActiveByCountry(country: AdmissionCountry, flow: InterviewFlow): Promise<InterviewHost[]> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<InterviewHostRow>(
      `SELECT h.email, h.display_name
         FROM interview_hosts h
         ${ELIGIBLE_JOIN}
        WHERE $1 = ANY(h.countries) AND h.active = true AND h.${FLOW_COLUMN[flow]} = true
        ORDER BY h.email ASC`,
      [country],
    );
    return res.rows.map((r) => ({ email: r.email, displayName: r.display_name }));
  }

  /** Mesma lista e mesma ordem de `listActiveByCountry`, com o `id` da linha. */
  async listActiveWithIdByCountry(country: AdmissionCountry, flow: InterviewFlow): Promise<InterviewHostWithId[]> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<InterviewHostRow & { id: string }>(
      `SELECT h.id, h.email, h.display_name
         FROM interview_hosts h
         ${ELIGIBLE_JOIN}
        WHERE $1 = ANY(h.countries) AND h.active = true AND h.${FLOW_COLUMN[flow]} = true
        ORDER BY h.email ASC`,
      [country],
    );
    return res.rows.map((r) => ({ id: r.id, email: r.email, displayName: r.display_name }));
  }

  // ── tela Entrevistadores (spec 055) ─────────────────────────────────────────────────────────────────

  /** Linhas ATIVAS para a tela. LEFT JOIN de propósito: a linha sem usuário aparece (marcada) para a operação poder "Quitar". */
  async listAdmin(ex: Db = DatabaseConnection.getInstance().getPool()): Promise<InterviewHostAdminRow[]> {
    const res = await ex.query<RecordRow & { display_name: string | null; u_name: string | null; u_uid: string | null; u_ok: boolean | null }>(
      `SELECT h.id, h.email, h.user_uid, h.countries, h.does_enquadre, h.does_admission, h.active, h.display_name,
              u.display_name AS u_name, u.firebase_uid AS u_uid,
              (u.account_type = 'staff' AND u.is_active = true) AS u_ok
         FROM interview_hosts h
         LEFT JOIN users u ON u.firebase_uid = h.user_uid
        WHERE h.active = true
        ORDER BY lower(coalesce(u.display_name, h.display_name, h.email)), h.email`,
    );
    return res.rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.u_name ?? r.display_name,
      countries: r.countries,
      doesEnquadre: r.does_enquadre,
      doesAdmission: r.does_admission,
      userUid: r.user_uid,
      userMissing: r.u_uid === null,
      userInactive: r.u_uid !== null && r.u_ok !== true,
    }));
  }

  /** Staff ATIVO que casa com `q` (nome ou e-mail), sem quem já está na lista ativa. Máx. 20. */
  async searchCandidates(q: string, ex: Db = DatabaseConnection.getInstance().getPool()): Promise<StaffCandidate[]> {
    const like = `%${escapeIlikeWildcards(q)}%`;
    const res = await ex.query<{ firebase_uid: string; display_name: string | null; email: string }>(
      `SELECT u.firebase_uid, u.display_name, u.email
         FROM users u
        WHERE u.account_type = 'staff' AND u.is_active = true
          AND (u.display_name ILIKE $1 ESCAPE '\\' OR u.email ILIKE $1 ESCAPE '\\')
          AND NOT EXISTS (SELECT 1 FROM interview_hosts h WHERE h.user_uid = u.firebase_uid AND h.active = true)
        ORDER BY u.display_name, u.firebase_uid
        LIMIT 20`,
      [like],
    );
    return res.rows.map((r) => ({ uid: r.firebase_uid, displayName: r.display_name, email: r.email }));
  }

  /** Usuário staff ativo (R1) — `null` = inexistente, desativado ou não-staff (worker). */
  async findEligibleUser(uid: string, ex: Db): Promise<StaffCandidate | null> {
    const res = await ex.query<{ firebase_uid: string; display_name: string | null; email: string }>(
      `SELECT firebase_uid, display_name, email FROM users WHERE firebase_uid = $1 AND account_type = 'staff' AND is_active = true`,
      [uid],
    );
    const r = res.rows[0];
    return r ? { uid: r.firebase_uid, displayName: r.display_name, email: r.email } : null;
  }

  async findById(id: string, ex: Db): Promise<InterviewHostRecord | null> {
    const res = await ex.query<RecordRow>(
      `SELECT id, email, user_uid, countries, does_enquadre, does_admission, active FROM interview_hosts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  /** A linha da pessoa, ativa ou não: por usuário OU por e-mail (UNIQUE(email) pré-existente, ex.: linha de antes da tela). */
  async findByUserOrEmail(uid: string, email: string, ex: Db): Promise<InterviewHostRecord | null> {
    const res = await ex.query<RecordRow>(
      `SELECT id, email, user_uid, countries, does_enquadre, does_admission, active
         FROM interview_hosts WHERE user_uid = $1 OR lower(email) = lower($2) ORDER BY (user_uid = $1) DESC NULLS LAST LIMIT 1 FOR UPDATE`,
      [uid, email],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  /** Linha nova. `country` (NOT NULL, legado) recebe o 1º país da lista. */
  async insert(user: StaffCandidate, w: InterviewHostWrite, ex: Db): Promise<string> {
    const res = await ex.query<{ id: string }>(
      `INSERT INTO interview_hosts (email, display_name, country, countries, user_uid, does_enquadre, does_admission, active, updated_at, updated_by)
       VALUES (lower($1), $2, $3, $4, $5, $6, $7, $8, NOW(), $9) RETURNING id`,
      [user.email, user.displayName, w.countries[0], w.countries, user.uid, w.doesEnquadre, w.doesAdmission, w.active, w.updatedBy],
    );
    return res.rows[0].id;
  }

  /** Atualiza a linha; com `user`, copia e-mail e nome do usuário (cadastro/reativação). `country` = 1º país da lista. */
  async update(id: string, w: InterviewHostWrite, ex: Db, user?: StaffCandidate): Promise<void> {
    await ex.query(
      `UPDATE interview_hosts
          SET countries = $2, country = $3, does_enquadre = $4, does_admission = $5, active = $6,
              updated_at = NOW(), updated_by = $7,
              user_uid = COALESCE($8, user_uid), email = COALESCE(lower($9), email), display_name = COALESCE($10, display_name)
        WHERE id = $1`,
      [id, w.countries, w.countries[0], w.doesEnquadre, w.doesAdmission, w.active, w.updatedBy, user?.uid ?? null, user?.email ?? null, user?.displayName ?? null],
    );
  }
}

export const interviewHostRepository = new InterviewHostRepository();
