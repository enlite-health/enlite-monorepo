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
export function previewDe(body: string, exemplos: string[] = []): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_todo, n: string) => {
    const i = Number(n) - 1;
    const v = exemplos[i];
    return v && v.length > 0 ? v : `[valor ${n}]`;
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
