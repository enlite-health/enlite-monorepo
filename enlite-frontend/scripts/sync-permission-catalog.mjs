#!/usr/bin/env node
/**
 * Gera `src/test/fixtures/permission-catalog.json` a partir do SEED do backend
 * (`worker-functions/migrations/206_permissions_iam_foundation.sql`) E
 * `src/test/fixtures/feature-catalog.json` a partir do manifest de features
 * por país (`country-features.manifest.ts`) — MESMO padrão para as duas: ler o
 * arquivo fonte como texto (nunca importar — os dois pacotes não compartilham
 * resolução de módulo) e extrair as chaves por regex.
 *
 * Os fixtures existem para os testes de paridade (B3) rodarem sem o backend ao
 * lado (CI do front é outro job). Mas NENHUM dos dois é fonte: os testes, ao
 * achar os arquivos originais, conferem que o fixture ainda é igual à fonte —
 * senão seria comparar duas cópias da mesma suposição.
 *
 * Uso: `node scripts/sync-permission-catalog.mjs`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_PATH = resolve(here, '../../worker-functions/migrations/206_permissions_iam_foundation.sql');
export const FIXTURE_PATH = resolve(here, '../src/test/fixtures/permission-catalog.json');
export const MANIFEST_PATH = resolve(
  here,
  '../../worker-functions/src/modules/identity/permissions/infrastructure/country-features.manifest.ts',
);
export const FEATURE_FIXTURE_PATH = resolve(here, '../src/test/fixtures/feature-catalog.json');

/** Lê as células `('resource', 'action', ...)` do INSERT em `permissions`. */
export function cellsFromSeed(sql) {
  const inicio = sql.indexOf('INSERT INTO permissions');
  if (inicio < 0) throw new Error('INSERT INTO permissions não encontrado no seed');
  const fim = sql.indexOf(';', inicio);
  const bloco = sql.slice(inicio, fim);
  const cells = new Set();
  for (const m of bloco.matchAll(/\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'([a-z][a-z0-9_]*)'/g)) {
    cells.add(`${m[1]}:${m[2]}`);
  }
  return [...cells].sort();
}

/**
 * Lê as chaves top-level do objeto `COUNTRY_FEATURES_MANIFEST` — todas no
 * formato `'namespace:nome'` (o `:` no nome é o que distingue uma chave
 * top-level de um país aninhado como `AR:`/`BR:`, que nunca tem `:` no nome).
 */
export function featureKeysFromManifest(ts) {
  const marcador = 'COUNTRY_FEATURES_MANIFEST: CountryFeatureManifest = {';
  const inicio = ts.indexOf(marcador);
  if (inicio < 0) throw new Error('COUNTRY_FEATURES_MANIFEST não encontrado no manifest');
  const fim = ts.indexOf('\n};', inicio);
  if (fim < 0) throw new Error('fechamento do COUNTRY_FEATURES_MANIFEST não encontrado');
  const bloco = ts.slice(inicio, fim);
  const keys = new Set();
  for (const m of bloco.matchAll(/'([a-z]+:[a-z0-9.-]+)':\s*\{/g)) {
    keys.add(m[1]);
  }
  return [...keys].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cells = cellsFromSeed(readFileSync(SEED_PATH, 'utf8'));
  writeFileSync(FIXTURE_PATH, JSON.stringify({ source: '206_permissions_iam_foundation.sql', cells }, null, 2) + '\n');
  console.log(`${cells.length} células → ${FIXTURE_PATH}`);

  const keys = featureKeysFromManifest(readFileSync(MANIFEST_PATH, 'utf8'));
  writeFileSync(
    FEATURE_FIXTURE_PATH,
    JSON.stringify({ source: 'country-features.manifest.ts', keys }, null, 2) + '\n',
  );
  console.log(`${keys.length} chaves de feature → ${FEATURE_FIXTURE_PATH}`);
}
