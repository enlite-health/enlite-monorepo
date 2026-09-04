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

// Chave `namespace:nome` — mesmo padrão de `screenFeatureMap.ts`, mas SEM
// restringir a minúscula: uma chave em caixa errada tem que ser CAPTURADA
// (pra cair como órfã no manifest, vermelho de verdade) em vez de escapar
// do regex e passar batido.
const RE_CHAVE = '[a-zA-Z]+:[a-zA-Z0-9._-]+';
const RE_USE_FEATURE_LITERAL = new RegExp(`useFeature\\(\\s*(["'])(${RE_CHAVE})\\1`, 'g');
const RE_FEATURE_ATTR_LITERAL = new RegExp(`feature=(["'])(${RE_CHAVE})\\1`, 'g');
const RE_USE_FEATURE_NAO_LITERAL = /useFeature\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\)/g;
const RE_FEATURE_ATTR_NAO_LITERAL = /feature=\{\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\}/g;

/**
 * `feature` — o nome do parâmetro que `FeatureGate.tsx`/`FeatureRouteGate.tsx`
 * recebem e repassam a `useFeature(feature)`; não é uma chave hardcoded, é o
 * forward do próprio prop (mesmo espírito do `resource` em `ActionButton.tsx`
 * pro `ui-gate-debt.test.ts`) — não conta como "chave não-literal".
 */
const IDENTIFICADOR_DE_FORWARD = 'feature';

interface AchadosFront {
  /** chave → arquivos onde aparece literal. */
  usos: Map<string, string[]>;
  /** `useFeature(CONST)` / `feature={CONST}` — chave que não dá pra achar por grep. */
  naoLiterais: string[];
}

/**
 * Chaves em `useFeature('k'|"k")` / `feature="k"|'k'` (FeatureGate e
 * FeatureRouteGate usam a mesma prop) — aspas simples OU duplas, qualquer
 * caixa. `useFeature(CONST)`/`feature={CONST}` (chave por constante, não
 * literal) vira achado em `naoLiterais` em vez de ser ignorado em silêncio.
 */
function chavesDoFront(): AchadosFront {
  const usos = new Map<string, string[]>();
  const naoLiterais: string[] = [];
  for (const f of arquivosTs(SRC)) {
    const texto = readFileSync(f, 'utf8');
    const rel = f.replace(SRC, 'src');

    for (const m of texto.matchAll(RE_USE_FEATURE_LITERAL)) {
      usos.set(m[2], [...(usos.get(m[2]) ?? []), rel]);
    }
    for (const m of texto.matchAll(RE_FEATURE_ATTR_LITERAL)) {
      usos.set(m[2], [...(usos.get(m[2]) ?? []), rel]);
    }
    for (const m of texto.matchAll(RE_USE_FEATURE_NAO_LITERAL)) {
      if (m[1] === IDENTIFICADOR_DE_FORWARD) continue;
      naoLiterais.push(`chave não-literal em ${rel}: useFeature(${m[1]})`);
    }
    for (const m of texto.matchAll(RE_FEATURE_ATTR_NAO_LITERAL)) {
      if (m[1] === IDENTIFICADOR_DE_FORWARD) continue;
      naoLiterais.push(`chave não-literal em ${rel}: feature={${m[1]}}`);
    }
  }
  return { usos, naoLiterais };
}

describe('paridade front × manifest das chaves de feature', () => {
  it('o front nomeia ao menos uma chave — senão a régua não mede nada', () => {
    expect(chavesDoFront().usos.size).toBeGreaterThan(0);
  });

  it('🔴 toda chave nomeada no front existe no manifest', () => {
    const orfas = [...chavesDoFront().usos].filter(([chave]) => !CHAVES.has(chave));
    expect(orfas, `chaves sem entrada no manifest: ${JSON.stringify(orfas)}`).toEqual([]);
  });

  it('🔴 nenhuma chave dinâmica (constante, não literal) fora do forward de prop conhecido', () => {
    const { naoLiterais } = chavesDoFront();
    expect(naoLiterais, JSON.stringify(naoLiterais, null, 2)).toEqual([]);
  });

  it('o fixture é o manifest, não uma cópia envelhecida (monorepo)', () => {
    if (!existsSync(MANIFEST_PATH)) {
      console.warn(`[paridade] manifest não encontrado em ${MANIFEST_PATH}; a régua 2 não rodou`);
      return;
    }
    expect(featureKeysFromManifest(readFileSync(MANIFEST_PATH, 'utf8'))).toEqual(fixture.keys);
  });
});
