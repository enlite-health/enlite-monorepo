/**
 * classifyEntity — decide `kind` ('chapter' | 'stem' | 'extension') para uma entidade do CID-11.
 * Ver __tests__/classify-entity.test.ts. `classKind` vem da API; `rootChapterCode` é rastreado
 * pelo crawler durante a travessia (a API não devolve o capítulo no GET solto de uma entidade).
 */
import type { IcdEntityKind } from '../../src/modules/terminology/domain/TerminologyPort';

export interface ClassifyEntityInput {
  classKind: string;
  rootChapterCode: string;
}

export function classifyEntity({ classKind, rootChapterCode }: ClassifyEntityInput): IcdEntityKind {
  if (classKind === 'chapter') return 'chapter';
  if (rootChapterCode === 'X') return 'extension';
  return 'stem';
}
