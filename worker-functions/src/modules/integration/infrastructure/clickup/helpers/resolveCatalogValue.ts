/**
 * resolveCatalogValue — lê um campo de catálogo do ClickUp PELO TIPO QUE O CATÁLOGO DIZ,
 * em vez de pelo tipo que o código assumiu no dia em que foi escrito.
 *
 * ── POR QUE ESTE ARQUIVO EXISTE (defeito 1 do QA-caça da task 2.2) ───────────
 * O mapper lia `Segmentos Clínicos` com `resolveDropdown`, e o preflight da 1.11 exigia que
 * o campo fosse `drop_down` no catálogo. A Fase 2 (D-C) transforma exatamente esse campo em
 * MÚLTIPLO — `labels` no ClickUp. Medido pelo QA: no dia dessa virada, o preflight
 * classificava o campo como `wrong_type` e o sync de pacientes PARAVA POR COMPLETO (nenhuma
 * tarefa mapeada, nenhum paciente escrito), de forma muda na origem, porque o webhook
 * responde `HTTP 200 {"success":true}` com o `kind:'ERROR'` dentro.
 *
 * Alargar só o preflight seria pior que o defeito: o sync voltaria a rodar e
 * `resolveDropdown('Segmentos Clínicos', …)` não acharia mapa nenhum, devolveria `null` para
 * TODA tarefa e o `UPDATE ... = $11` apagaria o dado gravado, a cada re-sync, com log verde.
 * É o `null` que significa duas coisas (D167/F41) voltando pela porta que a 1.11 fechou.
 *
 * ⇒ O par obrigatório do preflight por-campo é ESTE despacho: quem declara que sabe ler os
 * dois formatos tem de, de fato, ler os dois.
 *
 * ── O QUE A 2ª RODADA DE QA REPROVOU AQUI, E O QUE MUDOU (rodada 3) ──────────
 * A 1ª versão deste arquivo tinha DOIS estados — `readable:true` e `readable:false` — e
 * classificava como LEITURA VÁLIDA E VAZIA (`{readable:true, labels:[]}`) o caso em que o
 * CAMPO existe mas NENHUMA das OPÇÕES resolve. O D167 renasceu um nível abaixo, dentro do
 * conserto que existe para fechá-lo: uma opção recriada no ClickUp (o uuid muda, o nome do
 * campo não) fazia `resolveLabels` devolver `[]`, e o chamador fiel à união apagava os
 * rótulos crus com `outcome:'written'`.
 *
 * A distinção que faltava tem PELO MENOS TRÊS estados, não dois:
 *
 *   1. **li e está vazio de verdade** — a origem não mandou nada. Apagar é CORRETO (D-E:
 *      vazio se escreve; congelado *parece* dado). → `{readable:true, labels:[]}`.
 *   2. **li e nenhuma/parte das opções resolveu** — a origem MANDOU valor e o catálogo não
 *      soube traduzir. NÃO é vazio. → `{readable:false, reason:'options_unresolved'}` ou
 *      `'options_partially_resolved'`.
 *   3. **não consegui ler** — o campo sumiu do catálogo ou mudou para um tipo que este
 *      leitor não conhece. → `{readable:false, reason:'missing'|'unsupported_type'}`.
 *
 * ⚠️ **O PARCIAL É RECUSA, não sucesso** (F39: *"o resolver descarta item a item e devolve
 * array menor — pediu 3, voltam 2, e array curto parece completo"*). Gravar os 2 que
 * resolveram APAGA o 3º: uma lista mais curta escrita por cima é perda, não atualização. Só
 * `resolved === requested` é leitura.
 *
 * Por isso os dois lados carregam `requested`/`resolved`: o invariante `readable === true ⇒
 * resolved === requested` é conferível de fora, e a contagem é o que a C1 permite em log.
 *
 * ── C1 do parecer do `lex` ───────────────────────────────────────────────────
 * Nada aqui emite valor de paciente. O que sai em log é nome do campo + tipo do catálogo +
 * CONTAGEM — o mesmo formato que `ClickUpFieldResolver` e `dropdownCatalogGuard` já usam.
 * O orderindex, o uuid da opção e o rótulo resolvido NÃO saem daqui.
 */

import type { ClickUpFieldResolver } from '../ClickUpFieldResolver';
import { asIndexable } from './asIndexable';

/**
 * Por que a leitura falhou. Metadado de schema/forma — NUNCA valor de paciente, e por isso
 * pode ir para linha de log (C1) e para a tabela de recusa.
 *
 *   `missing`                    — o catálogo não tem esse nome de campo.
 *   `unsupported_type`           — o catálogo tem, com um tipo que este leitor não lê.
 *   `value_not_indexable`        — a origem mandou algo que não é índice de opção (C5).
 *   `options_unresolved`         — a origem mandou N opções e NENHUMA resolveu.
 *   `options_partially_resolved` — a origem mandou N e resolveram 0 < M < N (F39).
 */
export type CatalogUnreadableReason =
  | 'missing'
  | 'unsupported_type'
  | 'value_not_indexable'
  | 'options_unresolved'
  | 'options_partially_resolved';

/** As razões que uma RELEITURA do catálogo pode, em princípio, resolver. */
export const REASONS_A_FRESH_CATALOG_CAN_SETTLE: readonly CatalogUnreadableReason[] = [
  'options_unresolved',
  'options_partially_resolved',
];

export type CatalogRead =
  /**
   * O catálogo declara um tipo que este leitor entende E todas as opções que a origem mandou
   * foram traduzidas. `labels: []` aqui é vazio LEGÍTIMO (`requested === 0`) — a origem não
   * mandou nada. Invariante: `resolved === requested`.
   */
  | { readable: true; catalogType: string; labels: string[]; requested: number; resolved: number }
  /**
   * O campo (ou o valor dele) não pôde ser lido. NUNCA confundir com vazio legítimo: quem
   * recebe isto não deve escrever nada (nem apagar), porque "não consegui ler" não é "está
   * vazio" (D167/F41), e "li metade" não é "a lista encolheu" (F39).
   */
  | {
      readable: false;
      catalogType: string | null;
      reason: CatalogUnreadableReason;
      requested: number;
      resolved: number;
    };

/** Os tipos de catálogo que ESTE leitor sabe interpretar. Declarar aqui é um compromisso. */
export const CATALOG_TYPES_SUPPORTED = ['drop_down', 'labels'] as const;

export interface ResolveCatalogValueOptions {
  /**
   * Emitir o aviso da leitura ilegível. `false` só para o SONDA — o detector de deriva da
   * 1.13 chama esta mesma função para descobrir que uma opção não resolve, e o aviso já sai
   * pelo caminho vivo (o mapper). Dois avisos para o mesmo fato é ruído, e ruído desliga
   * alarme (critério 9.4).
   */
  warn?: boolean;
}

/**
 * Devolve os rótulos de um campo de catálogo, despachando pelo tipo VIVO do catálogo.
 *
 *   `drop_down` → um rótulo no máximo (o orderindex resolvido), devolvido como lista de 0 ou 1;
 *   `labels`    → N rótulos (os uuids de opção resolvidos), na ordem em que a origem mandou.
 *
 * O chamador que só quer o valor único usa `labels[0] ?? null` — e é exatamente o que o
 * mapper faz para manter `patients.clinical_specialty` (o DERIVADO da D-B) inalterado no
 * mundo `drop_down` de hoje.
 */
export function resolveCatalogValue(
  resolver: Pick<ClickUpFieldResolver, 'getFieldType' | 'resolveDropdown' | 'resolveLabels'>,
  fieldName: string,
  raw: unknown,
  opts: ResolveCatalogValueOptions = {},
): CatalogRead {
  const deveAvisar = opts.warn !== false;
  const catalogType = resolver.getFieldType(fieldName);

  const ilegivel = (
    tipo: string | null,
    reason: CatalogUnreadableReason,
    requested: number,
    resolved: number,
  ): CatalogRead => {
    if (deveAvisar) warnUnreadable(fieldName, tipo, reason, requested, resolved);
    return { readable: false, catalogType: tipo, reason, requested, resolved };
  };

  const lido = (tipo: string, labels: string[], requested: number): CatalogRead =>
    ({ readable: true, catalogType: tipo, labels, requested, resolved: labels.length });

  if (catalogType === null) {
    return ilegivel(null, 'missing', 0, 0);
  }

  if (catalogType === 'drop_down') {
    // `null`/`undefined` é a ÚNICA forma de vazio legítimo medida na API (F40/F51: 1424 de
    // 1690 tarefas). `''`, `[]`, `false` e afins NÃO são vazio — são a porta de fabricação
    // que a C5 fechou, e tratá-los como "a origem não mandou nada" reabriria o apagamento.
    if (raw === null || raw === undefined) return lido(catalogType, [], 0);

    const idx = asIndexable(fieldName, raw);
    if (idx === null) return ilegivel(catalogType, 'value_not_indexable', 1, 0);

    const label = resolver.resolveDropdown(fieldName, idx);
    // Aqui morava metade do defeito 1: `label === null` virava `labels: []`, ou seja, "o
    // campo está vazio". A origem MANDOU um orderindex; o catálogo é que não o conhece.
    if (label === null) return ilegivel(catalogType, 'options_unresolved', 1, 0);

    return lido(catalogType, [label], 1);
  }

  if (catalogType === 'labels') {
    const { presente, ids, discarded } = asOptionIds(fieldName, raw, deveAvisar);
    const requested = ids.length + discarded;

    // Campo ausente da tarefa, ou array vazio: ninguém marcou nada. Vazio LEGÍTIMO.
    if (!presente || requested === 0) return lido(catalogType, [], 0);

    const resolvidos = ids.length === 0 ? [] : resolver.resolveLabels(fieldName, ids);

    if (resolvidos.length === 0) return ilegivel(catalogType, 'options_unresolved', requested, 0);
    // F39, e é o caso que o QA exigiu separar: pediu 3, voltam 2. Gravar os 2 APAGA o 3º.
    if (resolvidos.length < requested) {
      return ilegivel(catalogType, 'options_partially_resolved', requested, resolvidos.length);
    }

    return lido(catalogType, resolvidos, requested);
  }

  return ilegivel(catalogType, 'unsupported_type', 0, 0);
}

/**
 * O aviso da leitura ilegível. C1: nome do campo, tipo do catálogo, motivo ESTRUTURAL e
 * CONTAGEM. Nenhum uuid, nenhum orderindex, nenhum rótulo, nenhum paciente.
 *
 * Incondicional de propósito: uma lista "este campo é clínico?" vazaria em silêncio no dia
 * em que um campo clínico novo entrasse.
 */
function warnUnreadable(
  fieldName: string,
  catalogType: string | null,
  reason: CatalogUnreadableReason,
  requested: number,
  resolved: number,
): void {
  console.warn('[resolveCatalogValue] campo de catálogo ILEGÍVEL — nada deve ser escrito nem apagado (D167/F41):', {
    field: fieldName,
    catalogType,
    reason,
    requested,
    resolved,
  });
}

interface OptionIds {
  /** A origem trouxe a chave do campo (mesmo que com lista vazia)? */
  presente: boolean;
  /** Os itens que têm FORMA de id de opção. */
  ids: string[];
  /** Os itens que a origem mandou e que nem forma de id têm (C5). Contam como pedidos. */
  discarded: number;
}

/**
 * O valor de um campo `labels` do ClickUp é um array de uuid de opção. Lista de PERMISSÃO
 * (C5 do parecer): entra `string` não vazia; todo o resto é DESCARTADO com aviso de forma —
 * tipo e contagem, nunca o valor.
 *
 * ⚠️ Devolve `discarded` em vez de engolir: um item descartado É um item que a origem
 * mandou, e somá-lo a `requested` é o que faz o parcial ser recusa em vez de "lista curta".
 * A 1ª versão devolvia `null` tanto para "a origem não mandou nada" quanto para "mandou 3
 * coisas e nenhuma tinha forma de id" — o mesmo `null` de duas caras que a D167 proíbe.
 */
function asOptionIds(fieldName: string, raw: unknown, deveAvisar: boolean): OptionIds {
  if (raw === null || raw === undefined) return { presente: false, ids: [], discarded: 0 };

  const bruto = Array.isArray(raw) ? raw : [raw];
  const ids: string[] = [];
  let descartados = 0;
  for (const item of bruto) {
    if (typeof item === 'string' && item !== '') ids.push(item);
    else descartados += 1;
  }

  if (descartados > 0 && deveAvisar) {
    // C1: tipo e CONTAGEM. O uuid é o valor clínico em forma codificada e não sai daqui.
    console.warn('[resolveCatalogValue] labels value item(s) discarded (not an option id; value withheld — C1/lex):', {
      field: fieldName,
      valueType: typeof raw,
      isArray: Array.isArray(raw),
      received: bruto.length,
      discarded: descartados,
    });
  }

  return { presente: true, ids, discarded: descartados };
}
