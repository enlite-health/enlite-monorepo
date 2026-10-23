/**
 * Spec 030 (F3) / 070 — o campo "Segmento (Ana Care)" do form do PTI, escolhido como um HUMANO: abre o
 * `Combobox` `#tp-segment` (o gatilho), busca pelo rótulo (quando há campo de busca), clica a opção e LÊ o
 * valor DA TELA (o texto do gatilho). Compartilhado pelos specs que criam versão "Nuevo" (o segmento é
 * obrigatório lá).
 */
import { expect, type Page } from '@playwright/test';
import { escolherNoCombo } from './combobox';
import { runSQL } from './patient-detail-c-helper';

/** Primeiro segmento ATIVO do catálogo (seed 495, ordem do banco) — o que o teclado vai escolher no form. */
export function primeiroSegmento(): { id: string; label: string } {
  const [id, label] = runSQL(`SELECT id || '|' || label FROM therapeutic_segments WHERE active ORDER BY sort_order, lower(label) LIMIT 1`).split('\n')[0].trim().split('|');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return { id, label };
}

export async function escolherSegmento(page: Page, rotulo: string): Promise<string> {
  const campo = page.locator('#tp-segment');
  await escolherNoCombo(page, campo, rotulo);
  return ((await campo.innerText()) ?? '').trim();
}
