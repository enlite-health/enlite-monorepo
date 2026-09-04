/**
 * src/modules/identity/permissions/application/iamConfig/types.ts
 *
 * A CONFIGURAÇÃO IAM como dado portável (D208): o que o time monta em stage
 * (grupos, células, países por grupo, membros, overrides de feature) viaja para
 * produção num JSON versionável. Por isso as referências são por CHAVE, nunca por
 * id: grupo pelo nome, célula por `recurso:ação`, membro por e-mail — o uid do
 * Identity Platform e o id do grupo diferem entre ambientes.
 *
 * Só o que é DECISÃO humana entra: feature com `source='default'` nasce do
 * manifest no boot e fica de fora; `is_system` viaja só para o planejador saber
 * o que nunca arquivar.
 */

export interface IamGroupSnapshot {
  name: string;
  description: string | null;
  isSystem: boolean;
  /** `recurso:ação`, ordenadas. */
  cells: string[];
  /** ISO-2, ordenados. */
  countries: string[];
  /** E-mails de staff com vínculo vivo, ordenados. */
  members: string[];
}

export interface IamCountryFeatureSnapshot {
  country: string;
  featureKey: string;
  enabled: boolean;
  config: unknown | null;
}

export interface IamConfigSnapshot {
  version: 1;
  tenantId: string;
  groups: IamGroupSnapshot[];
  countryFeatures: IamCountryFeatureSnapshot[];
}

export type IamImportOp =
  | { kind: 'create_group'; group: string; description: string | null }
  | { kind: 'update_group'; group: string; description: string | null }
  | { kind: 'archive_group'; group: string }
  | { kind: 'set_permissions'; group: string; cells: string[] }
  | { kind: 'grant_country'; group: string; country: string }
  | { kind: 'revoke_country'; group: string; country: string }
  | { kind: 'add_member'; group: string; email: string }
  | { kind: 'remove_member'; group: string; email: string }
  | { kind: 'set_country_feature'; country: string; featureKey: string; enabled: boolean; config: unknown | null };

export interface IamImportError {
  code:
    | 'unknown_cell'
    | 'system_group_missing'
    | 'tenant_mismatch'
    | 'unsupported_version'
    | 'unknown_member_on_remove'
    | 'archived_group_name_conflict';
  detail: string;
}

export interface IamImportPendency {
  code: 'email_without_account';
  email: string;
  group: string;
}

export interface IamImportPlan {
  /** Na ordem de aplicação: grupos → células → países → membros → features. */
  ops: IamImportOp[];
  /** Plano com erro NÃO se aplica — nada é escrito. */
  errors: IamImportError[];
  pendencies: IamImportPendency[];
}

export interface IamImportOptions {
  /** Arquiva grupos NÃO-sistema presentes no alvo e ausentes do snapshot. Default: manter. */
  archiveMissing?: boolean;
}
