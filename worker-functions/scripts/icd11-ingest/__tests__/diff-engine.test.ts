/**
 * diffCatalog — spec 016 F1: "o ingestor emite um DIFF (entrou/saiu/mudou de título) antes de
 * alguém promover o release". Trocar release é ato deliberado (relatorio.md §10) — este diff é
 * o que a pessoa lê ANTES de decidir promover.
 */
import { diffCatalog } from '../diff-engine';

function entity(uri: string, code: string, titleEs: string | null, titleEn: string | null = null) {
  return { icdUri: uri, code, titleEs, titleEn };
}

describe('diffCatalog', () => {
  it('conta como "entrou" uri presente no crawl e ausente no banco', () => {
    const crawled = new Map([['u1', entity('u1', 'C1', 'Título')]]);
    const stored = new Map<string, ReturnType<typeof entity>>();
    const diff = diffCatalog(crawled, stored);
    expect(diff).toMatchObject({ entered: 1, left: 0, changedTitle: 0, unchanged: 0 });
  });

  it('conta como "saiu" uri presente no banco e ausente no crawl', () => {
    const crawled = new Map<string, ReturnType<typeof entity>>();
    const stored = new Map([['u1', entity('u1', 'C1', 'Título')]]);
    const diff = diffCatalog(crawled, stored);
    expect(diff).toMatchObject({ entered: 0, left: 1, changedTitle: 0, unchanged: 0 });
  });

  it('conta como "mudou" uri presente nos dois com título diferente, e amostra o antes/depois', () => {
    const crawled = new Map([['u1', entity('u1', 'C1', 'Título Novo')]]);
    const stored = new Map([['u1', entity('u1', 'C1', 'Título Velho')]]);
    const diff = diffCatalog(crawled, stored);
    expect(diff.changedTitle).toBe(1);
    expect(diff.changedSamples).toEqual([{ icdUri: 'u1', code: 'C1', before: 'Título Velho', after: 'Título Novo' }]);
  });

  it('conta como "sem mudança" uri idêntica nos dois (es e en)', () => {
    const crawled = new Map([['u1', entity('u1', 'C1', 'Título', 'Title')]]);
    const stored = new Map([['u1', entity('u1', 'C1', 'Título', 'Title')]]);
    const diff = diffCatalog(crawled, stored);
    expect(diff).toMatchObject({ entered: 0, left: 0, changedTitle: 0, unchanged: 1 });
  });

  it('mudança só em title_en também conta como "mudou"', () => {
    const crawled = new Map([['u1', entity('u1', 'C1', 'ES', 'EN novo')]]);
    const stored = new Map([['u1', entity('u1', 'C1', 'ES', 'EN velho')]]);
    const diff = diffCatalog(crawled, stored);
    expect(diff.changedTitle).toBe(1);
  });

  it('respeita o limite de amostras sem deixar de contar corretamente o total', () => {
    const crawled = new Map(
      Array.from({ length: 5 }, (_, i) => [`u${i}`, entity(`u${i}`, `C${i}`, `Novo ${i}`)] as const),
    );
    const stored = new Map(
      Array.from({ length: 5 }, (_, i) => [`u${i}`, entity(`u${i}`, `C${i}`, `Velho ${i}`)] as const),
    );
    const diff = diffCatalog(crawled, stored, 2);
    expect(diff.changedTitle).toBe(5);
    expect(diff.changedSamples).toHaveLength(2);
  });

  it('amostra usa title_en quando title_es é nulo (buraco de tradução medido na F0)', () => {
    const crawled = new Map([['u1', entity('u1', 'C1', null, 'EN novo')]]);
    const stored = new Map([['u1', entity('u1', 'C1', null, 'EN velho')]]);
    const diff = diffCatalog(crawled, stored);
    expect(diff.changedSamples).toEqual([{ icdUri: 'u1', code: 'C1', before: 'EN velho', after: 'EN novo' }]);
  });

  it('catálogo vazio dos dois lados: tudo zero, sem lançar', () => {
    const diff = diffCatalog(new Map(), new Map());
    expect(diff).toMatchObject({ entered: 0, left: 0, changedTitle: 0, unchanged: 0, changedSamples: [] });
  });
});
