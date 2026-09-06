/**
 * A lógica do compositor (spec 010, Tela 2 do desenho de 31/08) — sem React.
 *
 * 🔒 O QUE ESTE MÓDULO NÃO FAZ, e continua não fazendo: validar. As regras de
 * plataforma moram em `templateDraftRules.ts`, no backend, e a tela as consulta
 * por `POST /template-drafts/validar` — a MESMA função que decide na gravação.
 * O que está aqui é o que é genuinamente de apresentação: traduzir o vocabulário
 * humano da tela ("aviso do processo") no vocabulário da Meta ("UTILITY"),
 * montar o par de slugs e ordenar a lista de verificação.
 */
import type { ProblemaDeRegra } from '@infrastructure/http/AdminTemplateDraftsApiService';
import { LIMITE_CORPO, PREFIXO_POR_IDIOMA } from './templateDraftsView';

export const ES = 'es-AR';
export const PT = 'pt-BR';
export type Idioma = typeof ES | typeof PT;
export const IDIOMAS: readonly Idioma[] = [ES, PT];

/**
 * O que a pessoa responde × o que a Meta recebe.
 *
 * 🔒 O DESENHO É EXPLÍCITO: "ninguém precisa saber o que é UTILITY". Quem
 * escreve responde O QUE A MENSAGEM É; a categoria técnica é consequência, e a
 * tela a deriva. Antes disto a tela pedia a categoria num `<select>` com
 * `UTILITY`/`MARKETING`/`AUTHENTICATION` crus — vocabulário da Meta pedido a
 * quem não trabalha na Meta.
 *
 * ⚠️ `AUTHENTICATION` FICOU DE FORA, e isso é uma perda declarada, não um
 * esquecimento. Ela é a categoria de código de verificação (OTP), que não é o
 * caso desta tela — nenhum dos 28 templates de produção a usa. A rota da API
 * continua aceitando, então nada foi fechado no sistema; só deixou de ser
 * oferecido aqui, onde ofereceria uma escolha que ninguém desta tela faz.
 */
export const TIPOS = [
  { chave: 'aviso', categoria: 'UTILITY' },
  { chave: 'invitacion', categoria: 'UTILITY' },
  { chave: 'difusion', categoria: 'MARKETING' },
] as const;

export type TipoDeMensagem = (typeof TIPOS)[number]['chave'];

export function categoriaDoTipo(tipo: TipoDeMensagem): string {
  return TIPOS.find((t) => t.chave === tipo)?.categoria ?? 'UTILITY';
}

/**
 * O caminho de volta, para reabrir um rascunho que já existe.
 *
 * ⚠️ `UTILITY` mapeia para DOIS tipos ("aviso" e "invitación"), então a volta é
 * ambígua por construção e cai no primeiro. Não é defeito escondido: a
 * categoria é o que a Meta guarda, e a distinção entre avisar e convidar é
 * nossa, não dela. Perder essa nuance ao reabrir é o preço de não inventar uma
 * coluna nova só para guardá-la — e ela não muda nada do que é enviado.
 */
export function tipoDaCategoria(categoria: string): TipoDeMensagem {
  return TIPOS.find((t) => t.categoria === categoria)?.chave ?? 'aviso';
}

/**
 * O par de slugs que nasce de um nome só — o `ar_x` / `br_x` do desenho.
 *
 * A pessoa digita `bienvenida_contratacion` e vê nascer os dois. É a convenção
 * que os templates argentinos de produção já seguem, agora aplicada sozinha em
 * vez de lembrada.
 *
 * 🔒 Isto é PRÉ-VISUALIZAÇÃO. Quem decide o slug final é o backend
 * (`slugComPrefixo`), e o e2e compara os dois justamente para uma divergência
 * aparecer como teste vermelho e não como surpresa depois de gravar.
 */
export function parDeSlugs(base: string): Record<Idioma, string> {
  const limpo = base.trim().toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const com = (idioma: Idioma) => {
    const p = PREFIXO_POR_IDIOMA[idioma];
    if (limpo.length === 0) return '';
    return limpo.startsWith(p) ? limpo : `${p}${limpo}`;
  };
  return { [ES]: com(ES), [PT]: com(PT) } as Record<Idioma, string>;
}

/** Um item da lista "Antes de enviar a Meta". */
export interface ItemDeVerificacao {
  /** Sufixo da chave de i18n. */
  chave: string;
  estado: 'ok' | 'falta' | 'impede';
  /** Interpolações do texto do item, quando ele tem número. */
  dados?: Record<string, unknown>;
}

/**
 * A lista de verificação, montada a partir do que o SERVIDOR respondeu.
 *
 * 🔒 O ESTADO `ok` É DERIVADO POR AUSÊNCIA, e essa escolha tem consequência: um
 * item só fica verde quando o servidor NÃO reportou problema sobre ele. Se uma
 * regra for removida lá, o item correspondente aqui fica verde para sempre — o
 * que é preferível ao contrário (item vermelho eterno sobre uma regra que não
 * existe mais), mas é a razão de a lista ser derivada da resposta e nunca
 * escrita à mão. Item que a tela inventa é item que ninguém está medindo.
 *
 * @param problemas  bloqueios + avisos, como vieram do servidor
 * @param corpo      o texto do idioma que está na aba ativa
 * @param faltaOutro se a outra versão do par ainda está sem texto
 */
export function listaDeVerificacao(
  problemas: readonly ProblemaDeRegra[],
  corpo: string,
  faltaOutro: boolean,
): ItemDeVerificacao[] {
  /*
   * 🔒 ESTES NOMES SÃO OS QUE `validarRascunho` EMITE — conferidos um a um
   * contra `templateDraftRules.ts`, não escritos de memória. A primeira versão
   * deste mapa usava `variavel_nao_suportada`, `conteudo_proibido` e
   * `clausula_de_baja`: nenhum dos três existe. Todos os itens teriam ficado
   * VERDES para sempre, porque o estado `ok` é derivado por ausência — a lista
   * inteira seria decoração que nunca acende.
   *
   * O teste `templateComposerView.test.ts` cruza este mapa com a lista real de
   * regras, para que inventar uma chave volte a ser um teste vermelho.
   */
  const REGRAS_POR_ITEM: Record<string, readonly string[]> = {
    variaveis: ['variavel_desconhecida', 'variavel_com_simbolo', 'variaveis_demais', 'placeholder_posicional'],
    bordas: ['placeholder_no_inicio', 'placeholder_no_fim', 'placeholders_adjacentes'],
    nome: ['formato', 'obrigatorio'],
    tamanho: ['muito_longo'],
    clausulaBaja: ['sem_clausula_de_baja', 'sem_caminho_de_saida', 'clausula_de_baja_nao_reconhecida'],
  };

  /**
   * O pior estado entre as regras do item.
   *
   * Um item que junta várias regras não pode ficar amarelo porque a segunda é
   * aviso, se a primeira bloqueia: o que a pessoa precisa saber é se aquilo
   * impede o envio.
   */
  const estadoDe = (item: string): 'ok' | 'falta' | 'impede' => {
    const nomes = REGRAS_POR_ITEM[item] ?? [];
    const achados = problemas.filter((x) => nomes.includes(x.regra));
    if (achados.length === 0) return 'ok';
    return achados.some((x) => x.gravidade === 'bloqueia') ? 'impede' : 'falta';
  };

  const itens: ItemDeVerificacao[] = [
    // A categoria a tela escolheu sozinha a partir do tipo — nunca há o que
    // corrigir aqui, e o item existe para DIZER qual foi, não para alertar.
    { chave: 'categoria', estado: 'ok' },
    { chave: 'variaveis', estado: estadoDe('variaveis') },
    { chave: 'bordas', estado: estadoDe('bordas') },
    { chave: 'nome', estado: estadoDe('nome') },
    {
      chave: 'tamanho',
      estado: estadoDe('tamanho'),
      dados: { n: corpo.length, limite: LIMITE_CORPO },
    },
    { chave: 'clausulaBaja', estado: estadoDe('clausulaBaja') },
  ];

  /*
   * O item do idioma que falta entra por ÚLTIMO e como aviso, nunca como
   * impedimento — o desenho é explícito: "Podés enviar solo el español ahora y
   * el otro después". Se o par fosse indivisível, uma tradução pendente
   * seguraria uma mensagem espanhola pronta, e a primeira recusa de um lado
   * deixaria o outro em limbo.
   */
  if (faltaOutro) itens.push({ chave: 'outroIdioma', estado: 'falta' });

  return itens;
}

/**
 * Todas as regras que a lista sabe exibir. Existe para o teste poder cruzar
 * este mapa com o que o backend emite, e falhar quando alguém inventar um nome.
 */
export const REGRAS_MAPEADAS: readonly string[] = [
  'variavel_desconhecida', 'variavel_com_simbolo', 'variaveis_demais', 'placeholder_posicional',
  'placeholder_no_inicio', 'placeholder_no_fim', 'placeholders_adjacentes',
  'formato', 'obrigatorio', 'muito_longo',
  'sem_clausula_de_baja', 'sem_caminho_de_saida', 'clausula_de_baja_nao_reconhecida',
];

/** Quantos itens estão verdes — o "6 de 7" do cabeçalho da lista. */
export function contagemDaLista(itens: readonly ItemDeVerificacao[]): { ok: number; total: number } {
  return { ok: itens.filter((i) => i.estado === 'ok').length, total: itens.length };
}
