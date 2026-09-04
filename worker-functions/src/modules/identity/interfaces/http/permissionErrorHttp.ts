/**
 * src/modules/identity/interfaces/http/permissionErrorHttp.ts
 *
 * O vocabulário de falha do domínio de permissões (`PermissionErrorCode`) → HTTP,
 * num lugar só. Nasceu em `permissionPanelWriteRoutes.ts`; saiu de lá em 28/08/2026
 * quando `DELETE /api/admin/users/:id` passou a devolver `last_manager` e o gate
 * `revisao-pr` pegou a segunda cópia divergindo da primeira (status igual, frase
 * diferente — e a nova vazava nome de célula para o cliente). Duas bordas, um mapa.
 */

import type { PermissionErrorCode } from '@modules/identity/permissions';

/**
 * Vocabulário de falha → HTTP. O domínio existe justamente para a borda não
 * depender de `error.code` do driver nem de frase do Postgres.
 *
 * `last_manager` é **409**, não 403: quem pediu TINHA permissão; o que o
 * sistema recusa é o estado resultante. Um 403 diria "você não pode", e a
 * pessoa iria procurar a permissão que falta — que não é o problema.
 */
export const STATUS_POR_CODIGO: Readonly<Record<PermissionErrorCode, number>> = {
  forbidden: 403,
  not_found: 404,
  duplicate_name: 409,
  system_group: 409,
  last_manager: 409,
  invalid_cell: 400,
  reason_required: 400,
  invalid_feature_key: 400,
  invalid_feature_config: 400,
  invalid_country: 400,
  invalid_input: 400,
};

/**
 * A frase que o cliente vê. Existe porque `perm.message` carrega, em alguns
 * códigos, a mensagem CRUA do Postgres — com nome de tabela e de constraint.
 * O `code` é o que a tela consome; a frase é para humano, e é nossa.
 */
export const MENSAGEM_POR_CODIGO: Readonly<Record<PermissionErrorCode, string>> = {
  forbidden: 'Sem permissão para gerenciar acessos.',
  not_found: 'Grupo não encontrado.',
  duplicate_name: 'Já existe um grupo com esse nome.',
  system_group: 'Grupo de sistema não pode ser alterado nem arquivado.',
  last_manager: 'A operação deixaria a empresa sem nenhum gestor de acessos.',
  invalid_cell: 'Célula fora do catálogo ou descontinuada.',
  reason_required: 'Esta operação exige um motivo.',
  invalid_feature_key: 'Chave de feature inválida.',
  invalid_feature_config: 'Configuração da feature inválida.',
  invalid_country: 'País não suportado.',
  invalid_input: 'Dados inválidos.',
};
