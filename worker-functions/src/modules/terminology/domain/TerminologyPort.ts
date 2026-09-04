/**
 * TerminologyPort — spec 016, "Contrato de arquitetura" (D258, pedido explícito do Gabriel:
 * "quero deixar toda essa parte do CID encapsulada... seja fácil [trocar]").
 *
 * Regra dura: SÓ a porta, o adaptador e a migration conhecem CID-11/OMS. Este arquivo não
 * importa NADA de infraestrutura (sem `pg`, sem `axios`, sem HTTP) e não deixa vazar nenhum tipo
 * do JSON da OMS (`destinationEntities`, `theCode`, `bestMatchText` morrem no adaptador). Os
 * tipos abaixo são NOSSOS — quem consome a porta (caso de uso, controller, tela) não sabe que
 * existe OMS, release ou linearização por trás.
 *
 * Modelado nas operações do FHIR Terminology Service (relatorio.md §9.6): `search` ~ `$expand`,
 * `getByUri` ~ `$lookup` — troca de adaptador (SNOMED, um servidor real como Ontoserver/
 * Snowstorm) não deveria pedir reescrever quem consome.
 */

import type { IcdCode } from './IcdCode';

/** As três variações de entidade que o catálogo guarda (ver COMMENT da migration 323). */
export type IcdEntityKind = 'chapter' | 'stem' | 'extension';

/** Idioma em que o título é preferencialmente lido — nunca traduzido por nós (cláusula 1.2.3). */
export type IcdLanguage = 'es' | 'en';

/**
 * Resultado de busca — o suficiente para desenhar uma lista de candidatos na tela.
 *
 * 🔧 F1-CORREÇÃO D7: `code` é `IcdCode` (Value Object), não `string` crua. Antes desta correção
 * o VO existia mas era ÓRFÃO — nenhum código de produção o usava, e um código truncado
 * (`02.Z`) podia trafegar por aqui sem que nada detectasse. `IcdCode` valida no parse (na
 * fronteira do adaptador) e é imutável — não há como truncar depois de construído.
 */
export interface DiagnosisCandidate {
  readonly uri: string;
  readonly code: IcdCode;
  readonly title: string;
  readonly chapter: string;
}

/** Entidade completa — o suficiente para gravar um diagnóstico ou montar a ficha. */
export interface DiagnosisEntity {
  readonly uri: string;
  readonly code: IcdCode;
  readonly titleEs: string | null;
  readonly titleEn: string | null;
  readonly chapter: string;
  readonly release: string;
  readonly kind: IcdEntityKind;
  readonly isLeaf: boolean;
  readonly parentUri: string | null;
}

export interface Chapter {
  readonly code: string;
  readonly title: string;
}

/**
 * Bloco intermediário (entre capítulo e categoria). Opcional: blocos da OMS não têm `code`
 * próprio e por isso não são gravados em `terminology.icd_entities` (só entidades COM código —
 * é o que faz a contagem bater com o medido na F0/relatorio). `ancestorsOf` pode legitimamente
 * não resolver um bloco; ver NAO CONSEGUI do relatório da F1.
 */
export interface Block {
  readonly code: string;
  readonly title: string;
}

export interface SearchOptions {
  /** Filtro de capítulos (ex.: `['06', '08']`). Ausente/vazio = todos. Filtro de TELA (D259). */
  readonly chapters?: readonly string[];
  /** Idioma preferido do título retornado; cai para o outro se faltar. Default: 'es'. */
  readonly lang?: IcdLanguage;
  /** Máximo de candidatos. Default do adaptador. */
  readonly limit?: number;
  /** Inclui `kind='extension'` (capítulo X — não é diagnóstico) nos resultados. Default: false. */
  readonly includeExtensions?: boolean;
}

/**
 * A porta. `application/` depende SÓ desta interface (DIP) — nunca de `IcdCatalogTerminology`
 * nem de `IcdApiTerminology` concretos. A instância entra por construtor.
 *
 * 🔧 F1.5-CORREÇÃO C1 (D261, parecer do CTO) — `getByUri`/`ancestorsOf` ganham `asOfRelease?`.
 * PROVADO em transação: promover um release novo que não contém um `icd_uri` antigo faz
 * `getByUri(uri)` (sem argumento — resolve o release CORRENTE) devolver `null`
 * — a linha antiga continua na tabela, só inalcançável pela leitura sem release explícito.
 * A `spec.md` promete "diagnóstico gravado em 2026-01 continua legível quando o release virar
 * 2027-01" — falso sem este parâmetro. Sem `asOfRelease` (undefined): comportamento de HOJE,
 * retrocompatível (resolve o release corrente). Com `asOfRelease`: busca EXATAMENTE aquele
 * release, corrente ou não — é o que torna o diagnóstico do paciente (que grava `release` NA
 * LINHA, ver "Contrato de arquitetura") legível para sempre, mesmo depois de o release mudar.
 */
export interface TerminologyPort {
  search(query: string, opts?: SearchOptions): Promise<DiagnosisCandidate[]>;
  getByUri(uri: string, asOfRelease?: string): Promise<DiagnosisEntity | null>;
  ancestorsOf(uri: string, asOfRelease?: string): Promise<{ chapter: Chapter; block?: Block }>;
}
