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
  /** E-mails (minúsculos) de staff com conta no alvo. */
  knownEmails: ReadonlySet<string>;
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
    for (const email of remove) ops.push({ kind: 'remove_member', group: g.name, email });
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
