/**
 * D1 (D268) — a catraca das células `:write`/`:delete` sem consumidor na UI.
 *
 * `useCellAccess`/`Gated`/`ActionButton` só existem de verdade quando algo os
 * chama — uma célula `:write` no catálogo do backend sem NENHUM consumidor
 * front é ou (a) dívida conhecida (F14, ver estado do plano) ou (b) uma
 * lacuna nova que ninguém decidiu aceitar. Este teste não deixa a diferença
 * silenciosa: falha se aparecer uma célula fora dos dois grupos.
 *
 * Consumo detectado (estático, via grep — mesmo espírito de
 * `permission-parity.test.ts`):
 *  - `useHasCell('recurso', 'write'|'delete')` literal — a ação exata;
 *  - `<ActionButton resource="recurso" ...>` — SEMPRE consome `:write`
 *    (ActionButton.tsx: "célula `:write` autoriza esta ação");
 *  - `<Gated resource="recurso" ... atLeast="write" ...>` — idem.
 *
 * "Contagem zero é falha, nunca sucesso" (CLAUDE.md): se a dívida chegar a
 * zero, o teste falha e obriga a olhar — zero aqui não é "consertamos tudo",
 * é sinal de instrumento morto até que a redução seja provada célula a célula.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import permissionFixture from './fixtures/permission-catalog.json';
import debtFile from './ui-gate-debt.json';

const SRC = resolve(__dirname, '..');

interface DebtEntry {
  cell: string;
  motivo: string;
}

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

/** Extrai os atributos de uma tag JSX de abertura (`<Nome attr1 attr2=".." ...>`), em blocos multilinha. */
function tagsAbertura(texto: string, nomeComponente: string): string[] {
  const re = new RegExp(`<${nomeComponente}\\b([^>]*)>`, 'gs');
  return [...texto.matchAll(re)].map((m) => m[1]);
}

/**
 * `resource="literal"` OU `resource={CONST_NAME}` — o 2º caso é como
 * `GroupDetailPage.tsx` de fato escreve (`resource={PANEL_RESOURCE}`).
 * `constantes` resolve o identificador para o valor, quando é uma constante
 * de string simples (`export const PANEL_RESOURCE = 'permission_management'`).
 */
function atributoResource(attrsTexto: string, constantes: Map<string, string>): string | null {
  const literal = attrsTexto.match(/\bresource=["']([a-z0-9_]+)["']/);
  if (literal) return literal[1];
  const viaConst = attrsTexto.match(/\bresource=\{([A-Z][A-Z0-9_]*)\}/);
  if (viaConst) return constantes.get(viaConst[1]) ?? null;
  return null;
}

function atributo(attrsTexto: string, nome: string): string | null {
  const m = attrsTexto.match(new RegExp(`\\b${nome}=["']([a-z0-9_]+)["']`));
  return m ? m[1] : null;
}

/** `export const NOME = 'valor';` (ou sem `export`) — para resolver `resource={NOME}`. */
function constantesDeString(arquivos: string[]): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const f of arquivos) {
    const texto = readFileSync(f, 'utf8');
    for (const m of texto.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*'([a-z0-9_]+)'/g)) {
      mapa.set(m[1], m[2]);
    }
  }
  return mapa;
}

/** As células `resource:action` com consumidor comprovado em src/. */
function celulasConsumidas(): Set<string> {
  const arquivos = arquivosTs(SRC);
  const constantes = constantesDeString(arquivos);
  const consumidas = new Set<string>();
  for (const f of arquivos) {
    const texto = readFileSync(f, 'utf8');

    for (const m of texto.matchAll(/useHasCell\(\s*'([a-z0-9_]+)'\s*,\s*'(write|delete)'\s*\)/g)) {
      consumidas.add(`${m[1]}:${m[2]}`);
    }

    for (const attrs of tagsAbertura(texto, 'ActionButton')) {
      const resource = atributoResource(attrs, constantes);
      if (resource) consumidas.add(`${resource}:write`);
    }

    for (const attrs of tagsAbertura(texto, 'Gated')) {
      const resource = atributoResource(attrs, constantes);
      const atLeast = atributo(attrs, 'atLeast');
      if (resource && atLeast === 'write') consumidas.add(`${resource}:write`);
    }
  }
  return consumidas;
}

const CELULAS_WRITE_DELETE = (permissionFixture.cells as string[]).filter(
  (c) => c.endsWith(':write') || c.endsWith(':delete'),
);
const DEBT: DebtEntry[] = (debtFile as { debt: DebtEntry[] }).debt;
const DEBT_POR_CELULA = new Map(DEBT.map((d) => [d.cell, d.motivo]));

describe('catraca — células :write/:delete sem consumidor na UI (D1/D268)', () => {
  const consumidas = celulasConsumidas();

  it('imprime o número de células em dívida — 0 é falha, não sucesso', () => {
    console.log(`[ui-gate-debt] ${DEBT.length} células em dívida de gate na UI`);
    expect(DEBT.length, 'dívida chegou a 0 — catraca parece instrumento morto, investigar antes de aceitar').toBeGreaterThan(0);
  });

  it('🔴 toda célula :write/:delete sem consumidor está no ui-gate-debt.json, com motivo', () => {
    const semConsumidorForaDoArquivo = CELULAS_WRITE_DELETE.filter(
      (cell) => !consumidas.has(cell) && !DEBT_POR_CELULA.has(cell),
    );
    expect(
      semConsumidorForaDoArquivo,
      `células sem consumidor E fora do ui-gate-debt.json: ${JSON.stringify(semConsumidorForaDoArquivo)}`,
    ).toEqual([]);
  });

  it('🔴 toda célula do ui-gate-debt.json continua SEM consumidor (arquivo não envelheceu)', () => {
    const entradasObsoletas = DEBT.filter((d) => consumidas.has(d.cell));
    expect(
      entradasObsoletas,
      `células que JÁ têm consumidor mas ainda constam como dívida: ${JSON.stringify(entradasObsoletas)}`,
    ).toEqual([]);
  });

  it('toda entrada do ui-gate-debt.json tem `motivo` não vazio', () => {
    const semMotivo = DEBT.filter((d) => !d.motivo || !d.motivo.trim());
    expect(semMotivo).toEqual([]);
  });

  it('sanity: `permission_management:write` (o único consumidor real hoje) não está no arquivo de dívida', () => {
    expect(consumidas.has('permission_management:write')).toBe(true);
    expect(DEBT_POR_CELULA.has('permission_management:write')).toBe(false);
  });
});
