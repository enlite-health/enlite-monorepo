/**
 * Forma canônica do snapshot: ordenado em todo nível, e-mail em minúsculas, sem
 * campo fora do contrato. É o que torna "dry-run 2× dá o mesmo JSON" verificável
 * por hash — e diff de git legível quando o time muda uma célula.
 */

import { createHash } from 'crypto';
import { expandWriteCells } from '../../domain/PermissionCell';
import type { IamConfigSnapshot, IamCountryFeatureSnapshot, IamGroupSnapshot } from './types';

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function normalizeSnapshot(input: IamConfigSnapshot): IamConfigSnapshot {
  const groups: IamGroupSnapshot[] = [...input.groups]
    .map((g) => ({
      name: g.name,
      description: g.description ?? null,
      isSystem: Boolean(g.isSystem),
      // ADR-2/SUP-30: passa TODO `cells` pela expansão `write` → `create`+`update` (recurso
      // splitado) ANTES de deduplicar/ordenar. Único ponto para os dois lados do transporte
      // (D208): um EXPORT de banco já migrado (que ainda tem a linha `write` em
      // `iam.group_permissions` — a migration 435 não apaga) nunca mostra `write` residual no
      // JSON canônico; um IMPORT de arquivo ANTIGO (`write` puro, de antes do split) expande
      // antes do diff em `planIamConfigImport` — sem isto o plano tentaria `set_permissions`
      // com uma célula que o alvo pode ter deprecado.
      cells: [...new Set(expandWriteCells(g.cells))].sort(byString),
      countries: [...new Set(g.countries.map((c) => c.toUpperCase()))].sort(byString),
      members: [...new Set(g.members.map((m) => m.trim().toLowerCase()))].sort(byString),
    }))
    .sort((a, b) => byString(a.name, b.name));

  const countryFeatures: IamCountryFeatureSnapshot[] = [...input.countryFeatures]
    .map((f) => ({
      country: f.country.toUpperCase(),
      featureKey: f.featureKey,
      enabled: Boolean(f.enabled),
      config: f.config ?? null,
    }))
    .sort((a, b) => byString(a.country, b.country) || byString(a.featureKey, b.featureKey));

  return { version: 1, tenantId: input.tenantId, groups, countryFeatures };
}

/** JSON estável (chaves na ordem do contrato) — o que vai para o arquivo. */
export function canonicalJson(snapshot: IamConfigSnapshot): string {
  return JSON.stringify(normalizeSnapshot(snapshot), null, 2) + '\n';
}

/** Identidade curta do arquivo, para o `reason` das operações. */
export function snapshotHash(snapshot: IamConfigSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex').slice(0, 12);
}

/** Igualdade de `config` de feature: por valor, não por referência. */
export function sameConfig(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
