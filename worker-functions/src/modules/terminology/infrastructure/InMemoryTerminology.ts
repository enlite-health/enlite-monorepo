/**
 * InMemoryTerminology — FAKE que implementa `TerminologyPort` (spec 016, "Contrato de
 * arquitetura": "trocar o adaptador por um fake em memória e a suíte inteira continuar verde
 * sem tocar em domínio, aplicação ou tela"). Usado em teste — nunca em produção.
 *
 * A tolerância a erro de digitação (US-1) usa uma similaridade de trigramas própria, em JS puro
 * — não é o `pg_trgm` do Postgres, mas cumpre o MESMO contrato comportamental (LSP): a mesma
 * bateria de teste (ver tests/e2e/terminology-port-contract.e2e.test.ts) passa nos dois.
 *
 * 🔧 F1-CORREÇÕES (D3/D4, 03/09): o CONTRATO da porta (não só o adaptador Postgres) exige que um
 * catálogo vazio (nenhuma entidade carregada) falhe VISÍVEL — `TerminologyUnavailableError` —
 * nunca `[]` silencioso (US-4). Antes, o fake sempre "funcionava" mesmo vazio, o que deixava o
 * teste de contrato provar a garantia SÓ no adaptador real — exatamente o vazamento de
 * abstração que o "Contrato de arquitetura" da spec proíbe (LSP: "se só passa no real, a
 * abstração vazou"). O piso de 2 caracteres (D4) é o mesmo do adaptador real.
 *
 * 🔧 F1.5-CORREÇÃO C1 (D261): `getByUri`/`ancestorsOf` ganham `asOfRelease?` — o teste de
 * contrato do C1 roda a MESMA prova (release-aware) nos DOIS adaptadores, e por isso o fake
 * precisou ganhar uma noção de "release corrente" que ele nunca teve (documentado como limite
 * conhecido no `describe` do D2, em `terminology-port-contract.e2e.test.ts`: "o fake não tem
 * noção de release corrente" — isso deixa de ser inteiramente verdade agora, só para
 * `getByUri`/`ancestorsOf`; `search()` continua sem essa noção, D2 segue Postgres-only).
 * Retrocompatibilidade: o 2º parâmetro do construtor é OPCIONAL — nenhum teste existente o
 * passa, e sem ele o fake se comporta EXATAMENTE como antes (última entidade de um uri repetido
 * "ganha", sem filtrar por release nenhum — o mesmo "não tem conceito de release corrente" de
 * sempre). Todas as entidades passadas ficam disponíveis via `asOfRelease` explícito, current
 * release ou não.
 */
import type {
  TerminologyPort,
  DiagnosisCandidate,
  DiagnosisEntity,
  Chapter,
  Block,
  SearchOptions,
} from '../domain/TerminologyPort';
import { TerminologyUnavailableError } from '../domain/UnavailableTerminology';

const DEFAULT_SIMILARITY_THRESHOLD = 0.3;
/** D4 — mesmo piso do adaptador real (IcdCatalogTerminology). */
const MIN_QUERY_LENGTH = 2;

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s}  `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/**
 * Aproximação de `similarity()`/`word_similarity()` do pg_trgm: interseção de trigramas / união.
 * Sem guarda de "conjunto vazio": `trigrams()` sempre preenche a string com dois espaços de
 * cada lado antes de fatiar, então o conjunto resultante nunca é vazio (mesmo para `''`) — e por
 * extensão `union` nunca é 0. Guardar os dois seria código morto (branch inalcançável); a
 * simplificação é deliberada, não descuido.
 */
function trigramSimilarity(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  let common = 0;
  for (const g of ga) if (gb.has(g)) common++;
  const union = ga.size + gb.size - common;
  return common / union;
}

function matchesQuery(query: string, title: string | null, threshold: number): boolean {
  if (!title) return false;
  const normTitle = normalize(title);
  const normQuery = normalize(query);
  if (normQuery.length === 0) return false;
  if (normTitle.includes(normQuery)) return true;
  const words = normTitle.split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => trigramSimilarity(normQuery, w) >= threshold);
}

function pickTitle(entity: DiagnosisEntity, lang: 'es' | 'en'): string {
  const primary = lang === 'en' ? entity.titleEn : entity.titleEs;
  const fallback = lang === 'en' ? entity.titleEs : entity.titleEn;
  return primary ?? fallback ?? '';
}

/** C1 — opções do construtor do fake. Ver cabeçalho do arquivo. */
export interface InMemoryTerminologyOptions {
  /**
   * Release que `getByUri`/`ancestorsOf` SEM `asOfRelease` devem enxergar — o equivalente, no
   * fake, do `icd_releases.is_current` do adaptador real. Omitido (undefined): comportamento de
   * SEMPRE (retrocompatível) — "sem asOfRelease" cai no mapa por-uri (última entidade daquele
   * uri passada ao construtor), sem filtrar por release nenhum.
   */
  readonly currentRelease?: string;
}

export class InMemoryTerminology implements TerminologyPort {
  private readonly byUri = new Map<string, DiagnosisEntity>();
  /** C1 — TODAS as entidades, por `${uri}::${release}` — permite `asOfRelease` achar uma
   *  entidade de um release que não é (mais) o corrente, mesmo que `byUri` já tenha sido
   *  sobrescrito por uma entidade mais nova do mesmo uri. */
  private readonly byUriRelease = new Map<string, DiagnosisEntity>();
  private readonly currentRelease: string | null;

  constructor(entities: readonly DiagnosisEntity[] = [], opts: InMemoryTerminologyOptions = {}) {
    for (const e of entities) {
      this.byUri.set(e.uri, e);
      this.byUriRelease.set(`${e.uri}::${e.release}`, e);
    }
    this.currentRelease = opts.currentRelease ?? null;
  }

  /** D3 — mesma garantia do adaptador real: catálogo vazio (nada carregado) é falha, não `[]`/`null`. */
  private assertLoaded(): void {
    if (this.byUri.size === 0) {
      throw new TerminologyUnavailableError('catálogo vacío (fake sem entidades carregadas)');
    }
  }

  /**
   * C1 — resolve qual entidade uma leitura sem release explícito enxerga. Com `asOfRelease`:
   * busca EXATAMENTE aquele release (histórico ou corrente, tanto faz). Sem `asOfRelease`: se o
   * construtor recebeu `currentRelease`, filtra por ele (simula `is_current`); senão, cai no
   * comportamento de SEMPRE (`byUri`, sem noção de release) — retrocompatibilidade total com
   * todo teste que já existia antes do C1.
   */
  private resolveEntity(uri: string, asOfRelease?: string): DiagnosisEntity | undefined {
    if (asOfRelease !== undefined) return this.byUriRelease.get(`${uri}::${asOfRelease}`);
    if (this.currentRelease !== null) return this.byUriRelease.get(`${uri}::${this.currentRelease}`);
    return this.byUri.get(uri);
  }

  /** C1 — mesma resolução de `resolveEntity`, mas para achar um capítulo por código+release. */
  private findChapter(chapterCode: string, release: string): DiagnosisEntity | undefined {
    for (const e of this.byUriRelease.values()) {
      if (e.kind === 'chapter' && e.code.value === chapterCode && e.release === release) return e;
    }
    return undefined;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<DiagnosisCandidate[]> {
    // D4: piso de comprimento ANTES de checar o catálogo — "sem ir ao banco" no real vira "sem
    // nem olhar o Map" aqui; consulta curta/vazia devolve [] igual nos dois adaptadores.
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return [];

    this.assertLoaded();

    const lang = opts.lang ?? 'es';
    const includeExtensions = opts.includeExtensions ?? false;
    const chapters = opts.chapters;
    const limit = opts.limit ?? 50;

    const out: DiagnosisCandidate[] = [];
    for (const entity of this.byUri.values()) {
      if (entity.kind === 'chapter') continue;
      if (!includeExtensions && entity.kind === 'extension') continue;
      if (chapters && chapters.length > 0 && !chapters.includes(entity.chapter)) continue;

      const title = pickTitle(entity, lang);
      if (!matchesQuery(trimmed, title, DEFAULT_SIMILARITY_THRESHOLD)) continue;

      out.push({ uri: entity.uri, code: entity.code, title, chapter: entity.chapter });
      if (out.length >= limit) break;
    }
    return out;
  }

  async getByUri(uri: string, asOfRelease?: string): Promise<DiagnosisEntity | null> {
    this.assertLoaded();
    return this.resolveEntity(uri, asOfRelease) ?? null;
  }

  async ancestorsOf(uri: string, asOfRelease?: string): Promise<{ chapter: Chapter; block?: Block }> {
    this.assertLoaded();
    const entity = this.resolveEntity(uri, asOfRelease);
    if (!entity) {
      throw new Error(`IcdCode não encontrado no catálogo (fake): ${uri}`);
    }
    // C1 — resolve o capítulo NO MESMO release da entidade encontrada (histórico ou corrente):
    // `asOfRelease` explícito ganha; senão, o release da própria entidade já resolvida (que por
    // sua vez já refletiu `currentRelease` dentro de `resolveEntity`, se configurado).
    const release = asOfRelease ?? entity.release;
    const chapterEntity = this.findChapter(entity.chapter, release);
    if (!chapterEntity) {
      throw new Error(`Capítulo "${entity.chapter}" não está carregado no catálogo (fake, release ${release})`);
    }
    return { chapter: { code: chapterEntity.code.value, title: pickTitle(chapterEntity, 'es') } };
  }
}
