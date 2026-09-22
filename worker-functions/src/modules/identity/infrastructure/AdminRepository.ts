import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { escapeIlikeWildcards } from '@shared/utils/ilikeEscape';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';

export interface AdminRecord {
  firebaseUid: string;
  email: string;
  displayName: string | null;
  role: string;
  department: string | null;
  lastLoginAt: string | null;
  loginCount: number;
  createdAt: string;
}

/**
 * Linha do diretório de staff (spec 022, `contracts/openapi-staff-directory.md`;
 * `isOnline` — change 022-ux-mencao-e-notificacao, Rodada 2/R2-B).
 * De propósito, SÓ `uid`/`displayName`/`isOnline` — nunca `email` nem `role` (D-06: o
 * autocomplete de menção não precisa e o payload vaza menos).
 */
export interface StaffDirectoryEntry {
  uid: string;
  displayName: string | null;
  isOnline: boolean;
}

export class AdminRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /**
   * Finds any staff member (`account_type = 'staff'`, D294) by Firebase UID.
   * All fields come from users (department, last_login_at, login_count since migration 134;
   * admins_extension removed in migration 135).
   */
  async findByFirebaseUid(uid: string): Promise<AdminRecord | null> {
    const result = await this.pool.query(
      `SELECT
        u.firebase_uid      AS "firebaseUid",
        u.email,
        u.display_name      AS "displayName",
        u.role,
        u.department,
        u.last_login_at     AS "lastLoginAt",
        COALESCE(u.login_count, 0) AS "loginCount",
        u.created_at        AS "createdAt"
      FROM users u
      WHERE u.firebase_uid = $1
        AND u.account_type = 'staff'`,
      [uid]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Lists all staff members (`account_type = 'staff'`) with pagination.
   */
  async listAdmins(limit = 50, offset = 0): Promise<{ admins: AdminRecord[]; total: number }> {
    const countResult = await this.pool.query(
      `SELECT COUNT(*) AS total FROM users
       WHERE account_type = 'staff' AND is_active = true`
    );

    const result = await this.pool.query(
      `SELECT
        u.firebase_uid      AS "firebaseUid",
        u.email,
        u.display_name      AS "displayName",
        u.role,
        u.department,
        u.last_login_at     AS "lastLoginAt",
        COALESCE(u.login_count, 0) AS "loginCount",
        u.created_at        AS "createdAt"
      FROM users u
      WHERE u.account_type = 'staff' AND u.is_active = true
      ORDER BY u.created_at DESC
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return { admins: result.rows, total: parseInt(countResult.rows[0].total) };
  }

  /**
   * Diretório de staff para o autocomplete de menção (`<@uid>`) do chat interno
   * (spec 022, T128). MESMO `WHERE` de "staff ativo" de `listAdmins` acima —
   * `account_type = 'staff' AND is_active = true` — para que inativo/prestador
   * nunca apareça na lista de menção. `ILIKE` em `display_name`/`email` (o
   * e-mail entra só como CRITÉRIO de busca — nunca sai na resposta), `LIMIT 20`.
   *
   * Achado do gate revisao-pr (Bloco 1): `%`/`_` são wildcards do ILIKE — sem escape,
   * `q='%'` (ou `q='%%'`) casava QUALQUER nome/e-mail e listava todo o staff. `escapeIlikeWildcards`
   * (molde: `IcdCatalogTerminology.buscar` / `AdminPatientsMapController`) neutraliza `\`, `%` e `_`
   * no VALOR; a cláusula fecha com `ESCAPE '\\'` — sem ela a barra que a função insere é lida como
   * caractere comum e o curinga volta a valer.
   * `ORDER BY u.display_name, u.firebase_uid` desempata nome repetido — sem isso, `LIMIT 20` corta
   * o mesmo conjunto de linhas empatadas em ordem instável entre chamadas (paginação/teste flaky).
   *
   * `q` AUSENTE/VAZIO (item 1 da change 022-ux-mencao-e-notificacao, revoga D-06): pula a
   * cláusula `ILIKE` inteira — não roda `ILIKE '%%'` (que casaria tudo do mesmo jeito, mas força o
   * planner a escanear via `ILIKE` em vez de poder usar um índice de igualdade/prefixo em
   * `display_name` se algum existir). Sem filtro nenhum, é só `ORDER BY ... LIMIT`, "os primeiros
   * N do diretório".
   */
  /**
   * `excludeUid` (R2-B, popup estilo ClickUp): o próprio requester nunca aparece na própria lista
   * de mencionáveis — `undefined`/`null` não exclui ninguém (uso interno/teste que não tem um
   * requester para excluir).
   *
   * `isOnline` (R2-B, reescrito 22/09 para tabela própria): calculado AQUI, no SQL, na leitura —
   * nunca persistido (`migrations/465_staff_presence.sql`). `LEFT JOIN staff_presence` — staff que
   * nunca mandou heartbeat não tem linha lá (ausência de linha, não `NULL` numa coluna de
   * `users`), por isso `isOnline` cai em `false` por ausência de match. Este módulo (identity) só
   * faz o JOIN de leitura; a ESCRITA do heartbeat vive em `@modules/presence` (módulo próprio).
   *
   * `patientId` (R3-1, change 022-ux-mencao-e-notificacao, Rodada 3, pedido do Gabriel 22/09): o
   * `@` do chat só deve listar quem PODE, de fato, abrir a conversa DAQUELE paciente — não todo
   * staff com `staff_directory:read`. `undefined`/`null` (default) = comportamento atual, sem
   * recorte (o controller só passa um valor aqui quando a família `admin.patients` está
   * enforced — engine desligado não filtra ninguém, D-Gabriel). Com valor: um `EXISTS`
   * correlacionado usa `iam.effective_permissions` (mig 276) — a MESMA fonte que
   * `PermissionService.resolve` consulta para decidir `patient_conversation:read` na rota REAL
   * da conversa (`adminConversationRoutes.ts`). Tudo em UMA query (`STABLE`, chamada por linha
   * dentro do mesmo `SELECT`), não em loop no Node por candidato (sem N+1 de round-trip).
   * Paciente inexistente → o `EXISTS` nunca casa (`SELECT 1 FROM patients WHERE id = ...` vazio)
   * → lista vazia, fail-closed: não há como provar acesso a uma conversa que não existe.
   *
   * `enforceCountry` (gate 🔴 do revisao-pr, 22/09): o recorte de PAÍS (`pt.country = ANY
   * (iam.effective_countries(...))`) só entra na `EXISTS` quando a alavanca que o torna REAL
   * está ligada — `COUNTRY_RLS_ENABLED` (lida pelo controller via `isEnvFlagOn`, o mesmo padrão
   * do eixo de CÉLULA, gateado por `isPermissionFamilyEnforced(admin.patients)`). Em prd,
   * `COUNTRY_RLS_ENABLED=false` (medido 22/09): a rota REAL da conversa
   * (`PermissionMiddleware`/`PermissionClientActorAccessChecker`) NUNCA filtra por país — só por
   * célula. Sem este gate, o `@` seria MAIS restritivo que o acesso real: quem tem a célula mas
   * nenhum `group_country_scopes` cadastrado (D113: ausência é `[]`, nunca "libera geral") já
   * pode abrir a conversa de verdade em prd, mas sumiria do autocomplete — exatamente o inverso
   * do achado F24 que criou `isPermissionFamilyEnforced`. Default `false` (comportamento de prd:
   * sem a flag, sem recorte de país) — nunca `true` por omissão, para não reintroduzir o mesmo
   * bug por um call site que esqueça de passar o valor.
   *
   * Achado 🟡 do gate revisao-pr: o MESMO predicado "quem pode abrir a conversa" também existe em
   * `PermissionClientActorAccessChecker.canReadPatientConversation` (módulo `inapp-notification`,
   * decide se um staff é notificado de mensagem nova). Os dois SÃO coerentes hoje — ambos usam
   * `iam.effective_permissions`/`client.can` como FONTE da célula, e nenhum dos dois filtra por
   * país enquanto `COUNTRY_RLS_ENABLED=false` (o checker nunca chegou a checar país; este
   * repositório passou a checar, mas só quando a flag liga). Por que aqui é uma query EM LOTE e
   * lá é uma checagem de UM ATOR por vez: este método monta a lista de candidatos ao popup de
   * `@` (N candidatos por request, resolvido em UMA query com `EXISTS` correlacionado, mig 276);
   * o checker recebe UM `actorUid` já conhecido (o destinatário da notificação) e só precisa
   * responder sim/não pra ele — não há lista pra montar, então não há lote pra fazer. Se
   * `COUNTRY_RLS_ENABLED` virar `true` em prd, o checker PRECISARÁ ganhar o mesmo recorte de país
   * (hoje não tem, nem gateado) para os dois não divergirem — fica registrado aqui como o
   * próximo passo, não implementado nesta mudança (fora do escopo aprovado: o achado nomeado foi
   * o 🔴 de país no `@`, não uma reescrita do checker de notificação).
   */
  async searchStaffDirectory(
    q: string | undefined,
    limit = 20,
    excludeUid?: string | null,
    patientId?: string | null,
    enforceCountry = false,
  ): Promise<StaffDirectoryEntry[]> {
    const trimmed = q?.trim();
    const exclude = excludeUid ?? null;

    if (!trimmed) {
      const params: unknown[] = [limit, exclude];
      const patientClause = patientId
        ? this.patientConversationAccessClause(params, patientId, '$3', '$4', enforceCountry)
        : '';
      const result = await this.pool.query(
        `SELECT
          u.firebase_uid AS uid,
          u.display_name AS "displayName",
          (sp.last_seen_at IS NOT NULL AND sp.last_seen_at > now() - interval '5 minutes') AS "isOnline"
        FROM users u
        LEFT JOIN staff_presence sp ON sp.firebase_uid = u.firebase_uid
        WHERE u.account_type = 'staff' AND u.is_active = true
          AND ($2::text IS NULL OR u.firebase_uid <> $2)
          ${patientClause}
        ORDER BY u.display_name, u.firebase_uid
        LIMIT $1`,
        params
      );
      return result.rows;
    }

    const escaped = escapeIlikeWildcards(trimmed);
    const params: unknown[] = [escaped, limit, exclude];
    const patientClause = patientId
      ? this.patientConversationAccessClause(params, patientId, '$4', '$5', enforceCountry)
      : '';
    const result = await this.pool.query(
      `SELECT
        u.firebase_uid AS uid,
        u.display_name AS "displayName",
        (sp.last_seen_at IS NOT NULL AND sp.last_seen_at > now() - interval '5 minutes') AS "isOnline"
      FROM users u
      LEFT JOIN staff_presence sp ON sp.firebase_uid = u.firebase_uid
      WHERE u.account_type = 'staff' AND u.is_active = true
        AND (u.display_name ILIKE '%' || $1 || '%' ESCAPE '\\'
          OR u.email ILIKE '%' || $1 || '%' ESCAPE '\\')
        AND ($3::text IS NULL OR u.firebase_uid <> $3)
        ${patientClause}
      ORDER BY u.display_name, u.firebase_uid
      LIMIT $2`,
      params
    );
    return result.rows;
  }

  /**
   * Monta o `EXISTS` de acesso à conversa do paciente (R3-1) e empilha os parâmetros que ele
   * consome (`patientId`, `ENLITE_TENANT_ID`) no array `params` do chamador — os placeholders
   * `$patientParam`/`$tenantParam` são passados pelo chamador porque a posição varia conforme o
   * ramo (`q` ausente vs presente) já ter 2 ou 3 parâmetros antes deste.
   *
   * Célula (`patient_conversation:read` via `iam.effective_permissions`) SEMPRE entra — é a
   * MESMA decisão que `PermissionClientActorAccessChecker.canReadPatientConversation` usa depois
   * de confirmar que a família está enforced (F23: grant real decide, como sempre). O recorte de
   * PAÍS é que é condicional — ver `enforceCountry` no docblock de `searchStaffDirectory`.
   */
  private patientConversationAccessClause(
    params: unknown[],
    patientId: string,
    patientParam: string,
    tenantParam: string,
    enforceCountry: boolean,
  ): string {
    params.push(patientId, ENLITE_TENANT_ID);
    const countryClause = enforceCountry
      ? `AND pt.country = ANY(iam.effective_countries(u.firebase_uid, ${tenantParam}::uuid))`
      : '';
    return `AND EXISTS (
            SELECT 1 FROM patients pt
            WHERE pt.id = ${patientParam}::uuid
              AND 'patient_conversation:read' = ANY(iam.effective_permissions(u.firebase_uid, ${tenantParam}::uuid))
              ${countryClause}
          )`;
  }

  async countAdmins(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) AS total FROM users WHERE role = 'admin'`
    );
    return parseInt(result.rows[0].total);
  }

  /** Updates last_login_at and login_count on users. */
  async updateLastLogin(firebaseUid: string): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET last_login_at = NOW(), login_count = login_count + 1
       WHERE firebase_uid = $1`,
      [firebaseUid]
    );
  }

  /**
   * O uid é o ÚNICO gestor vivo (`permission_management:write`) de algum tenant?
   * Fonte única: `iam.is_last_manager` (410) — a mesma função que o trigger de
   * `users` usa para recusar o DELETE. Aqui ela é PRÉ-checagem, porque o use case
   * apaga a conta no Firebase ANTES do banco: sem isto, a recusa do banco chegaria
   * com a conta Firebase já apagada.
   */
  async isLastManager(firebaseUid: string): Promise<boolean> {
    const result = await this.pool.query<{ last: boolean }>(
      `SELECT iam.is_last_manager($1) AS last`,
      [firebaseUid]
    );
    return result.rows[0]?.last === true;
  }

  async deleteByFirebaseUid(firebaseUid: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM users WHERE firebase_uid = $1`,
      [firebaseUid]
    );
  }

  async findByEmail(email: string): Promise<AdminRecord | null> {
    const result = await this.pool.query(
      `SELECT
        u.firebase_uid      AS "firebaseUid",
        u.email,
        u.display_name      AS "displayName",
        u.role,
        u.department,
        u.last_login_at     AS "lastLoginAt",
        COALESCE(u.login_count, 0) AS "loginCount",
        u.created_at        AS "createdAt"
      FROM users u
      WHERE u.email = $1
        AND u.account_type = 'staff'
        AND u.is_active = true`,
      [email]
    );
    return result.rows[0] ?? null;
  }

  async reassignFirebaseUid(email: string, newFirebaseUid: string): Promise<void> {
    await this.pool.query(
      `UPDATE users SET firebase_uid = $1, updated_at = NOW()
       WHERE email = $2 AND firebase_uid <> $1`,
      [newFirebaseUid, email]
    );
  }
}
