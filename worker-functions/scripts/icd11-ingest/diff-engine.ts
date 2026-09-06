/**
 * diffCatalog — compara o que o crawler encontrou agora contra o que já está gravado, e reporta
 * CONTAGENS (entrou / saiu / mudou / sem mudança) — nunca decide sozinho o que fazer com isso.
 * Promover um release, ou apagar o que "saiu", é ato deliberado e separado (spec 016: "trocar
 * release nunca é automático"). Ver __tests__/diff-engine.test.ts.
 */
export interface DiffableEntity {
  icdUri: string;
  code: string;
  titleEs: string | null;
  titleEn: string | null;
}

export interface ChangedSample {
  icdUri: string;
  code: string;
  before: string | null;
  after: string | null;
}

export interface CatalogDiff {
  entered: number;
  left: number;
  changedTitle: number;
  unchanged: number;
  changedSamples: ChangedSample[];
}

const DEFAULT_SAMPLE_LIMIT = 10;

export function diffCatalog(
  crawled: ReadonlyMap<string, DiffableEntity>,
  stored: ReadonlyMap<string, DiffableEntity>,
  sampleLimit: number = DEFAULT_SAMPLE_LIMIT,
): CatalogDiff {
  let entered = 0;
  let changedTitle = 0;
  let unchanged = 0;
  const changedSamples: ChangedSample[] = [];

  for (const [uri, current] of crawled) {
    const previous = stored.get(uri);
    if (!previous) {
      entered++;
      continue;
    }
    const titleChanged = current.titleEs !== previous.titleEs || current.titleEn !== previous.titleEn;
    if (titleChanged) {
      changedTitle++;
      if (changedSamples.length < sampleLimit) {
        changedSamples.push({
          icdUri: uri,
          code: current.code,
          before: previous.titleEs ?? previous.titleEn,
          after: current.titleEs ?? current.titleEn,
        });
      }
    } else {
      unchanged++;
    }
  }

  let left = 0;
  for (const uri of stored.keys()) {
    if (!crawled.has(uri)) left++;
  }

  return { entered, left, changedTitle, unchanged, changedSamples };
}
