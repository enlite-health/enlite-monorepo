/**
 * Diretório de pessoas da aba "Vínculos de área" — a população e a ordem (T1, decisão 5).
 *
 * População = staff ativo (`users`) ∪ prestador ativo com `auth_uid` real (`workers`) ∪ pessoa com vínculo vivo.
 * Agrupa por PESSOA RAIZ (`iam.person_root(iam.resolve_person(...))`); quem não tem pessoa agrupa pelo uid. `kind`:
 * staff > worker > account. Ordem: pessoa `created_at DESC` (nome é cifrado). Só funções `iam.*` (580/581), exceto
 * leitura de `iam.person.created_at` e `iam.area_membership` (SELECT é o privilégio de tabela do runtime, 581).
 *
 * Nenhum valor do usuário é interpolado no SQL e nada aqui loga.
 */
import type { Pool } from 'pg';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { SYNTHETIC_AUTH_UID_PREFIXES } from '../../../infrastructure/services/WorkerPhoneMergeTypes';
import type {
  PeopleDirectoryReader,
  PeopleRowsQuery,
  PersonKind,
  PersonMembership,
  PersonRow,
} from '../application/AreaPeople';

interface DirectoryRow {
  root: string | null;
  uid: string;
  kind: PersonKind;
  email: string | null;
  display_name: string | null;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  phone: string | null;
  created_at: Date;
  total: string;
}

const KIND_OF_PRIO: Record<number, PersonKind> = { 1: 'staff', 2: 'worker', 3: 'account' };

/** `hit` por fonte: a busca só filtra DEPOIS de agrupar (pessoa staff+prestador casa por qualquer das duas fichas). */
function hitSql(search: PeopleRowsQuery['search']): { staff: string; worker: string } {
  switch (search.kind) {
    case 'email':
      return { staff: 'u.email ILIKE $2', worker: 'w.email ILIKE $2' };
    case 'phone':
      return { staff: 'false', worker: 'w.phone ILIKE $2' };
    case 'name':
      // staff: o nome está em claro e a conferência fina é em memória; prestador: blind index (superset).
      return { staff: 'true', worker: 'w.name_trgm_bidx @> $2::bytea[]' };
    default:
      return { staff: 'true', worker: 'true' };
  }
}

export function buildPeopleSql(query: PeopleRowsQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [[...SYNTHETIC_AUTH_UID_PREFIXES]];
  if (query.search.kind === 'email' || query.search.kind === 'phone') params.push(query.search.like);
  if (query.search.kind === 'name') params.push(query.search.bidxLiteral);
  const hit = hitSql(query.search);
  const searching = query.search.kind !== 'none';

  // account: só entra na lista sem busca (sem nome/e-mail no banco, só o Firebase os conhece).
  const accountRows = searching
    ? ''
    : `UNION ALL
       SELECT l.root, a.uid, 3, (SELECT p.created_at FROM iam.person p WHERE p.id = l.root),
              NULL, NULL, NULL, NULL, NULL, false
         FROM live l
         CROSS JOIN LATERAL (SELECT x AS uid FROM iam.person_login_uids(l.root) AS x LIMIT 1) a
        WHERE NOT EXISTS (SELECT 1 FROM keyed k WHERE k.root = l.root)`;

  const where: string[] = [];
  if (searching) where.push('e.any_hit');
  if (query.type !== 'all') {
    params.push(query.type === 'staff' ? 1 : query.type === 'worker' ? 2 : 3);
    where.push(`e.prio = $${params.length}`);
  }
  if (query.withMembership !== undefined) {
    where.push(`${query.withMembership ? '' : 'NOT '}(e.root IS NOT NULL AND e.root IN (SELECT root FROM live))`);
  }

  let tail: string;
  if (query.mode.kind === 'page') {
    params.push(query.mode.limit, query.mode.offset);
    tail = `ORDER BY e.created_at DESC, e.ek LIMIT $${params.length - 1} OFFSET $${params.length}`;
  } else {
    params.push(query.mode.limit);
    tail = `ORDER BY e.prio, e.created_at DESC, e.ek LIMIT $${params.length}`;
  }

  const sql = `
    WITH src AS (
      SELECT u.firebase_uid AS uid, 1 AS prio, u.created_at, u.email, u.display_name,
             NULL::text AS first_name_encrypted, NULL::text AS last_name_encrypted, NULL::text AS phone,
             ${hit.staff} AS hit
        FROM users u
       WHERE u.account_type = 'staff' AND u.is_active = true AND u.firebase_uid IS NOT NULL
      UNION ALL
      SELECT w.auth_uid, 2, w.created_at, w.email, NULL::text, w.first_name_encrypted, w.last_name_encrypted, w.phone,
             ${hit.worker}
        FROM workers w
       WHERE w.auth_uid IS NOT NULL AND w.merged_into_id IS NULL AND ${excludeDisabledWorkersSql('w')}
         AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS p WHERE starts_with(w.auth_uid, p))
    ),
    keyed AS (
      SELECT s.*, iam.person_root(iam.resolve_person('firebase', s.uid)) AS root FROM src s
    ),
    live AS (
      SELECT DISTINCT iam.person_root(am.person_id) AS root
        FROM iam.area_membership am WHERE am.revoked_at IS NULL
    ),
    rows AS (
      SELECT k.root, k.uid, k.prio, k.created_at, k.email, k.display_name, k.first_name_encrypted,
             k.last_name_encrypted, k.phone, k.hit
        FROM keyed k
      ${accountRows}
    ),
    ents AS (
      SELECT COALESCE(r.root::text, 'uid:' || r.uid) AS ek,
             r.root,
             min(r.prio) AS prio,
             (array_agg(r.uid ORDER BY r.prio, r.uid))[1] AS uid,
             COALESCE((SELECT p.created_at FROM iam.person p WHERE p.id = r.root), min(r.created_at)) AS created_at,
             (array_agg(r.email ORDER BY r.prio) FILTER (WHERE r.email IS NOT NULL))[1] AS email,
             (array_agg(r.display_name ORDER BY r.prio) FILTER (WHERE r.display_name IS NOT NULL))[1] AS display_name,
             (array_agg(r.first_name_encrypted ORDER BY r.prio) FILTER (WHERE r.first_name_encrypted IS NOT NULL))[1] AS first_name_encrypted,
             (array_agg(r.last_name_encrypted ORDER BY r.prio) FILTER (WHERE r.last_name_encrypted IS NOT NULL))[1] AS last_name_encrypted,
             (array_agg(r.phone ORDER BY r.prio) FILTER (WHERE r.phone IS NOT NULL))[1] AS phone,
             bool_or(r.hit) AS any_hit
        FROM rows r
       GROUP BY COALESCE(r.root::text, 'uid:' || r.uid), r.root
    )
    SELECT e.root, e.uid, e.prio AS kind, e.created_at, e.email, e.display_name, e.first_name_encrypted,
           e.last_name_encrypted, e.phone, COUNT(*) OVER () AS total
      FROM ents e
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ${tail}`;
  return { sql, params };
}

export class PgPeopleDirectoryRepository implements PeopleDirectoryReader {
  constructor(private readonly pool: Pool) {}

  async rows(query: PeopleRowsQuery): Promise<{ rows: PersonRow[]; total: number }> {
    const { sql, params } = buildPeopleSql(query);
    const result = await this.pool.query<Omit<DirectoryRow, 'kind'> & { kind: number }>(sql, params);
    const rows = result.rows.map((r) => ({
      personId: r.root,
      uid: r.uid,
      kind: KIND_OF_PRIO[r.kind],
      email: r.email,
      displayName: r.display_name,
      firstNameEncrypted: r.first_name_encrypted,
      lastNameEncrypted: r.last_name_encrypted,
      phone: r.phone,
      createdAt: r.created_at,
    }));
    return { rows, total: parseInt(result.rows[0]?.total ?? '0', 10) };
  }

  async describeLogin(uid: string): Promise<{ personId: string | null; kind: PersonKind }> {
    const result = await this.pool.query<{ root: string | null; is_staff: boolean; is_worker: boolean }>(
      `WITH me AS (SELECT iam.person_root(iam.resolve_person('firebase', $1)) AS root),
            uids AS (
              SELECT $1::text AS uid
              UNION SELECT iam.person_login_uids(me.root) FROM me WHERE me.root IS NOT NULL
            )
       SELECT (SELECT root FROM me) AS root,
              EXISTS (SELECT 1 FROM users u JOIN uids ON uids.uid = u.firebase_uid
                       WHERE u.account_type = 'staff' AND u.is_active = true) AS is_staff,
              EXISTS (SELECT 1 FROM workers w JOIN uids ON uids.uid = w.auth_uid
                       WHERE w.merged_into_id IS NULL AND ${excludeDisabledWorkersSql('w')}) AS is_worker`,
      [uid],
    );
    const r = result.rows[0];
    return { personId: r?.root ?? null, kind: r?.is_staff ? 'staff' : r?.is_worker ? 'worker' : 'account' };
  }

  async membershipsOf(personIds: string[]): Promise<Map<string, PersonMembership[]>> {
    const byPerson = new Map<string, PersonMembership[]>();
    if (personIds.length === 0) return byPerson;
    const result = await this.pool.query<{ root: string; id: string; area: string; role: string }>(
      `SELECT iam.person_root(am.person_id) AS root, am.id, am.area, am.role
         FROM iam.area_membership am
        WHERE am.revoked_at IS NULL AND iam.person_root(am.person_id) = ANY($1::uuid[])
        ORDER BY am.area, am.role, am.granted_at`,
      [personIds],
    );
    for (const r of result.rows) {
      const list = byPerson.get(r.root) ?? [];
      list.push({ id: r.id, area: r.area, role: r.role });
      byPerson.set(r.root, list);
    }
    return byPerson;
  }
}
