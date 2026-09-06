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

/**
 * 🔧 F5-CORREÇÃO T10 (QA-caça, 05/09/2026) — FONTE ÚNICA do piso de tamanho da consulta.
 *
 * O número vivia em TRÊS lugares com DOIS valores: `zod .min(1)` no schema da rota, e
 * `MIN_QUERY_LENGTH = 2` em cada adaptador. Efeito medido: `GET /search?q=a` respondia
 * `200 {"candidates":[]}` sem tocar o banco — "não perguntei" indistinguível de "não há", que é
 * exatamente a confusão que a US-4 proíbe. O piso é regra de CONTRATO da porta (todo adaptador
 * tem de honrá-lo, senão o fake e o real divergem), então mora aqui — e a rota o REJEITA com
 * 400 dizendo o piso, em vez de devolver lista vazia.
 */
export const MIN_SEARCH_QUERY_LENGTH = 2;

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
 * 🔧 F5-CORREÇÃO T3 (QA-caça, 05/09/2026) — `asOfRelease?` FOI REMOVIDO de `getByUri`/
 * `ancestorsOf`. Ele nasceu na F1.5 (C1/D261) para que "o diagnóstico do paciente não ficasse
 * INALCANÇÁVEL depois de promover release", e NENHUM chamador de produção jamais o passou:
 * `RecordPatientDiagnosis` chamava `getByUri(uri)` sem ele, e o `ancestorsOf(uri, entity.release)`
 * passava um release que já era o corrente por construção. Parâmetro com teste e zero consumidor
 * é declaração, não garantia.
 *
 * O que o tornou desnecessário foi consertar a CAUSA que ele contornava (T2): a URI da OMS
 * carrega o release no path, então "o release novo não tem esta URI" era quase sempre um
 * artefato da URI ter mudado, não do conceito ter sumido. Com `concept_key` (migration 328) a
 * identidade é estável entre releases, e `getByUri(uri)` volta a achar o MESMO conceito depois
 * de promover.
 *
 * E o diagnóstico já gravado continua legível pelo mecanismo que a migration 325 criou
 * exatamente para isso: a linha de `patient_diagnoses` carrega `concept_code`, `concept_title`,
 * `concept_group` e `catalog_release` DESNORMALIZADOS — a ficha nunca reconsulta o catálogo.
 * Conceito genuinamente aposentado pela OMS continua existindo: quem avisa é a reconciliação de
 * `--promote` (T4), que CONTA quantos diagnósticos ativos e quantos mapeamentos do ClickUp
 * deixariam de resolver — um relatório vivo no lugar de um parâmetro morto.
 */
export interface TerminologyPort {
  search(query: string, opts?: SearchOptions): Promise<DiagnosisCandidate[]>;
  getByUri(uri: string): Promise<DiagnosisEntity | null>;
  ancestorsOf(uri: string): Promise<{ chapter: Chapter; block?: Block }>;
}
