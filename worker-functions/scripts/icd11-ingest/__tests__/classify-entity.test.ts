/**
 * classifyEntity — decide `kind` ('chapter' | 'stem' | 'extension') a partir do que a API da
 * OMS entrega (`classKind`) e do capítulo-raiz sob o qual o crawler encontrou a entidade
 * (rastreado durante o crawl — a API não devolve isso no GET solto de uma entidade, só no
 * `/search`; medido no spike: `curl .../mms/437815624/unspecified` não tem campo `chapter`).
 * Capítulo X = 17.160 códigos de extensão (medido na F0) — não são diagnóstico.
 */
import { classifyEntity } from '../classify-entity';

describe('classifyEntity', () => {
  it("classKind='chapter' vira kind='chapter', não importa o capítulo", () => {
    expect(classifyEntity({ classKind: 'chapter', rootChapterCode: '06' })).toBe('chapter');
    expect(classifyEntity({ classKind: 'chapter', rootChapterCode: 'X' })).toBe('chapter');
  });

  it("descendente do capítulo X vira kind='extension'", () => {
    expect(classifyEntity({ classKind: 'category', rootChapterCode: 'X' })).toBe('extension');
    expect(classifyEntity({ classKind: 'block', rootChapterCode: 'X' })).toBe('extension');
  });

  it("descendente de qualquer outro capítulo vira kind='stem'", () => {
    expect(classifyEntity({ classKind: 'category', rootChapterCode: '06' })).toBe('stem');
    expect(classifyEntity({ classKind: 'block', rootChapterCode: '08' })).toBe('stem');
    expect(classifyEntity({ classKind: 'category', rootChapterCode: 'V' })).toBe('stem');
  });
});
