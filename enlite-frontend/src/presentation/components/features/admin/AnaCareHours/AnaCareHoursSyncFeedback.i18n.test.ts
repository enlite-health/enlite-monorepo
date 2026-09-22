/**
 * AnaCareHoursSyncFeedback.i18n.test.ts
 *
 * Tarefa 7.1 (change `anacare-horas-feedback-visual-sync`) — "termina quando: script/teste que
 * compara o conjunto de chaves sob o(s) namespace(s) usado(s) entre os dois arquivos falha se
 * houver assimetria". Cobre os DOIS namespaces que esta change tocou:
 *   - `admin.anacareHours.sync` (rótulo do botão durante a corrida + contagem "X de Y")
 *   - `admin.anacareHours.error.byCode` (tradução de erro por código, incl. `NETWORK_ERROR` novo)
 *
 * Comparação ESTRUTURAL (conjunto de chaves recursivo), não de conteúdo — es/pt-BR têm textos
 * diferentes de propósito, só o FORMATO (quais chaves existem) precisa bater. Prova de sabotagem
 * colada no relatório da task: `cp` de backup, nunca `git checkout --` (regra do repo).
 */
import { describe, it, expect } from 'vitest';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

type JsonRecord = Record<string, unknown>;

/** Conjunto de caminhos FOLHA (`a.b.c`) de um objeto aninhado — o "formato" comparável entre idiomas. */
function leafPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  const entries = Object.entries(obj as JsonRecord);
  return entries.flatMap(([key, value]) => leafPaths(value, prefix ? `${prefix}.${key}` : key));
}

function diff(a: string[], b: string[]): { onlyInA: string[]; onlyInB: string[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: a.filter((k) => !setB.has(k)).sort(),
    onlyInB: b.filter((k) => !setA.has(k)).sort(),
  };
}

describe('AnaCareHours — paridade i18n es × pt-BR (feedback visual do sync)', () => {
  it('admin.anacareHours.sync — mesmo conjunto de chaves nos dois idiomas', () => {
    const es = leafPaths(esJson.admin.anacareHours.sync);
    const ptBR = leafPaths(ptBRJson.admin.anacareHours.sync);
    const { onlyInA, onlyInB } = diff(es, ptBR);
    expect({ onlyInEs: onlyInA, onlyInPtBR: onlyInB }).toEqual({ onlyInEs: [], onlyInPtBR: [] });
  });

  it('admin.anacareHours.error.byCode — mesmo conjunto de chaves nos dois idiomas (inclui NETWORK_ERROR novo)', () => {
    const es = leafPaths(esJson.admin.anacareHours.error.byCode);
    const ptBR = leafPaths(ptBRJson.admin.anacareHours.error.byCode);
    const { onlyInA, onlyInB } = diff(es, ptBR);
    expect({ onlyInEs: onlyInA, onlyInPtBR: onlyInB }).toEqual({ onlyInEs: [], onlyInPtBR: [] });
  });

  it('as chaves novas desta change existem em AMBOS os idiomas (não só no conjunto simétrico)', () => {
    const expected = [
      'admin.anacareHours.sync.runningLabel',
      'admin.anacareHours.sync.progressCount',
      'admin.anacareHours.error.byCode.NETWORK_ERROR',
    ];
    for (const path of expected) {
      const parts = path.split('.');
      const readPath = (root: JsonRecord): unknown => parts.reduce<unknown>((acc, part) => (acc as JsonRecord | undefined)?.[part], root);
      expect(readPath(esJson as JsonRecord), `es.json não tem "${path}"`).toEqual(expect.any(String));
      expect(readPath(ptBRJson as JsonRecord), `pt-BR.json não tem "${path}"`).toEqual(expect.any(String));
    }
  });
});
