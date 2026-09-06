/**
 * A lógica pura da tela de rascunho — sem React, para poder ser testada direto.
 *
 * 🔒 O que este módulo NÃO faz: validar. As regras de plataforma moram no
 * backend (`templateDraftRules.ts`) e são aplicadas lá. Reimplementá-las aqui
 * criaria duas verdades que divergem no primeiro ajuste — e a que a pessoa vê
 * não seria a que decide. A tela mostra o que o servidor respondeu.
 *
 * O que ele faz é o que é genuinamente de apresentação: pré-visualizar,
 * contar e traduzir código de erro em chave de i18n.
 */
import type { ProblemaDeRegra } from '@infrastructure/http/AdminTemplateDraftsApiService';

export const LIMITE_CORPO = 1024;

export const CATEGORIAS = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;

/**
 * As variáveis que a pessoa pode usar, para a tela LISTAR.
 *
 * ⚠️ Quem decide é o backend (`templateDraftRules`, que por sua vez importa de
 * `StageTemplateEligibility`). Isto aqui é a mesma lista escrita para exibição —
 * e o e2e sem mock compara as duas, para que uma divergência apareça como teste
 * vermelho e não como variável recusada depois de a pessoa escrever o texto.
 */
export const VARIAVEIS_AJUDA = ['worker_name', 'name', 'case_number'] as const;
export const IDIOMAS = ['es-AR', 'pt-BR'] as const;

/** Prefixo que o backend vai aplicar. Espelhado aqui só para MOSTRAR o resultado antes de salvar. */
export const PREFIXO_POR_IDIOMA: Record<string, string> = { 'es-AR': 'ar_', 'pt-BR': 'br_' };

/**
 * O slug como ele vai ficar depois de salvo.
 *
 * ⚠️ É PRÉ-VISUALIZAÇÃO, não a regra: quem decide o slug final é o backend.
 * Existe para a pessoa não descobrir o nome só depois de gravar. Se as duas
 * divergirem algum dia, a do backend é a certa — e o e2e compara as duas
 * justamente para que a divergência apareça como teste vermelho, e não como
 * surpresa na tela.
 */
export function slugPrevisto(base: string, language: string): string {
  const limpo = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const prefixo = PREFIXO_POR_IDIOMA[language] ?? '';
  if (limpo.length === 0) return '';
  return limpo.startsWith(prefixo) ? limpo : `${prefixo}${limpo}`;
}

/**
 * Como a cuidadora vai ver a mensagem.
 *
 * Troca `{{1}}` por um exemplo visível em vez de deixar a chave crua: a pessoa
 * que escreve precisa enxergar o texto como ele chega, não o gabarito.
 */
export function previewDe(body: string, exemplos: Record<string, string> = {}): string {
  const padrao: Record<string, string> = {
    worker_name: '[nombre]', name: '[nombre]', case_number: '[nº de caso]',
  };
  return body.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (todo, nome: string) => {
    const v = exemplos[nome] ?? padrao[nome];
    // Token desconhecido fica CRU de propósito: a pessoa precisa ver que aquilo
    // não vai ser preenchido, em vez de a pré-visualização inventar um valor.
    return v ?? todo;
  });
}

/** Quanto ainda cabe. Negativo significa que passou — a tela mostra em vermelho. */
export function restante(body: string): number {
  return LIMITE_CORPO - body.length;
}

/**
 * A chave de i18n de um problema devolvido pelo backend.
 *
 * Prefixada por campo para que duas regras homônimas em campos diferentes
 * (`obrigatorio` em `name` e em `body`) possam ter textos distintos.
 */
export function chaveDeProblema(p: ProblemaDeRegra): string {
  return `admin.templateDrafts.regra.${p.campo}.${p.regra}`;
}

/** Agrupa os problemas por campo, para o formulário destacar cada input. */
export function problemasPorCampo(ps: ProblemaDeRegra[]): Record<string, ProblemaDeRegra[]> {
  const out: Record<string, ProblemaDeRegra[]> = {};
  for (const p of ps) {
    (out[p.campo] ??= []).push(p);
  }
  return out;
}

/** Rótulo curto de quando algo mudou. Reusa a mesma ideia do catálogo. */
export function quandoRelativo(iso: string | null, agora: Date): { valor: number; unidade: 'min' | 'h' | 'd' } | null {
  if (!iso) return null;
  const ms = agora.getTime() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 60) return { valor: min, unidade: 'min' };
  const h = Math.floor(min / 60);
  if (h < 24) return { valor: h, unidade: 'h' };
  return { valor: Math.floor(h / 24), unidade: 'd' };
}

/** Os idiomas que a tela aceita vir por URL. */
const IDIOMAS_VALIDOS = new Set(['es-AR', 'pt-BR']);

/**
 * O estado inicial do formulário quando se chega pelo "＋ Crear versión" do
 * catálogo: `?base=<base_name>&lang=<idioma>`.
 *
 * 🔒 O `base` VAI PARA O SLUG, e é isso que faz o par nascer certo. O backend
 * prefixa por idioma (`ar_`/`br_`), então digitar o mesmo `base` dos dois
 * lados produz `ar_x` e `br_x` — que só pareiam na tela porque a coluna
 * `base_name` os une. Chegar aqui com o campo em branco faria a pessoa
 * redigitar de cabeça o nome da outra versão, e um caractere diferente cria
 * uma mensagem órfã em vez da tradução que ela quis fazer.
 *
 * 🔒 Idioma fora do conjunto é IGNORADO, não aceito: `?lang=xx` viria do que
 * alguém digitou na barra de endereço, e um valor inválido no `select` deixa
 * o formulário num estado que o backend recusa sem a tela saber por quê.
 */
export function inicialDaURL<T extends { slug: string; language: string; body: string }>(params: URLSearchParams, vazio: T): T {
  const base = (params.get('base') ?? '').trim();
  const lang = params.get('lang') ?? '';
  /**
   * 🔒 `body` chega pelo "Duplicar y corregir" da tela de detalhe, e é a razão
   * de aquele botão não ser um beco. Um Content já submetido à Meta NÃO se
   * edita — corrigir uma vírgula significa começar outro. Se o rascunho novo
   * nascesse em branco, quem clicou teria de reescrever à mão o texto que está
   * na tela ao lado, e é aí que a correção vira uma mensagem diferente da que
   * a Meta comentou.
   *
   * Vem CRU, sem sanitizar: é texto que a Meta já aprovou ou recusou, e
   * "melhorá-lo" na entrada faria a pessoa corrigir algo que não é o que foi
   * julgado. O que valida é o backend, na hora de gravar.
   */
  const body = params.get('body');
  return {
    ...vazio,
    slug: base,
    language: IDIOMAS_VALIDOS.has(lang) ? lang : vazio.language,
    body: body !== null && body !== '' ? body : vazio.body,
  };
}

/**
 * Para onde o "Editar" de um rascunho leva: o compositor abre ESTE rascunho.
 *
 * 🔒 Pelo `id`, e não pela base. `?base=` também chega pelo "duplicar y
 * corregir", que quer um rascunho NOVO com o texto de um Content já submetido —
 * se o compositor adivinhasse a edição pela base, a correção sobrescreveria o
 * original em vez de criar o substituto.
 */
export function urlDeEdicao(id: string): string {
  return `/admin/plantillas/registrar?draft=${encodeURIComponent(id)}`;
}
