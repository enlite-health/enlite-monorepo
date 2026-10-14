/**
 * Varredura de 2ª implementação (spec 052, Fase 3, T-37b).
 *
 * O enquadre reaproveita as peças da admissão INSTANCIANDO-AS de novo com outra configuração.
 * Copiar uma delas para "adaptar ao enquadre" criaria duas verdades. Cada peça abaixo tem de estar
 * definida EXATAMENTE 1× em `src` (fora de teste). 0× também reprova: a peça foi renomeada ou
 * movida e a varredura deixou de enxergá-la (contagem zero é "não medi").
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..');

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      listSources(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const PECAS: ReadonlyArray<{ nome: string; definicao: RegExp }> = [
  { nome: 'class GcsTranscriptVault', definicao: /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+GcsTranscriptVault\b/m },
  { nome: 'class AdmissionTranscriptReader', definicao: /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+AdmissionTranscriptReader\b/m },
  {
    nome: 'class VertexAdmissionSummaryGenerator',
    definicao: /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+VertexAdmissionSummaryGenerator\b/m,
  },
  { nome: 'function decideMatch', definicao: /^\s*(export\s+)?(async\s+)?function\s+decideMatch\b|^\s*(export\s+)?const\s+decideMatch\s*=/m },
  {
    nome: 'function titleHasExactCode',
    definicao: /^\s*(export\s+)?(async\s+)?function\s+titleHasExactCode\b|^\s*(export\s+)?const\s+titleHasExactCode\s*=/m,
  },
];

describe('varredura de 2ª implementação (spec 052)', () => {
  const arquivos = listSources(SRC);

  it('controle positivo: a varredura enxerga arquivos de src', () => {
    expect(arquivos.length).toBeGreaterThan(100);
  });

  it.each(PECAS)('$nome está definida exatamente 1× em src (fora de teste)', ({ nome, definicao }) => {
    const achados = arquivos
      .filter((f) => definicao.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect({ nome, achados: achados.length, onde: achados }).toEqual({ nome, achados: 1, onde: achados });
  });
});
