/**
 * Paridade front × manifest: toda chave que o FRONT nomeia em `useFeature`/
 * `FeatureGate`/`FeatureRouteGate` existe em `COUNTRY_FEATURES_MANIFEST`.
 *
 * MESMO mecanismo do `permission-parity.test.ts` (B3/D268): fixture gerada por
 * `scripts/sync-permission-catalog.mjs` a partir da fonte real (não uma cópia
 * congelada), e o próprio teste confere que o fixture ainda bate com a fonte
 * quando ela está disponível ao lado (monorepo).
 *
 * Sem isto, uma chave inventada em `useFeature('screen:xx')` renderia
 * fail-OPEN pra sempre (missing-key) — silenciosamente "sempre ligado", o
 * oposto do que a régua por país deveria fazer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fixture from './fixtures/feature-catalog.json';
import { featureKeysFromManifest, MANIFEST_PATH } from '../../scripts/sync-permission-catalog.mjs';

const SRC = resolve(__dirname, '..');
const CHAVES = new Set<string>(fixture.keys);

function arquivosTs(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) {
      if (nome === '__tests__' || nome === 'test' || nome === 'fixtures') continue;
      arquivosTs(p, acc);
    } else if (/\.(ts|tsx)$/.test(nome) && !/\.test\.tsx?$/.test(nome)) {
      acc.push(p);
    }
  }
  return acc;
}

/** Chaves literais em `useFeature('k')` / `feature="k"` (FeatureGate e FeatureRouteGate usam a mesma prop). */
function chavesDoFront(): Map<string, string[]> {
  const usos = new Map<string, string[]>();
  const re = /useFeature\(\s*'([a-z]+:[a-z0-9.-]+)'|feature=["']([a-z]+:[a-z0-9.-]+)["']/g;
  for (const f of arquivosTs(SRC)) {
    const texto = readFileSync(f, 'utf8');
    for (const m of texto.matchAll(re)) {
      const chave = m[1] ?? m[2];
      usos.set(chave, [...(usos.get(chave) ?? []), f.replace(SRC, 'src')]);
    }
  }
  return usos;
}

describe('paridade front × manifest das chaves de feature', () => {
  it('o front nomeia ao menos uma chave — senão a régua não mede nada', () => {
    expect(chavesDoFront().size).toBeGreaterThan(0);
  });

  it('🔴 toda chave nomeada no front existe no manifest', () => {
    const orfas = [...chavesDoFront()].filter(([chave]) => !CHAVES.has(chave));
    expect(orfas, `chaves sem entrada no manifest: ${JSON.stringify(orfas)}`).toEqual([]);
  });

  it('o fixture é o manifest, não uma cópia envelhecida (monorepo)', () => {
    if (!existsSync(MANIFEST_PATH)) {
      console.warn(`[paridade] manifest não encontrado em ${MANIFEST_PATH}; a régua 2 não rodou`);
      return;
    }
    expect(featureKeysFromManifest(readFileSync(MANIFEST_PATH, 'utf8'))).toEqual(fixture.keys);
  });
});
