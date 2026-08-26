/**
 * Paridade front × back: toda célula que o FRONT nomeia existe no catálogo do BACK.
 *
 * Sem isto, um `useCellAccess('grupos')` com recurso inventado renderiza
 * `hidden` para todo mundo em produção, em silêncio — a falha mais cara da
 * regra por componente, porque parece "ninguém tem permissão" em vez de bug.
 *
 * Duas réguas, para não medir uma suposição contra ela mesma:
 *  1. literais do front ⊆ fixture;
 *  2. fixture == seed do backend (quando o SQL está ao lado, como no monorepo).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fixture from './fixtures/permission-catalog.json';
import { cellsFromSeed, SEED_PATH } from '../../scripts/sync-permission-catalog.mjs';

const SRC = resolve(__dirname, '..');
const CATALOGO = new Set<string>(fixture.cells);
const RECURSOS = new Set([...CATALOGO].map((c) => c.split(':')[0]));

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

/** Recursos nomeados por `useCellAccess('x')`, `<Gated resource="x">`, `<ActionButton resource="x">`. */
function recursosDoFront(): Map<string, string[]> {
  const usos = new Map<string, string[]>();
  const re = /(?:useCellAccess|useHasCell)\(\s*'([a-z0-9_]+)'|resource=["']([a-z0-9_]+)["']/g;
  for (const f of arquivosTs(SRC)) {
    const texto = readFileSync(f, 'utf8');
    for (const m of texto.matchAll(re)) {
      const r = m[1] ?? m[2];
      usos.set(r, [...(usos.get(r) ?? []), f.replace(SRC, 'src')]);
    }
  }
  return usos;
}

/** Células completas `x:y` em `useHasCell('x', 'y')`. */
function celulasDoFront(): Map<string, string[]> {
  const usos = new Map<string, string[]>();
  const re = /useHasCell\(\s*'([a-z0-9_]+)'\s*,\s*'([a-z0-9_]+)'/g;
  for (const f of arquivosTs(SRC)) {
    for (const m of readFileSync(f, 'utf8').matchAll(re)) {
      const c = `${m[1]}:${m[2]}`;
      usos.set(c, [...(usos.get(c) ?? []), f.replace(SRC, 'src')]);
    }
  }
  return usos;
}

describe('paridade front × back das células', () => {
  it('o front nomeia ao menos um recurso — senão a régua não mede nada', () => {
    expect(recursosDoFront().size).toBeGreaterThan(0);
  });

  it('🔴 todo recurso nomeado no front tem `:read` ou `:write` no catálogo do back', () => {
    const orfaos = [...recursosDoFront()].filter(([r]) => !RECURSOS.has(r));
    expect(orfaos, `recursos sem célula no back: ${JSON.stringify(orfaos)}`).toEqual([]);
  });

  it('🔴 toda célula completa nomeada no front existe no catálogo', () => {
    const orfaos = [...celulasDoFront()].filter(([c]) => !CATALOGO.has(c));
    expect(orfaos, `células inexistentes: ${JSON.stringify(orfaos)}`).toEqual([]);
  });

  it('o fixture é o seed do backend, não uma cópia envelhecida (monorepo)', () => {
    if (!existsSync(SEED_PATH)) {
      // Fora do monorepo não há como conferir — e dizer "passou" seria mentira.
      console.warn(`[paridade] seed não encontrado em ${SEED_PATH}; a régua 2 não rodou`);
      return;
    }
    expect(cellsFromSeed(readFileSync(SEED_PATH, 'utf8'))).toEqual(fixture.cells);
  });
});
