/**
 * TESTE DE FRONTEIRA (task 2.1) — a amarra que mantém o módulo extraível para o
 * permission-service (D115 §7).
 *
 * Por que um teste e não só o `.eslintrc`: o override de `identity` desliga
 * `no-restricted-imports` dentro de `src/modules/identity/**`, então o ESLint é
 * cego justamente para o vizinho mais próximo — e, hoje, o worker-functions não
 * roda ESLint no CI (não há script nem dependência; o `.eslintrc` documenta a
 * intenção). Este teste roda na suíte que o CI já executa.
 *
 * Duas direções, porque quebram por motivos diferentes:
 *   1. o módulo importando outro módulo → a extração deixaria de ser um `git mv`;
 *   2. alguém de fora importando um SUBDIRETÓRIO do módulo → passaria a
 *      depender de detalhe interno em vez do contrato do barrel.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', '..', '..', '..'); // src/
const MODULE_DIR = join(__dirname, '..');
const IMPORT_RE = /(?:from|require\()\s*['"]([^'"]+)['"]/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_RE)].map((match) => match[1]);
}

describe('fronteira do módulo identity/permissions', () => {
  const moduleFiles = walk(MODULE_DIR);

  it('tem arquivos para analisar (o teste não pode passar por vazio)', () => {
    expect(moduleFiles.length).toBeGreaterThan(15);
  });

  it('NÃO importa de nenhum outro módulo de domínio — só `@shared`, libs e o próprio módulo', () => {
    const violations: string[] = [];
    for (const file of moduleFiles) {
      for (const specifier of importsOf(file)) {
        // `@modules/identity/permissions` é ele mesmo; qualquer outro `@modules/…` é violação.
        if (specifier.startsWith('@modules/') && !specifier.startsWith('@modules/identity/permissions')) {
          violations.push(`${relative(SRC, file)} → ${specifier}`);
        }
        // Import relativo que sobe para fora do módulo (`../../domain/EnliteRole`).
        if (specifier.startsWith('../')) {
          const resolved = join(file, '..', specifier);
          if (!resolved.startsWith(MODULE_DIR)) violations.push(`${relative(SRC, file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('só o barrel é importado de fora — ninguém alcança subdiretório do módulo', () => {
    const outsiders = walk(SRC).filter((file) => !file.startsWith(MODULE_DIR));
    const violations: string[] = [];
    for (const file of outsiders) {
      for (const specifier of importsOf(file)) {
        if (/@modules\/identity\/permissions\/.+/.test(specifier)) {
          violations.push(`${relative(SRC, file)} → ${specifier}`);
        }
        if (/(\.\.\/)+identity\/permissions\/.+/.test(specifier)) {
          violations.push(`${relative(SRC, file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
