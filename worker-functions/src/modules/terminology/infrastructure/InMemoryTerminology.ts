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
 * abstração vazou"). O piso de caracteres (D4) é o mesmo do adaptador real.
 *
 * 🔧 F5-CORREÇÕES (QA-caça, 05/09/2026):
 * - T2 — o fake indexa por `conceptKey(uri)`, não pela URI crua, para cumprir o MESMO contrato
 *   do adaptador real: a URI da OMS carrega o release DENTRO do path, e o mesmo conceito muda de
 *   URI a cada release. Sem isto, a resolução estável entre releases estaria provada só no
 *   Postgres — "se só passa no real, a abstração vazou". Para URI sem segmento de release (a
 *   maioria das fixtures, `test://...`) a chave É a própria URI: nada muda para quem já usava.
 * - T3 — `asOfRelease?` saiu de `getByUri`/`ancestorsOf` (nenhum consumidor de produção jamais o
 *   passou; a causa que ele contornava era o T2 — ver o COMMENT do port). Com ele saiu o 2º
 *   parâmetro do construtor (`{ currentRelease }`), que existia SÓ para o teste do C1.
 * - T7 — as mensagens de erro do fake não nomeiam mais o conceito procurado: fake que "loga" o
 *   que o adaptador real não pode logar é convite a copiar o padrão errado.
 * - T10 — o piso de tamanho da consulta vem da porta (`MIN_SEARCH_QUERY_LENGTH`), fonte única.
 */
import {
  MIN_SEARCH_QUERY_LENGTH,
  type TerminologyPort,
  type DiagnosisCandidate,
  type DiagnosisEntity,
  type Chapter,
  type Block,
  type SearchOptions,
} from '../domain/TerminologyPort';
import { TerminologyUnavailableError } from '../domain/UnavailableTerminology';
import { conceptKey } from './conceptKey';

const DEFAULT_SIMILARITY_THRESHOLD = 0.3;

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

export class InMemoryTerminology implements TerminologyPort {
  /** T2 — indexado pela identidade ESTÁVEL do conceito, não pela URI crua. */
  private readonly byConceptKey = new Map<string, DiagnosisEntity>();

  constructor(entities: readonly DiagnosisEntity[] = []) {
    for (const e of entities) {
      this.byConceptKey.set(conceptKey(e.uri), e);
    }
  }

  /** D3 — mesma garantia do adaptador real: catálogo vazio (nada carregado) é falha, não `[]`/`null`. */
  private assertLoaded(): void {
    if (this.byConceptKey.size === 0) {
      throw new TerminologyUnavailableError('catálogo vacío (fake sem entidades carregadas)');
    }
  }

  /** T2 — a URI que CHEGA é normalizada pela MESMA regra da URI que foi indexada. */
  private resolveEntity(uri: string): DiagnosisEntity | undefined {
    return this.byConceptKey.get(conceptKey(uri));
  }

  /** Acha o capítulo de um código dentro de um release. */
  private findChapter(chapterCode: string, release: string): DiagnosisEntity | undefined {
    for (const e of this.byConceptKey.values()) {
      if (e.kind === 'chapter' && e.code.value === chapterCode && e.release === release) return e;
    }
    return undefined;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<DiagnosisCandidate[]> {
    // D4: piso de comprimento ANTES de checar o catálogo — "sem ir ao banco" no real vira "sem
    // nem olhar o Map" aqui; consulta curta/vazia devolve [] igual nos dois adaptadores.
    const trimmed = query.trim();
    if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) return [];

    this.assertLoaded();

    const lang = opts.lang ?? 'es';
    const includeExtensions = opts.includeExtensions ?? false;
    const chapters = opts.chapters;
    const limit = opts.limit ?? 50;

    const out: DiagnosisCandidate[] = [];
    for (const entity of this.byConceptKey.values()) {
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

  async getByUri(uri: string): Promise<DiagnosisEntity | null> {
    this.assertLoaded();
    return this.resolveEntity(uri) ?? null;
  }

  async ancestorsOf(uri: string): Promise<{ chapter: Chapter; block?: Block }> {
    this.assertLoaded();
    const entity = this.resolveEntity(uri);
    // T7 — a mensagem não nomeia o conceito procurado (nem URI, nem código).
    if (!entity) {
      throw new Error('Entidade não encontrada no catálogo de terminologia (fake)');
    }
    const chapterEntity = this.findChapter(entity.chapter, entity.release);
    if (!chapterEntity) {
      throw new Error('Capítulo da entidade não está carregado no catálogo (fake)');
    }
    return { chapter: { code: chapterEntity.code.value, title: pickTitle(chapterEntity, 'es') } };
  }
}
