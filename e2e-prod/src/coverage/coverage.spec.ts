/**
 * META-TESTE DE COBERTURA — o "gate da garantia".
 *
 * Não abre browser: é um teste Node puro (fs/path) que cruza o FLOW-MAP (denominador,
 * `user-facing-routes.ts`) contra as tags `@route:` declaradas nos títulos dos specs
 * (numerador). É o que transforma "todos os fluxos testados" de alegação em EVIDÊNCIA
 * determinística e versionada.
 *
 * O que ele protege:
 *  - REGRESSÃO: se um spec coberto some (ou perde a tag), a rota deixa de aparecer como
 *    coberta → com enforcement ligado, build vermelho.
 *  - TAG ÓRFÃ: um `@route:` que não casa com nenhuma rota do flow-map (typo ou rota
 *    removida do app mas ainda "testada") → SEMPRE falha, independente de enforcement.
 *
 * Nota sobre o regex: as tags de API têm espaço (`@route:GET /health`), então capturamos
 * TODO o conteúdo entre `@route:` e o `]` de fechamento e damos trim — `[^\]\s]+` cortaria
 * no espaço e transformaria toda rota de API em órfã.
 *
 * PROFUNDIDADE (`@depth:`): uma tag pode carregar `[@route:GET /x @depth:auth]`. O `@depth:`
 * vive DENTRO do mesmo colchete, então o capture `[^\]]+` engole ` @depth:auth` junto da rota.
 * Por isso, ao parsear, separamos os dois: removemos `@depth:<x>` do texto e trimamos pra obter
 * a ROTA limpa (senão `GET /x @depth:auth` nunca casaria o flow-map → falso-órfã). O `@depth:`
 * alimenta um breakdown (quantas rotas provadas por auth/error/smoke/happy) — sem alterar o
 * gate de cobertura em si (que continua sendo rota-coberta-ou-não).
 */
import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USER_FACING_ROUTES,
  type RouteSurface,
  type UserFacingRoute,
} from './user-facing-routes';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..', '..');
const SPEC_DIRS = ['smoke', 'regression', 'admin'].map((d) => join(PROJECT_ROOT, d));
const SPEC_SUFFIXES = ['.smoke.ts', '.regression.ts', '.spec.ts', '.admin.ts'];
const ROUTE_TAG_RE = /@route:([^\]]+)/g;

/** Anda a árvore e devolve todos os arquivos de spec (por sufixo) sob os dirs dados. */
function collectSpecFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (SPEC_SUFFIXES.some((s) => entry.endsWith(s))) {
        out.push(full);
      }
    }
  };
  dirs.forEach(walk);
  return out;
}

/** Uma tag `@route:` parseada: rota limpa + profundidade opcional (`@depth:`). */
interface ParsedTag {
  route: string;
  depth?: string;
}

const DEPTH_RE = /@depth:(\w+)/;

/** Extrai as tags `@route:` de um conjunto de specs, separando rota × profundidade. */
function extractParsedTags(files: string[]): ParsedTag[] {
  const out: ParsedTag[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(ROUTE_TAG_RE)) {
      const raw = m[1];
      if (!raw) continue;
      const depth = raw.match(DEPTH_RE)?.[1];
      // Remove o fragmento @depth:<x> e trima → rota pura, que casa o flow-map byte-a-byte.
      const route = raw.replace(DEPTH_RE, '').trim();
      if (route) out.push({ route, depth });
    }
  }
  return out;
}

const SURFACES: readonly RouteSurface[] = ['public', 'worker', 'admin', 'api'];

const specFiles = collectSpecFiles(SPEC_DIRS);
const parsedTags = extractParsedTags(specFiles);
// Set de ROTAS limpas — backward-compat com toda a lógica de cobertura abaixo.
const tags = new Set(parsedTags.map((t) => t.route));

const routeStrings = new Set(USER_FACING_ROUTES.map((r) => r.route));
const isCovered = (r: UserFacingRoute): boolean => tags.has(r.route);
const inDenominator = (r: UserFacingRoute): boolean => !r.excluded;

// Tags que não casam com NENHUMA rota do flow-map = órfãs (typo / rota removida).
const orphanTags = [...tags].filter((t) => !routeStrings.has(t)).sort();

test('cobertura de fluxos user-facing (gate)', () => {
  // ─────────────────────────────── TABELA ────────────────────────────────
  const lines: string[] = [];
  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════════╗');
  lines.push('║  COBERTURA DE FLUXOS USER-FACING (flow-map × specs @route:)         ║');
  lines.push('╚══════════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push('  surface     | total | covered | todo | excluded');
  lines.push('  ------------|-------|---------|------|---------');

  let denomTotal = 0;
  let denomCovered = 0;

  for (const surface of SURFACES) {
    const all = USER_FACING_ROUTES.filter((r) => r.surface === surface);
    const denom = all.filter(inDenominator);
    const covered = denom.filter(isCovered);
    const excluded = all.filter((r) => !!r.excluded);
    const todo = denom.length - covered.length;
    denomTotal += denom.length;
    denomCovered += covered.length;
    lines.push(
      `  ${surface.padEnd(11)} | ${String(denom.length).padStart(5)} | ` +
        `${String(covered.length).padStart(7)} | ${String(todo).padStart(4)} | ` +
        `${String(excluded.length).padStart(8)}`,
    );
  }

  const pct = denomTotal === 0 ? 0 : Math.round((denomCovered / denomTotal) * 100);
  const excludedTotal = USER_FACING_ROUTES.filter((r) => !!r.excluded).length;
  lines.push('  ------------|-------|---------|------|---------');
  lines.push(
    `  ${'TOTAL'.padEnd(11)} | ${String(denomTotal).padStart(5)} | ` +
      `${String(denomCovered).padStart(7)} | ${String(denomTotal - denomCovered).padStart(4)} | ` +
      `${String(excludedTotal).padStart(8)}`,
  );
  lines.push('');
  lines.push(`  COBERTURA GERAL: ${pct}%  (${denomCovered}/${denomTotal} rotas; excluídas: ${excludedTotal} fora do denominador)`);

  // Detalhe por tier (útil pra decidir quando ligar ENFORCE_COVERAGE=smoke → =all)
  const smokeDenom = USER_FACING_ROUTES.filter((r) => inDenominator(r) && r.tier === 'smoke');
  const smokeCovered = smokeDenom.filter(isCovered);
  const regDenom = USER_FACING_ROUTES.filter((r) => inDenominator(r) && r.tier === 'regression');
  const regCovered = regDenom.filter(isCovered);
  lines.push(`  por tier → smoke: ${smokeCovered.length}/${smokeDenom.length} | regression: ${regCovered.length}/${regDenom.length}`);
  lines.push('');
  lines.push(`  specs varridos: ${specFiles.length} | tags @route: distintas: ${tags.size}`);

  // ───────────────────── BREAKDOWN POR PROFUNDIDADE (@depth:) ─────────────────
  // Quantas ROTAS distintas são exercitadas em cada profundidade de prova. Uma rota
  // pode aparecer em mais de uma (ex.: /vacantes/:id tem smoke + error). 'sem depth'
  // = specs antigos que ainda não anotaram @depth: (não é erro, só não classificado).
  const KNOWN_DEPTHS = ['smoke', 'auth', 'error', 'happy'] as const;
  const routesByDepth = new Map<string, Set<string>>();
  KNOWN_DEPTHS.forEach((d) => routesByDepth.set(d, new Set<string>()));
  const noDepthRoutes = new Set<string>();
  const unknownDepth = new Map<string, Set<string>>();
  for (const t of parsedTags) {
    if (!t.depth) {
      noDepthRoutes.add(t.route);
    } else if (routesByDepth.has(t.depth)) {
      routesByDepth.get(t.depth)!.add(t.route);
    } else {
      if (!unknownDepth.has(t.depth)) unknownDepth.set(t.depth, new Set());
      unknownDepth.get(t.depth)!.add(t.route);
    }
  }
  lines.push('');
  lines.push('  profundidade (rotas distintas provadas em cada @depth:)');
  lines.push('  ------------|--------');
  for (const d of KNOWN_DEPTHS) {
    lines.push(`  ${d.padEnd(11)} | ${String(routesByDepth.get(d)!.size).padStart(6)}`);
  }
  for (const [d, set] of [...unknownDepth.entries()].sort()) {
    lines.push(`  ${`${d}?`.padEnd(11)} | ${String(set.size).padStart(6)}  (@depth: desconhecido)`);
  }
  lines.push(`  ${'(sem depth)'.padEnd(11)} | ${String(noDepthRoutes.size).padStart(6)}`);

  const missingSmoke = smokeDenom.filter((r) => !isCovered(r)).map((r) => r.route);
  const missingReg = regDenom.filter((r) => !isCovered(r)).map((r) => r.route);
  if (missingSmoke.length) {
    lines.push('');
    lines.push(`  TODO smoke (${missingSmoke.length}): ${missingSmoke.join(', ')}`);
  }
  if (missingReg.length) {
    lines.push('');
    lines.push(`  TODO regression (${missingReg.length}): ${missingReg.join(', ')}`);
  }
  lines.push('');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));

  // ───────────────────── ASSERT 1: sem tag órfã (SEMPRE) ──────────────────
  // Protege contra typo na tag ou spec cobrindo rota que não existe mais no flow-map.
  expect(
    orphanTags,
    orphanTags.length
      ? `Tags @route: órfãs (não casam com nenhuma rota do flow-map — typo ou rota removida?): ${orphanTags.join(', ')}`
      : 'sem órfãs',
  ).toEqual([]);

  // ───────────── ASSERT 2: enforcement por ratchet (env-controlado) ───────
  // OFF por default → só reporta (build não fica vermelho enquanto construímos).
  const enforce = (process.env.ENFORCE_COVERAGE ?? '').toLowerCase();
  if (enforce === 'all') {
    const missing = USER_FACING_ROUTES.filter((r) => inDenominator(r) && !isCovered(r)).map((r) => r.route);
    expect(
      missing,
      missing.length ? `ENFORCE_COVERAGE=all: rotas sem cobertura: ${missing.join(', ')}` : 'ok',
    ).toEqual([]);
  } else if (enforce === 'smoke') {
    expect(
      missingSmoke,
      missingSmoke.length ? `ENFORCE_COVERAGE=smoke: rotas smoke sem cobertura: ${missingSmoke.join(', ')}` : 'ok',
    ).toEqual([]);
  }
  // ausente/off → nenhum assert de enforcement (report-only).
});
