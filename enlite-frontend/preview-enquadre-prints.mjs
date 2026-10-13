/**
 * preview-enquadre-prints — os 17 prints do protótipo do enquadre (spec 052, T-16). Dev-only, sai antes do 1º PR.
 * Precisa do Vite de pé na porta 5252 (`pnpm exec vite --port 5252 --strictPort`). Só em es.
 * Recusa o print (e NÃO grava o PNG) se: overlay de erro do Vite, #root vazio, pageerror/console.error, chave i18n crua,
 * ou rolagem horizontal da página em 1440px.
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5252/preview-enquadre.html';
const OUT = '/Users/gabrielstein-dev/projects/enlite/ebrain/specs/052-enquadre-eventos-e-kanban/evidencias/prototipo';
const ONLY = process.argv.slice(2);

const ESTADOS = [
  ['01', '01-abas-recrutamento-enquadre'], ['02', '02-lista-vazia'], ['03', '03-lista-proximos'],
  ['04', '04-lista-pendente-de-encerrar'], ['05', '05-lista-encerrados'], ['06', '06-drawer-criar'],
  ['07', '07-drawer-erro-google'], ['08', '08-drawer-prestador-sem-email'], ['09', '09-kanban-evento-aberto'],
  ['10', '10-kanban-evento-encerrado'], ['11', '11-confirmar-encerrar'], ['12', '12-linha-selos-esteira'],
  ['13', '13-kanban-vacante-sem-confirmado'], ['14', '14-confirmar-cancelar'], ['15', '15-lista-apos-cancelar'],
  ['16', '16-convocados-acrescentar'], ['17', '17-convocados-quitar'],
];

/** Kanban com 5 cards: a coluna rola por dentro (altura = 100vh - 280px); a 1100px os 5 cards aparecem inteiros. */
const ALTURA = { '09': 1100, 14: 1100, 16: 1100, 17: 1100 };

const RAW_KEY = /\badmin\.[A-Za-z]+\.[A-Za-z.]+|\benquadre\.[a-z]+\./;

/** Medidas dentro da página (números, não impressão visual). */
async function measure(page, id) {
  return page.evaluate((estado) => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    const out = { vw: window.innerWidth, vh: window.innerHeight };
    if (['09', '10', '13'].includes(estado)) {
      const board = document.querySelector('[data-testid="enquadre-kanban-board"], [data-testid="kanban-board"]');
      out.board = board ? { ...rect(board), scrollWidth: board.scrollWidth, clientWidth: board.clientWidth, rolagemHorizontal: board.scrollWidth > board.clientWidth } : null;
      out.colunas = Array.from(document.querySelectorAll('[data-testid^="kanban-column-"]'))
        .filter((e) => /^kanban-column-[A-Z_]+$/.test(e.getAttribute('data-testid') ?? ''))
        .map((e) => ({ id: e.getAttribute('data-testid').replace('kanban-column-', ''), ...rect(e) }));
    }
    if (['06', '08', '16'].includes(estado)) {
      const panel = document.querySelector('[data-testid="enquadre-create-drawer"], [data-testid="enquadre-convoked-panel"]');
      const submit = document.querySelector('[data-testid="enquadre-create-submit"], [data-testid="enquadre-convoked-add"]');
      out.painel = panel ? rect(panel) : null;
      const motivo = document.querySelector('[data-testid="enquadre-create-host-reason-h-c"]');
      if (motivo) out.motivoEntrevistadoraSemVinculo = motivo.textContent;
      if (submit) { const r = submit.getBoundingClientRect(); out.submit = { ...rect(submit), dentroDaViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth }; }
    }
    return out;
  }, id);
}

const browser = await chromium.launch({ args: ['--lang=es-AR'] });
let falhas = 0;
for (const [id, nome] of ESTADOS) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  const context = await browser.newContext({ viewport: { width: 1440, height: ALTURA[id] ?? 900 }, deviceScaleFactor: 1, locale: 'es-AR' });
  const page = await context.newPage();
  const problemas = [];
  page.on('pageerror', (e) => problemas.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problemas.push(`console.error: ${m.text()}`); });
  try {
    await page.goto(`${BASE}?estado=${id}&lang=es`, { waitUntil: 'load' });
    await page.waitForSelector(`[data-preview-ready="${id}"]`, { timeout: 10000 });
    await page.waitForTimeout(300);
    if ((await page.locator('vite-error-overlay, [class*="vite-error-overlay"]').count()) > 0) problemas.push('vite-error-overlay presente');
    if ((await page.evaluate(() => document.getElementById('root')?.children.length ?? 0)) === 0) problemas.push('#root vazio');
    const texto = await page.evaluate(() => document.body.innerText);
    const cru = texto.match(RAW_KEY);
    if (cru) problemas.push(`chave i18n crua: ${cru[0]}`);
    const larg = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (larg.sw > larg.iw) problemas.push(`rolagem horizontal da página: scrollWidth ${larg.sw} > innerWidth ${larg.iw}`);
    const medidas = await measure(page, id);
    if (problemas.length) {
      falhas += 1;
      console.log(`FALHA ${id} ${problemas.join(' | ')}`);
    } else {
      await page.screenshot({ path: `${OUT}/${nome}.png`, fullPage: true });
      console.log(`ok ${id} ${nome}`);
    }
    if (['06', '08', '09', '10', '13', '16'].includes(id)) console.log(`   medidas ${id}: ${JSON.stringify(medidas)}`);
  } catch (err) {
    falhas += 1;
    console.log(`FALHA ${id} ${String(err.message).split('\n')[0]}${problemas.length ? ` | ${problemas.join(' | ')}` : ''}`);
  }
  await context.close();
}
await browser.close();
console.log(falhas === 0 ? 'TODOS OK' : `${falhas} FALHA(S)`);
process.exit(falhas === 0 ? 0 : 1);
