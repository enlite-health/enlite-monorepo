/**
 * itinerario-069-flow-helper.ts — o fluxo "Nueva sustitución" (4 passos) e a escolha de quem entra, dirigidos como um HUMANO
 * (spec 069, F7; memória `e2e-humano-nao-e-fill`): `click` no rótulo do rádio, `digitarDataNoCampo` (click + teclado) nas datas,
 * `selectOption` real nos `<select>`; nenhum `fill`/`evaluate`/`dispatchEvent`. As asserções leem o que FICOU na tela
 * (`data-selected`, texto da contagem, valor do campo). A API só monta/desmonta cenário (`criarPedidoViaApi`).
 */
import { expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { backendUrl } from './lancamento-e2e-helper';
import { derivacaoToken } from './derivacao-e2e-helper';
import { digitarDataNoCampo } from './itinerario-aba-e2e-helper';
import { sqlComVars } from './sql-com-vars';

export type Duracao = 'ONE_DAY' | 'DAYS' | 'PERMANENT';

/** "Hoje" no fuso da operação, lido do BANCO (nunca do relógio do runner). */
export const hojeDoBanco = (): string =>
  sqlComVars("SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD')");

/** `hoje + n` dias (Buenos Aires), lido do banco. */
export const diaDoBanco = (n: number): string =>
  sqlComVars("SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date + :'n'::int, 'YYYY-MM-DD')", { n: String(n) });

/** O dia da semana (convenção Postgres: 0 = domingo) de uma data `YYYY-MM-DD`, lido do banco. */
export const diaDaSemana = (iso: string): number =>
  Number(sqlComVars("SELECT extract(dow FROM :'d'::date)::int", { d: iso }));

/** Primeira data ≥ `desde` que cai no dia da semana `dow` (Postgres: 0 = domingo), lida do banco. */
export const proximaDataNoDia = (dow: number, desde: string): string =>
  sqlComVars("SELECT to_char(g::date, 'YYYY-MM-DD') FROM generate_series(:'d'::date, :'d'::date + 6, interval '1 day') g WHERE extract(dow FROM g) = :'dow'::int", {
    d: desde,
    dow: String(dow),
  });

/** Abre o fluxo pelo botão "Nueva sustitución" da tela do serviço (ou o do estado vazio da aba Sustituciones). */
export async function abrirNuevaSustitucion(page: Page): Promise<void> {
  await page.getByTestId('itinerario-nova-substituicao').click();
  await expect(page.getByTestId('substitucion-flujo')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('substitucion-paso')).toContainText('1');
}

export async function siguiente(page: Page): Promise<void> {
  const botao = page.getByTestId('substitucion-siguiente');
  await expect(botao).toBeEnabled({ timeout: 15_000 });
  await botao.click();
}

/** Passo 1 — marca a PESSOA (clique no rádio) e confere na tela que ficou marcada. */
export async function paso1QuienNoViene(page: Page, workerId: string): Promise<void> {
  const opcao = page.getByTestId(`substitucion-quien-${workerId}`);
  await opcao.locator('label').click();
  await expect(opcao).toHaveAttribute('data-selected', 'true');
  await siguiente(page);
}

/** Passo 2 — escolhe a duração e DIGITA as datas; devolve o texto da contagem de turnos que a tela mostrou. */
export async function paso2PorCuantoTiempo(page: Page, tipo: Duracao, desde: string, hasta?: string): Promise<string> {
  const opcao = page.getByTestId(`substitucion-duracion-${tipo}`);
  await opcao.locator('label').click();
  await expect(opcao).toHaveAttribute('data-selected', 'true');
  if (tipo === 'DAYS') {
    await digitarDataNoCampo(page, 'substitucion-desde', desde);
    await digitarDataNoCampo(page, 'substitucion-hasta', hasta as string);
  } else {
    await digitarDataNoCampo(page, tipo === 'ONE_DAY' ? 'substitucion-fecha' : 'substitucion-fecha', desde);
  }
  const cuenta = page.getByTestId('substitucion-turnos-cuenta');
  await expect(cuenta).toBeVisible({ timeout: 15_000 });
  return (await cuenta.innerText()).trim();
}

/** Passo 3 — "Una persona para todos los días": marca o modo e escolhe a pessoa no `<select>`. */
export async function paso3UnaPersona(page: Page, workerId: string): Promise<void> {
  const modo = page.getByTestId('substitucion-cobertura-one');
  await modo.locator('label').click();
  await expect(modo).toHaveAttribute('data-selected', 'true');
  const seletor = page.getByTestId('substitucion-persona');
  await seletor.selectOption(workerId);
  await expect(seletor).toHaveValue(workerId);
}

/** Passo 3 — "Nadie todavía". */
export async function paso3Nadie(page: Page): Promise<void> {
  const modo = page.getByTestId('substitucion-cobertura-nobody');
  await modo.locator('label').click();
  await expect(modo).toHaveAttribute('data-selected', 'true');
}

/** Passo 4 — motivo (código do catálogo) e, quando a tela pergunta (D = hoje), o destino. */
export async function paso4Motivo(page: Page, reasonCode: string, destino?: 'RESERVE' | 'LEAVE_SERVICE'): Promise<void> {
  const motivo = page.getByTestId('substitucion-motivo');
  await motivo.selectOption(reasonCode);
  await expect(motivo).toHaveValue(reasonCode);
  if (destino) await page.getByTestId(`substitucion-destino-${destino}`).click();
}

/** Confirma e devolve a resposta REAL do `POST …/substitution-requests`. */
export async function confirmarPedido(page: Page): Promise<Response> {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && /\/substitution-requests$/.test(r.url())),
    page.getByTestId('substitucion-confirmar').click(),
  ]);
  return resp;
}

/** Cenário (não é o fluxo sob teste): cria o pedido pela API real. Devolve `requestId`. */
export async function criarPedidoViaApi(
  request: APIRequestContext,
  patientId: string,
  serviceId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await request.post(`${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/substitution-requests`, {
    headers: { Authorization: `Bearer ${derivacaoToken()}`, 'Content-Type': 'application/json' },
    data: { reasonCategory: 'OTHER', ...body },
  });
  const json = (await res.json().catch(() => ({}))) as { data?: { requestId?: string }; code?: string };
  expect(res.status(), `criar pedido ${res.status()} ${json.code ?? ''}`).toBe(201);
  return json.data?.requestId as string;
}

/** Os turnos da pessoa no período, como o servidor os enxerga (pré-visão real) — insumo do corpo de `criarPedidoViaApi`. */
export async function turnosDaPessoa(
  request: APIRequestContext,
  patientId: string,
  serviceId: string,
  outgoingWorkerId: string,
  from: string,
  to: string,
): Promise<Array<{ date: string; slotId: string }>> {
  const res = await request.post(`${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/substitution-requests/preview`, {
    headers: { Authorization: `Bearer ${derivacaoToken()}`, 'Content-Type': 'application/json' },
    data: { type: 'DAYS', outgoingWorkerId, from, to, candidateWorkerIds: [] },
  });
  expect(res.status(), `preview ${res.status()}`).toBe(200);
  const json = (await res.json()) as { data: { shifts: Array<{ date: string; slotId: string }> } };
  return json.data.shifts.map((s) => ({ date: s.date, slotId: s.slotId }));
}

/** A segunda-feira da semana de `iso` (a semana do seletor vai de segunda a domingo), lida do banco. */
export const segundaDaSemana = (iso: string): string =>
  sqlComVars("SELECT to_char(date_trunc('week', :'d'::date)::date, 'YYYY-MM-DD')", { d: iso });

/** Soma `n` dias a uma data `YYYY-MM-DD` (aritmética no banco, nunca no relógio do runner). */
export const somaDias = (iso: string, n: number): string =>
  sqlComVars("SELECT to_char(:'d'::date + :'n'::int, 'YYYY-MM-DD')", { d: iso, n: String(n) });

/**
 * Abre o calendário do seletor de semana, avança os meses (clique no "›") até o dia aparecer e clica nele — uma pessoa chegando
 * numa semana distante. Devolve o rótulo relativo que a tela mostrou ("En 20 semanas").
 */
export async function irParaSemanaPeloCalendario(page: Page, qualquerDiaDaSemana: string): Promise<string> {
  await page.getByTestId('itinerario-semana-abrir').click();
  await expect(page.getByTestId('itinerario-semana-calendario')).toBeVisible();
  const dia = page.getByTestId(`itinerario-semana-dia-${qualquerDiaDaSemana}`);
  for (let i = 0; i < 12 && !(await dia.isVisible()); i += 1) await page.getByTestId('itinerario-semana-mes-seguinte').click();
  await dia.click();
  await expect(page.getByTestId('itinerario-semana-calendario')).toHaveCount(0);
  return (await page.getByTestId('itinerario-semana-relativo').innerText()).trim();
}
