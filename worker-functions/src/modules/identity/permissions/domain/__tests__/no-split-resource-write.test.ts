/**
 * src/modules/identity/permissions/domain/__tests__/no-split-resource-write.test.ts
 *
 * Verificador ESTÁTICO da CLASSE do achado pós-#391 (spec 018, PR-8b): a rota
 * `activate-recruitment` declarava `permVacancy.require('vacancy', 'write')` —
 * `vacancy` é um recurso SPLITADO (`SPLIT_RESOURCES`), e `'write'` literal
 * escapou da migração porque o grep que a fez buscava só `perm\.require(`, não
 * `permVacancy\.require(` (nem qualquer outra variável do verificador).
 *
 * Este teste varre `worker-functions/src` INTEIRO (fora de `__tests__`) e falha
 * se QUALQUER chamada `<qualquer variável>.require(<recurso splitado>, 'write')`
 * existir — não importa o nome da variável do verificador (`perm`, `permVacancy`,
 * ou qualquer futura). `permission_management` é o ÚNICO recurso que continua
 * `write` por contrato (`SPLIT_RESOURCES` o exclui de propósito) e por isso não
 * é varrido por não estar no set.
 *
 * Por que estático e não e2e: não precisa do app de pé nem de rede — roda como
 * unit (`npx jest --maxWorkers=1`), rápido e sem custo de memória.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { SPLIT_RESOURCES } from '../PermissionCell';

const SRC_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..', 'src');

/** Arquivos `.ts`/`.tsx` sob `src/`, pulando qualquer diretório `__tests__`. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `<var>.require('<recurso>', 'write'` — a mesma forma da chamada real,
 * qualquer variável (`\s` casa quebra de linha, então guards formatados em
 * várias linhas também são achados).
 */
const REQUIRE_WRITE = /([A-Za-z_][A-Za-z0-9_]*)\.require\(\s*['"`]([a-zA-Z_]+)['"`]\s*,\s*['"`]write['"`]/g;

interface Achado {
  file: string;
  varName: string;
  resource: string;
}

function scan(): Achado[] {
  const achados: Achado[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(REQUIRE_WRITE)) {
      const [, varName, resource] = match;
      if (!SPLIT_RESOURCES.has(resource)) continue; // permission_management e outros não-splitados: `write` é o contrato
      achados.push({ file: relative(SRC_ROOT, file), varName, resource });
    }
  }
  return achados;
}

describe('classe do achado pós-#391 — nenhum recurso splitado fica `write` literal', () => {
  it('nenhuma chamada `<var>.require(<recurso splitado>, "write")` existe em src/ (qualquer variável verificadora)', () => {
    const achados = scan();
    const linhas = achados.map((a) => `${a.file} → ${a.varName}.require('${a.resource}', 'write')`);
    expect(linhas).toEqual([]);
  });

  it('a varredura realmente percorre arquivos (contagem > 0) — contagem zero é falha, não sucesso', () => {
    expect(listSourceFiles(SRC_ROOT).length).toBeGreaterThan(100);
  });
});
