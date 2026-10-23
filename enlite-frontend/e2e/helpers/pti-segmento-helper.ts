/**
 * Spec 030 (F3) — o campo "Segmento (Ana Care)" do form do PTI, escolhido como um HUMANO: click no
 * select nativo `#tp-segment`, foco conferido, TECLADO (`keyboard.type` das primeiras letras do rótulo
 * + `Tab`) e o valor LIDO DA TELA devolvido. Medido (Chromium Linux = o do CI, headless): o click ABRE o
 * popup nativo e o type-ahead só DESTACA a opção (value ficava ""); o `Tab` confirma o item destacado sem
 * submeter o form. No macOS o popup não abre e o Tab só move o foco (a opção já foi escolhida). NÃO usar
 * `Enter`: no macOS ele submete o form do select.
 * Compartilhado pelos specs que criam versão "Nuevo" (o segmento é obrigatório lá).
 */
import { expect, type Page } from '@playwright/test';
import { runSQL } from './patient-detail-c-helper';

/** Primeiro segmento ATIVO do catálogo (seed 495, ordem do banco) — o que o teclado vai escolher no form. */
export function primeiroSegmento(): { id: string; label: string } {
  const [id, label] = runSQL(`SELECT id || '|' || label FROM therapeutic_segments WHERE active ORDER BY sort_order, lower(label) LIMIT 1`).split('\n')[0].trim().split('|');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return { id, label };
}

export async function escolherSegmentoPeloTeclado(page: Page, rotuloEsperado: string): Promise<string> {
  const campo = page.locator('#tp-segment');
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(rotuloEsperado.slice(0, 4));
  await page.keyboard.press('Tab');
  await expect(campo).not.toHaveValue('');
  return (await campo.locator('option:checked').innerText()).trim();
}
