#!/usr/bin/env node
/**
 * Gera `src/test/fixtures/permission-catalog.json` a partir do SEED do backend
 * (`worker-functions/migrations/206_permissions_iam_foundation.sql`).
 *
 * O fixture existe para o teste de paridade rodar sem o backend ao lado (CI do
 * front é outro job). Mas ele NÃO é fonte: o próprio teste, quando acha o SQL,
 * confere que o fixture ainda é igual ao seed — senão seria comparar duas
 * cópias da mesma suposição.
 *
 * Uso: `node scripts/sync-permission-catalog.mjs`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SEED_PATH = resolve(here, '../../worker-functions/migrations/206_permissions_iam_foundation.sql');
export const FIXTURE_PATH = resolve(here, '../src/test/fixtures/permission-catalog.json');

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cells = cellsFromSeed(readFileSync(SEED_PATH, 'utf8'));
  writeFileSync(FIXTURE_PATH, JSON.stringify({ source: '206_permissions_iam_foundation.sql', cells }, null, 2) + '\n');
  console.log(`${cells.length} células → ${FIXTURE_PATH}`);
}
