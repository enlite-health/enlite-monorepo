/**
 * O PLANO de importação, calculado em memória: o que o alvo precisa mudar para
 * ficar igual ao snapshot. Puro — recebe o estado atual do alvo já lido, o
 * catálogo de células vivas do alvo e os e-mails que têm conta lá; devolve
 * operações na ordem em que as SECURITY DEFINER da 279 as aceitam.
 *
 * Regras que valem dinheiro:
 *   · célula que o alvo não conhece é ERRO do plano — um plano com erro não se
 *     aplica (nada é escrito), porque pular em silêncio deixaria um grupo com
 *     menos poder do que o time decidiu, e ninguém saberia;
 *   · e-mail sem conta no alvo é PENDÊNCIA, não erro: a pessoa entra quando a
 *     conta existir, e a 2ª execução volta a listar;
 *   · (M1) membro vivo rebaixado (role fora das 3 de staff) é PENDÊNCIA
 *     `member_role_not_staff`, não erro — o export lista TODO vínculo vivo, e
 *     a remoção dele NÃO fica presa a `knownEmails` (staff-only, que vale só
 *     para ADD);
 *   · grupo ausente do snapshot é MANTIDO (D124: nunca apagar); `archiveMissing`
 *     arquiva só grupos não-sistema;
 *   · o NOME é a chave do grupo — renomear é criar outro (SUP-5).
 */

import { normalizeSnapshot, sameConfig } from './snapshot';
import type { IamConfigSnapshot, IamImportError, IamImportOp, IamImportOptions, IamImportPendency, IamImportPlan } from './types';

export interface IamTargetState {
  /** O alvo, na mesma forma do snapshot (inclui grupos arquivados = false). */
  current: IamConfigSnapshot;
  /** Células vivas (`deprecated_at IS NULL`) do catálogo do alvo. */
  catalog: ReadonlySet<string>;
  /** E-mails (minúsculos) de staff com conta no alvo. Vale para ADD (e para `email_without_account`). */
  knownEmails: ReadonlySet<string>;
  /**
   * (M1) E-mails (minúsculos) com QUALQUER conta viva no alvo, staff ou não —
   * a lookup usada só para REMOVE. `exportSnapshot` deixou de filtrar `role`
   * (M1): um membro vivo cujo role saiu das 3 de staff continua aparecendo em
   * `current.members`, e removê-lo não pode depender de `knownEmails`
   * (staff-only), senão `unknown_member_on_remove` bloqueia o plano inteiro
   * por um vínculo que o próprio alvo confirma existir. `knownEmails` continua
   * sendo o teto de quem pode ser ADICIONADO.
   */
  removableEmails: ReadonlySet<string>;
  /**
   * Nomes de grupo ARQUIVADOS do alvo (M4). `current.groups` só tem grupos
   * vivos (contrato do snapshot) — sem isto o planner não distingue "nome
   * livre" de "nome existe, mas arquivado" e tenta `create_group`, que
   * estoura a UNIQUE `(tenant_id, name)` da 206 (não é parcial).
   */
  archivedGroupNames: ReadonlySet<string>;
}

const diff = (want: string[], have: string[]) => ({
  add: want.filter((x) => !have.includes(x)),
  remove: have.filter((x) => !want.includes(x)),
});

export function planIamConfigImport(
  desiredInput: IamConfigSnapshot,
  target: IamTargetState,
  options: IamImportOptions = {},
): IamImportPlan {
  const desired = normalizeSnapshot(desiredInput);
  const current = normalizeSnapshot(target.current);
  const ops: IamImportOp[] = [];
  const errors: IamImportError[] = [];
  const pendencies: IamImportPendency[] = [];

  if ((desiredInput.version as number) !== 1) {
    errors.push({ code: 'unsupported_version', detail: `version=${String(desiredInput.version)}` });
  }
  if (desired.tenantId !== current.tenantId) {
    errors.push({ code: 'tenant_mismatch', detail: `snapshot=${desired.tenantId} alvo=${current.tenantId}` });
  }

  const currentByName = new Map(current.groups.map((g) => [g.name, g]));
  const desiredNames = new Set(desired.groups.map((g) => g.name));

  // 1. grupos
  for (const g of desired.groups) {
    const cur = currentByName.get(g.name);
    if (!cur) {
      if (g.isSystem) {
        errors.push({ code: 'system_group_missing', detail: `grupo de sistema '${g.name}' não existe no alvo` });
        continue;
      }
      if (target.archivedGroupNames.has(g.name)) {
        // M4: nome existe arquivado no alvo — a UNIQUE (tenant_id, name) da 206
        // não é parcial, então create_group aqui é 23505 garantido. O plano
        // acusa e NÃO tenta criar; quem resolve é gente (desarquivar/renomear).
        errors.push({
          code: 'archived_group_name_conflict',
          detail: `grupo '${g.name}' existe arquivado no alvo — desarquivar ou renomear`,
        });
        continue;
      }
      ops.push({ kind: 'create_group', group: g.name, description: g.description });
    } else if (!cur.isSystem && cur.description !== g.description) {
      ops.push({ kind: 'update_group', group: g.name, description: g.description });
    }
  }
  if (options.archiveMissing) {
    for (const cur of current.groups) {
      if (!desiredNames.has(cur.name) && !cur.isSystem) ops.push({ kind: 'archive_group', group: cur.name });
    }
  }

  // 2. células (conjunto inteiro por grupo — é como set_group_permissions trabalha)
  for (const g of desired.groups) {
    for (const cell of g.cells) {
      if (!target.catalog.has(cell)) errors.push({ code: 'unknown_cell', detail: `${g.name}: ${cell}` });
    }
    const cur = currentByName.get(g.name);
    const have = cur?.cells ?? [];
    if (have.length !== g.cells.length || have.some((c, i) => c !== g.cells[i])) {
      ops.push({ kind: 'set_permissions', group: g.name, cells: g.cells });
    }
  }

  // 3. países
  for (const g of desired.groups) {
    const { add, remove } = diff(g.countries, currentByName.get(g.name)?.countries ?? []);
    for (const country of add) ops.push({ kind: 'grant_country', group: g.name, country });
    for (const country of remove) ops.push({ kind: 'revoke_country', group: g.name, country });
  }

  // 4. membros
  for (const g of desired.groups) {
    const { add, remove } = diff(g.members, currentByName.get(g.name)?.members ?? []);
    for (const email of add) {
      if (!target.knownEmails.has(email)) pendencies.push({ code: 'email_without_account', email, group: g.name });
      else ops.push({ kind: 'add_member', group: g.name, email });
    }
    for (const email of remove) {
      // M1: a checagem de remoção é contra `removableEmails` (QUALQUER conta
      // viva, sem filtro de role) — NÃO `knownEmails` (staff-only). Antes de
      // M1, `exportSnapshot` já filtrava por role, então um membro fora das 3
      // roles de staff nunca aparecia em `current.members`, e esta checagem
      // usava `knownEmails` sem diferença observável. Agora que o export lista
      // TODO vínculo vivo, usar `knownEmails` aqui bloquearia o plano inteiro
      // (`unknown_member_on_remove`) sempre que alguém for rebaixado — o
      // oposto do que a remoção existe para resolver.
      if (!target.removableEmails.has(email)) {
        // Sem conta NENHUMA no alvo — fonte divergente, corrida. Continua ERRO
        // do PLANO (dry-run acusa), nunca `remove_member` explodindo `applyOp`
        // no meio da transação. `detail` não carrega e-mail (B4: nunca logar
        // PII em texto claro) — o e-mail vai no campo estruturado.
        errors.push({ code: 'unknown_member_on_remove', detail: `${g.name}: sem conta conhecida no alvo`, email });
        continue;
      }
      if (!target.knownEmails.has(email)) {
        // M1: conta existe, mas o role atual saiu das 3 de staff — sinaliza
        // sem bloquear; a remoção segue normalmente.
        pendencies.push({ code: 'member_role_not_staff', email, group: g.name });
      }
      ops.push({ kind: 'remove_member', group: g.name, email });
    }
  }

  // 5. features (override)
  const curFeature = new Map(current.countryFeatures.map((f) => [`${f.country}|${f.featureKey}`, f]));
  for (const f of desired.countryFeatures) {
    const cur = curFeature.get(`${f.country}|${f.featureKey}`);
    if (!cur || cur.enabled !== f.enabled || !sameConfig(cur.config, f.config)) {
      ops.push({ kind: 'set_country_feature', country: f.country, featureKey: f.featureKey, enabled: f.enabled, config: f.config });
    }
  }

  return { ops, errors, pendencies };
}
