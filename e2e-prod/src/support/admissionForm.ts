import { type Page } from '@playwright/test';
import { escolherNoCombobox } from './combobox';

/**
 * `lead-serviceType` do formulário público de admissão virou Combobox (spec 070): o `data-testid`
 * está no PRÓPRIO gatilho (medido em prd 15/11). Gesto humano pelo rótulo que a pessoa lê
 * (es: "Cuidadores") — a mecânica do combobox mora em `combobox.ts`.
 */
export async function escolherServico(page: Page, rotulo: string): Promise<void> {
  await escolherNoCombobox(page.getByTestId('lead-serviceType'), rotulo);
}
