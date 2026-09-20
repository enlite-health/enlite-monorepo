/**
 * src/modules/identity/permissions/application/ports.ts
 *
 * As PORTAS do módulo. Duas famílias, com propósitos opostos:
 *
 *  · portas de SAÍDA (`*Repository`, `PermissionEventPublisher`) — o que o
 *    módulo precisa do mundo (Postgres, outbox). Trocáveis em teste.
 *  · porta de ENTRADA (`PermissionClient`) — a ÚNICA coisa que código fora do
 *    módulo pode chamar (D115 §7). Hoje é in-process; na extração vira HTTP e
 *    nenhum consumidor muda de linha.
 *
 * Nada aqui conhece Express, `pg` ou tabela: é o contrato, não a implementação.
 */

import type { CountryCode } from '@shared/domain/countryCodes';
import type { PermissionCell } from '../domain/PermissionCell';
import type { PermissionGroup, PermissionGroupDetail } from '../domain/PermissionGroup';
import type { CountryFeature } from '../domain/CountryFeature';
import type { GroupMembership } from '../domain/GroupMembership';

/** Status de conta que o resolver enxerga (`users.status`, mig 206). */
export type StaffStatus = 'ACTIVE' | 'PENDING_ONBOARDING' | 'SUSPENDED' | 'DEACTIVATED';

/** O que o staff PODE e ONDE — resultado da resolução por request. */
export interface ResolvedAuthz {
  uid: string;
  tenantId: string;
  status: StaffStatus | null;
  /** Chaves `recurso:ação` (união dos grupos vivos). */
  permissions: string[];
  countries: CountryCode[];
  /** Grupos vigentes (id + nome) — a tela de boas-vindas e a auditoria usam. */
  groups: Array<{ id: string; name: string }>;
}

/** Contrato agregado do painel (`GET /v1/me/authz`, design 11). */
export interface AuthzContract extends ResolvedAuthz {
  /** country → featureKey → {enabled, config}. */
  features: Record<string, Record<string, { enabled: boolean; config: unknown }>>;
  /**
   * Espelha o MESMO `isEnvFlagOn('PERMISSION_ENGINE_ENABLED', env)` que o
   * wiring já lê (D268) — nunca uma 2ª leitura de env. `groups` vem do banco
   * independente do engine; sem este campo a tela de "sem grupo" não
   * distingue "engine desligado" (26/28 staff sem grupo na stage é normal) de
   * "engine ligado e a conta realmente não tem grupo".
   */
  enforcement: 'on' | 'off';
}

export interface EffectiveAuthzRepository {
  /** `iam.effective_permissions` — a MESMA função que a policy RLS consulta. */
  effectivePermissions(uid: string, tenantId: string): Promise<string[]>;
  /** `iam.effective_countries` — idem (lex C3: quem resolve é o banco). */
  effectiveCountries(uid: string, tenantId: string): Promise<CountryCode[]>;
  /** Status + grupos vigentes, numa consulta só (o resolver chama por request). */
  snapshot(uid: string, tenantId: string): Promise<ResolvedAuthz>;
  /** Gate da virada (task 2.7): quantos staff ACTIVE ficariam sem NENHUM grupo. */
  countActiveStaffWithoutGroup(tenantId: string): Promise<number>;
}

export interface CreateGroupInput {
  tenantId: string;
  name: string;
  description?: string | null;
}

export interface GroupMemberView {
  userId: string;
  email: string | null;
  role: string | null;
  status: StaffStatus | null;
  assignedBy: string | null;
  assignedAt: Date;
}

/**
 * Escrita SEMPRE pelas funções `SECURITY DEFINER` da mig 279 (lex C4) — a role
 * do app não tem INSERT nestas tabelas, de propósito. Nenhum método aqui monta
 * INSERT/UPDATE em `iam.*`.
 */
export interface PermissionGroupRepository {
  list(tenantId: string, options?: { includeArchived?: boolean }): Promise<PermissionGroupDetail[]>;
  /** Grupo de outro tenant → `null`, indistinguível de inexistente (spec). */
  findById(tenantId: string, groupId: string): Promise<PermissionGroupDetail | null>;
  listMembers(tenantId: string, groupId: string): Promise<GroupMemberView[]>;
  /** uids com vínculo VIVO — quem tem o cache invalidado quando o grupo muda. */
  liveMemberUids(tenantId: string, groupId: string): Promise<string[]>;
  membershipHistory(tenantId: string, groupId: string, userId: string): Promise<GroupMembership[]>;

  create(input: CreateGroupInput): Promise<string>;
  update(groupId: string, patch: { name?: string; description?: string | null }): Promise<void>;
  archive(groupId: string): Promise<void>;
  /** Substitui o conjunto de células (ids do catálogo) — diff vira trilha. */
  setPermissions(groupId: string, permissionIds: string[], reason: string | null): Promise<void>;
  grantCountry(groupId: string, country: CountryCode, reason: string | null): Promise<string>;
  /** Linhas revogadas: 0 = nada vivo (idempotente). */
  revokeCountry(groupId: string, country: CountryCode): Promise<number>;
  addMember(groupId: string, userId: string): Promise<string>;
  removeMember(groupId: string, userId: string): Promise<number>;
}

/** Célula declarada no código — o que o scanner encontra numa rota. */
export interface DeclaredCell {
  resource: string;
  action: string;
  description?: string | null;
}

export interface CatalogSyncResult {
  inserted: number;
  /** Marcadas `deprecated_at` porque sumiram do código. */
  deprecated: number;
  /** Voltaram a ser declaradas depois de descontinuadas. */
  revived: number;
  total: number;
  /**
   * D338: células ATIVAS concedidas ao Acesso Master nesta sincronização (0 na maioria dos
   * boots — só sobe quando o catálogo ganhou célula nova, ou quando reconcilia um grant
   * removido por fora). Exclusivo do Master; nenhum outro grupo é tocado (D285 intacta).
   */
  masterGranted: number;
  /**
   * B-1 (mig 451, decisão Gabriel 19/09/2026): contas fixas concedidas ao Acesso Master nesta
   * sincronização (0 na maioria dos boots — só sobe quando uma das 5 contas fixas foi criada
   * depois da migration, ou reconcilia um grant removido por fora). Nunca remove; nunca toca
   * outro grupo.
   */
  fixedAccountsGranted: number;
}

export interface PermissionCatalogRepository {
  list(options?: { includeDeprecated?: boolean }): Promise<PermissionCell[]>;
  /** chave `recurso:ação` → id; chave desconhecida NÃO aparece no mapa. */
  idsByCellKey(cellKeys: string[]): Promise<Map<string, string>>;
  /** Upsert do declarado + `deprecated_at` no que sumiu. Nunca apaga linha. */
  sync(cells: DeclaredCell[], ownerService: string): Promise<CatalogSyncResult>;
}

export interface CountryFeatureRepository {
  list(): Promise<CountryFeature[]>;
  /** Override do painel (`iam.set_country_feature`, exige motivo). */
  setOverride(
    country: CountryCode,
    featureKey: string,
    enabled: boolean,
    config: unknown,
    reason: string,
  ): Promise<void>;
  /** Default do manifest (`iam.sync_country_feature_default`, só app_system). */
  syncDefault(country: CountryCode, featureKey: string, enabled: boolean, config: unknown): Promise<void>;
}

/**
 * Marcadores de rollout por ambiente (`iam.rollout_state`, mig 282).
 *
 * `get` é o caminho de LEITURA do processo (boot, `app_runtime`/`app_system`) —
 * essas roles não têm INSERT/UPDATE na tabela (mig 282, REVOKE explícito): o
 * processo nunca acende o próprio gate.
 *
 * `set` é o caminho de ESCRITA (F12): só quem conecta como owner (o script da
 * migração de dados, `scripts/iam-config-import.ts`, via `pg.Pool` próprio)
 * consegue de fato gravar — chamado pelo processo em `app_runtime`/`app_system`
 * ele estoura 42501, que é o comportamento correto.
 */
export interface RolloutStateRepository {
  get(key: string): Promise<string | null>;
  /** Upsert por `key` — idempotente (2ª chamada com o mesmo valor não falha). */
  set(key: string, value: string, note?: string | null): Promise<void>;
}

/** Uma decisão de autorização — o que vira linha em `iam.permission_audit_log`. */
export interface PermissionDecision {
  tenantId: string;
  userId: string;
  resource: string;
  action: string;
  decision: 'ALLOW' | 'DENY';
  /** id do alvo quando houver (nunca nome, telefone ou documento — lex C16). */
  resourceId?: string | null;
  reason?: string | null;
  /**
   * País do CONTEXTO da request. É o que permite a `iam.query_audit` mascarar o
   * `resourceId` para auditor de outro país sem SUPRIMIR a linha — suprimir
   * cegaria a detecção de acesso cross-país (lex 0.2, M2-5; mig 283).
   */
  country?: string | null;
}

export interface PermissionAuditFilters {
  userId?: string | null;
  resource?: string | null;
  since?: Date | null;
  until?: Date | null;
  limit?: number | null;
}

export interface PermissionAuditRow {
  id: string;
  userId: string;
  resource: string;
  action: string;
  /**
   * `'<oculto>'` quando o auditor não tem escopo no país da linha — a linha
   * APARECE (senão o acesso cross-país ficaria invisível para quem deve
   * detectá-lo), só o identificador do titular é que não (mig 283).
   */
  resourceId: string | null;
  decision: string;
  createdAt: Date;
  country: string | null;
}

export interface PermissionAuditRepository {
  /** Async fail-safe: nunca lança, nunca derruba a request (molde da 270). */
  record(entry: PermissionDecision): void;
  /** Leitura por `iam.query_audit` — gated e com o próprio ato registrado (C7). */
  query(filters: PermissionAuditFilters): Promise<PermissionAuditRow[]>;
}

/**
 * Invalidação de cache entre instâncias (design 4): toda mutação publica o
 * evento; a instância que o processa limpa o cache local. Janela ≈ 0 onde a
 * mudança foi feita, ≤ TTL nas outras.
 */
export interface PermissionEventPublisher {
  permissionChanged(uids: string[]): Promise<void>;
  countryFeatureChanged(country: CountryCode, featureKey: string): Promise<void>;
}

/**
 * PORTA DE ENTRADA — o resto do sistema fala só com isto (in-process hoje, HTTP
 * amanhã). Quem importar um repositório ou um use case de fora do módulo quebra
 * o teste de fronteira (task 2.1).
 */
export interface PermissionClient {
  /** Permissões, países, status e grupos do staff — com cache curto. */
  resolve(uid: string, tenantId: string): Promise<ResolvedAuthz>;
  can(uid: string, tenantId: string, resource: string, action: string): Promise<boolean>;
  isFeatureAvailable(country: CountryCode, featureKey: string): Promise<boolean>;
  featureConfig(country: CountryCode, featureKey: string): Promise<unknown>;
  /** Sem uids = limpa tudo (o handler do evento chama com a lista). */
  invalidate(uids?: string[]): void;
}

export type { PermissionCell, PermissionGroup, PermissionGroupDetail, CountryFeature, GroupMembership };
