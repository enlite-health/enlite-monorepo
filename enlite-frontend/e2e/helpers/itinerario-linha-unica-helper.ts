/**
 * itinerario-linha-unica-helper.ts — o GUARDA de linha única da spec 069 (regra do Gabriel: "nenhum nome/label quebra linha").
 * Todo elemento marcado `data-single-line` (nome, texto secundário, rótulo de ação/estado, chip, botão — ver `SingleLine.tsx` e os componentes do
 * itinerário) tem de ocupar UMA linha: o `Range` do seu conteúdo devolve um retângulo por fragmento de linha, e as linhas distintas (por `top`)
 * não passam de 1. Os nomes/textos cortados com reticência (`truncate`) contam como uma linha; a MEDIDA de corte (`scrollWidth > clientWidth`) é
 * devolvida à parte para o teste provar que o corte aconteceu de verdade (controle positivo: sem ele "0 quebras" poderia ser "não medi").
 * Também confere que nada estoura o contêiner: o pai de cada marcado não rola na horizontal (exceto quando o próprio pai é o truncado) e a página
 * inteira não ganha barra horizontal. A medição roda NO navegador (layout só existe lá) — por isso mora aqui e não no spec de fluxo humano.
 */
import { expect, type Page } from '@playwright/test';

export interface MedidaLinhaUnica {
  /** Elementos marcados e visíveis nesta tela. */
  marcados: number;
  /** Os que quebraram em 2+ linhas (descrição curta: testid ou tag + texto). */
  quebrados: string[];
  /** Pais que estouram na horizontal. */
  estouros: string[];
  /** Rótulos INFORMATIVOS (`data-info-label`: "salvo …: nadie", "Nadie todavía", "Elegir quién entra") cortados pela reticência — tem de ser vazio. */
  infoCortados: string[];
  /** Quantos marcados estão cortados pela reticência (texto maior que a caixa). */
  truncados: number;
  paginaRolaNaHorizontal: boolean;
}

export async function medirLinhaUnica(page: Page): Promise<MedidaLinhaUnica> {
  return page.evaluate(() => {
    const visivel = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const nome = (el: Element): string => {
      const id = el.getAttribute('data-testid');
      return `${id ?? el.tagName.toLowerCase()}:"${(el.textContent ?? '').trim().slice(0, 40)}"`;
    };
    const linhasDe = (el: Element): number => {
      // Só os NÓS DE TEXTO (um ícone ao lado do rótulo tem outra altura e não é "linha"); um retângulo por fragmento de linha.
      const tops = new Set<number>();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
        if ((n.textContent ?? '').trim() === '') continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 0 && r.height > 0) tops.add(Math.round(r.top / 6)); // tolerância de 6 px entre nós de texto na mesma linha
        }
      }
      return tops.size;
    };
    const marcados = Array.from(document.querySelectorAll('[data-single-line]')).filter(visivel);
    const quebrados: string[] = [];
    const estouros: string[] = [];
    let truncados = 0;
    const infoCortados: string[] = [];
    for (const el of Array.from(document.querySelectorAll('[data-info-label]')).filter(visivel)) {
      const h = el as HTMLElement;
      if (h.scrollWidth > h.clientWidth + 1) infoCortados.push(nome(el));
    }
    for (const el of marcados) {
      if ((el.textContent ?? '').trim() !== '' && linhasDe(el) > 1) quebrados.push(nome(el));
      const h = el as HTMLElement;
      if (h.scrollWidth > h.clientWidth + 1) truncados += 1;
      const pai = el.parentElement;
      if (pai && pai.scrollWidth > pai.clientWidth + 1 && !pai.hasAttribute('data-single-line') && getComputedStyle(pai).overflowX === 'visible') {
        estouros.push(`pai de ${nome(el)}`);
      }
    }
    const raiz = document.documentElement;
    return {
      marcados: marcados.length,
      quebrados,
      estouros,
      infoCortados,
      truncados,
      paginaRolaNaHorizontal: raiz.scrollWidth > raiz.clientWidth + 1,
    };
  });
}

/** Afirma "tudo em uma linha, nada estoura" na tela atual e devolve a medida (com `minMarcados` provando que o guarda mediu algo). */
export async function expectLinhaUnica(page: Page, onde: string, minMarcados: number): Promise<MedidaLinhaUnica> {
  const m = await medirLinhaUnica(page);
  expect(m.marcados, `${onde}: o guarda mediu ao menos ${minMarcados} elementos marcados (0 = não medi)`).toBeGreaterThanOrEqual(minMarcados);
  expect(m.quebrados, `${onde}: elementos que quebraram linha`).toEqual([]);
  expect(m.infoCortados, `${onde}: rótulo informativo cortado (label informativa nunca é truncada)`).toEqual([]);
  expect(m.estouros, `${onde}: contêineres que estouram na horizontal`).toEqual([]);
  expect(m.paginaRolaNaHorizontal, `${onde}: a página não pode ganhar barra horizontal`).toBe(false);
  return m;
}
