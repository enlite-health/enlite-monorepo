/**
 * custos-painel-helper.ts — o que os e2e do painel de custos (spec 082) repetem: trocar o CENÁRIO da seed do emulador BigQuery,
 * os números esperados da seed, a janela do limite de 10 s e as duas medições de UI (linha única e contraste) com controle positivo.
 *
 * Cenário: `worker-functions/test-fixtures/billing-export-seed.mjs` apaga e recria a tabela a cada execução; o e2e o roda de novo
 * contra a porta PUBLICADA do emulador (`BQ_EMULATOR_PORT`, default 59050 = `docker-compose.bigquery-emulator.yml`). O processo da
 * API lê a mesma tabela (mesmo nome), então a próxima sincronização já vê o cenário novo.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { expect, type Page } from '@playwright/test';

export type CenarioCustos = 'anomaly' | 'calm' | 'short';

/** Nome de recurso Cloud Run plausível e LONGO (45 caracteres, UI-2 da spec 082): é o recurso "novo" do cenário `anomaly`. */
export const NOME_LONGO = 'assistants-service-maria-whatsapp-handler-prd';
export const RECURSO_LONGO = `projects/enlite-test/services/${NOME_LONGO}`;

export function semearCenario(cenario: CenarioCustos): string {
  const seed = path.resolve(process.cwd(), '..', 'worker-functions', 'test-fixtures', 'billing-export-seed.mjs');
  const saida = execFileSync('node', [seed], {
    env: { ...process.env, SEED_SCENARIO: cenario, BIGQUERY_EMULATOR_HOST: `http://localhost:${process.env.BQ_EMULATOR_PORT ?? '59050'}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).toString();
  expect(saida).toContain(`seed ok (${cenario})`); // contagem de linhas > 0 é a prova de que semeou (nunca "rodou sem erro")
  return saida;
}

/**
 * Números do cenário `anomaly` no mês corrente (UTC). A seed cobre hoje-24..hoje, então o mês tem `n = min(dia, 25)` dias semeados.
 * Por dia: Cloud Run 3 (api 2 + sem-rótulo 1), Cloud SQL 6, Vertex AI 3; Cloud Storage 3,5 nos últimos 9 dias; ontem: Cloud Run +12 (api 14)
 * e +6 (recurso novo de nome longo).
 */
export function esperadoAnomaly(hoje: Date = new Date()) {
  const n = Math.min(hoje.getUTCDate(), 25);
  const ontemNoMes = n >= 2;
  const cloudRun = 3 * n + (ontemNoMes ? 18 : 0);
  const cloudSql = 6 * n;
  const vertex = 3 * n;
  const storage = 3.5 * Math.min(9, n);
  return { n, cloudRun, cloudSql, vertex, storage, total: cloudRun + cloudSql + vertex + storage };
}

/** `64,5` -> /(?<![\d.,])64,50(?!\d)/ (es e pt-BR usam vírgula decimal; abaixo de 1.000 não há separador de milhar). */
export const valor = (n: number): RegExp => new RegExp(`(?<![\\d.,])${n.toFixed(2).replace('.', ',')}(?!\\d)`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JANELA_MS = 10_500; // limite de sincronização do backend = 10 s (por PROCESSO da API)
let ultimaSync = 0;

/** Espera a janela de 10 s desde a última sincronização DESTE processo. Chame `esperarJanela(true)` no início do arquivo (o anterior pode ter sincronizado). */
export async function esperarJanela(desdeOInicio = false): Promise<void> {
  const falta = desdeOInicio ? 11_000 : JANELA_MS - (Date.now() - ultimaSync);
  if (falta > 0) await sleep(falta);
}

/** Clica Sincronizar (respeitando a janela) e espera o resultado ou o estado vazio. */
export async function sincronizar(page: Page, espera: 'custos-resultado' | 'custos-vazio' = 'custos-resultado'): Promise<void> {
  await esperarJanela();
  await page.getByTestId('custos-sincronizar').click();
  ultimaSync = Date.now();
  await expect(page.getByTestId(espera)).toBeVisible({ timeout: 60_000 });
}

/** Conta as chamadas a `/costs/overview` feitas pela página. */
export function contarChamadas(page: Page): { total: () => number } {
  const urls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/costs/overview')) urls.push(r.url()); });
  return { total: () => urls.length };
}

// ── UI-1: nenhuma quebra de linha em `[data-single-line]` ────────────────────────────────────────────────────────────────────────

export interface MedidaLinhaUnica {
  porTipo: Record<string, number>;
  total: number;
  multilinha: Array<{ tipo: string; texto: string; linhas: number }>;
}

/**
 * Mede cada `[data-single-line]` visível: Range sobre o conteúdo -> `getClientRects()` -> caixas com o mesmo `top` (tolerância 4 px) = 1 linha.
 * `escopo` restringe a raiz (default: o documento).
 */
export async function medirLinhaUnica(page: Page, escopo = 'body'): Promise<MedidaLinhaUnica> {
  return page.evaluate((raiz) => {
    const out: MedidaLinhaUnica = { porTipo: {}, total: 0, multilinha: [] };
    const root = document.querySelector(raiz);
    if (!root) throw new Error(`escopo não encontrado: ${raiz}`);
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-single-line]'))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue; // fora da tela por display:none (aba fechada, etc.)
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops: number[] = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0 && r.height === 0) continue;
        if (!tops.some((t) => Math.abs(t - r.top) <= 4)) tops.push(r.top);
      }
      const tipo = el.dataset.singleLine ?? '?';
      out.porTipo[tipo] = (out.porTipo[tipo] ?? 0) + 1;
      out.total += 1;
      if (tops.length > 1) out.multilinha.push({ tipo, texto: (el.textContent ?? '').trim().slice(0, 60), linhas: tops.length });
    }
    return out;
  }, escopo);
}

/**
 * Controle positivo da medição: um elemento SEM `nowrap`, com o nome longo, numa coluna estreita TEM de medir > 1 linha.
 * Devolve as linhas medidas (o chamador exige > 1); o elemento é removido.
 */
export async function controlePositivoLinhaUnica(page: Page): Promise<number> {
  return page.evaluate((nome) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:120px;background:white';
    host.innerHTML = `<span data-single-line="nome" id="custos-controle-linha">${nome}</span>`;
    document.body.appendChild(host);
    const el = host.querySelector<HTMLElement>('#custos-controle-linha')!;
    const range = document.createRange();
    range.selectNodeContents(el);
    const tops: number[] = [];
    for (const r of Array.from(range.getClientRects())) if (!tops.some((t) => Math.abs(t - r.top) <= 4)) tops.push(r.top);
    host.remove();
    return tops.length;
  }, NOME_LONGO);
}

// ── UI-4: contraste de texto >= 7:1 ───────────────────────────────────────────────────────────────────────────────────────────

export interface MedidaContraste {
  nos: number;
  abaixo: Array<{ texto: string; razao: number; fg: string; bg: string }>;
}

/**
 * Percorre todo nó de texto sob `[data-testid^="custos"]` (ou sob `escopo`), calcula a razão WCAG entre a cor computada do texto
 * (`color`; `fill` em SVG) e o fundo efetivo (1º ancestral com `background-color` não transparente, compondo o alfa sobre branco).
 * Cor em formato que não sei ler = ERRO (nunca "passou").
 */
export async function medirContraste(page: Page, escopo = '[data-testid^="custos"]', minimo = 7): Promise<MedidaContraste> {
  // Medido: a cor computada no meio de uma `transition-colors` (aba que acabou de trocar de selecionada para ghost) dava 3,55:1 — leitura
  // transitória, não defeito. Só se mede com todas as animações/transições paradas.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5_000 });
  return page.evaluate(({ sel, min }) => {
    type RGBA = [number, number, number, number];
    const parse = (c: string): RGBA => {
      const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c.trim());
      if (!m) throw new Error(`formato de cor não suportado: ${c}`);
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
    };
    const over = (top: RGBA, bottom: RGBA): RGBA => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [255, 255, 255, 1];
      return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a) as RGBA;
    };
    const lum = ([r, g, b]: RGBA): number => {
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fundoEfetivo = (el: Element): RGBA => {
      const camadas: RGBA[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const bg = parse(getComputedStyle(e).backgroundColor);
        if (bg[3] > 0) camadas.push(bg);
        if (bg[3] === 1) break;
      }
      return camadas.reduceRight<RGBA>((base, c) => over(c, base), [255, 255, 255, 1]);
    };
    const hex = (c: RGBA) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
    const roots = Array.from(document.querySelectorAll(sel));
    // Raízes aninhadas (custos-page > custos-resultado ...) não podem contar o mesmo nó 2x.
    const vistos = new Set<Node>();
    const out: MedidaContraste = { nos: 0, abaixo: [] };
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const texto = (n.textContent ?? '').trim();
        const el = n.parentElement;
        if (!texto || !el || vistos.has(n)) continue;
        vistos.add(n);
        const box = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if ((box.width === 0 && box.height === 0) || cs.visibility === 'hidden' || cs.display === 'none') continue;
        const cor = el instanceof SVGElement ? cs.fill : cs.color;
        const fg = over(parse(cor), fundoEfetivo(el));
        const bg = fundoEfetivo(el);
        const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        const razao = (l1 + 0.05) / (l2 + 0.05);
        out.nos += 1;
        if (razao < min) out.abaixo.push({ texto: texto.slice(0, 50), razao: Math.round(razao * 100) / 100, fg: hex(fg), bg: hex(bg) });
      }
    }
    return out;
  }, { sel: escopo, min: minimo });
}

/** Controle positivo do contraste: um nó com `text-gray-800` (o `secondary` padrão do `Text`, 4,74:1) TEM de reprovar a 7:1. */
export async function controlePositivoContraste(page: Page): Promise<MedidaContraste> {
  await page.evaluate(() => {
    const el = document.createElement('p');
    el.id = 'custos-controle-contraste';
    el.setAttribute('data-testid', 'custos-controle-contraste');
    el.className = 'text-gray-800 bg-white';
    el.textContent = 'controle de contraste';
    document.querySelector('[data-testid="custos-page"]')!.appendChild(el);
  });
  const medida = await medirContraste(page, '[data-testid="custos-controle-contraste"]');
  await page.evaluate(() => document.getElementById('custos-controle-contraste')?.remove());
  return medida;
}

/** UI-3: sem rolagem horizontal da PÁGINA. */
export async function semRolagemHorizontal(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}
