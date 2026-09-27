/**
 * kanban-subcard-e2e-helper.ts
 *
 * Helpers do e2e de TELA do subcard do Kanban de pacientes (Fase 8, change
 * cadeia-paciente-vacante-itinerario, P15 — DX-8.12): abrir o board, ler o par
 * `cobertas/contratadas` do DOM por serviço, montar o MESMO par a partir do corpo
 * de `GET /patients/:id/itinerary` (o par do subcard vem do itinerário, e só dele —
 * DX-8.17) e contar as requisições de dados por carga do board (DX-8.14, "sem N+1").
 *
 * Reusa sem copiar: `ItineraryResponseDto`/`readItineraryApi` (itinerario-e2e-helper.ts),
 * `openPatientKanbanBoard` (lancamento-e2e-helper.ts — G2, achado 7: as mesmas 2 linhas de
 * `readPatientKanbanColumn` não se repetem aqui).
 * Nenhum host/porta literal aqui — este helper nunca fala com a API diretamente (quem
 * lê é `readItineraryApi`, de outro helper); nenhum `throw` no import (o CI carrega
 * todos os specs antes do `--grep`).
 */
import { expect, type Page } from '@playwright/test';
import type { ItineraryResponseDto } from './itinerario-e2e-helper';
import { openPatientKanbanBoard } from './lancamento-e2e-helper';

/** `/admin/patients/kanban` → espera o board renderizar. Alias de `openPatientKanbanBoard`. */
export const openPatientKanban = openPatientKanbanBoard;

/**
 * Texto do par `X/Y` do subcard de `serviceId` — lido por `data-testid`, nunca por
 * classe CSS (regra 10): `[data-testid="patient-kanban-subcard"][data-service-id="…"]`
 * → dentro dele, `data-testid="patient-kanban-subcard-pair"`. `scrollIntoViewIfNeeded`
 * antes (o board não pagina; o card pode estar fora da viewport inicial).
 */
export async function readSubcardPair(page: Page, serviceId: string): Promise<string> {
  const subcard = page.locator(`[data-testid="patient-kanban-subcard"][data-service-id="${serviceId}"]`);
  await subcard.scrollIntoViewIfNeeded();
  const pair = subcard.getByTestId('patient-kanban-subcard-pair');
  await expect(pair).toBeVisible({ timeout: 15_000 });
  const text = await pair.textContent();
  return (text ?? '').trim();
}

/**
 * O MESMO par `X/Y` que o subcard mostra, calculado a partir do corpo de
 * `GET /patients/:id/itinerary` — a régua da DX-8.17: "o par da tela vem do
 * itinerário, e só dele". `contratadas.weekly` null vira `—`, igual ao componente
 * (`PatientKanbanSubcards.tsx`).
 */
export function pairFromItinerary(body: ItineraryResponseDto, serviceId: string): string {
  const service = body.services.find((s) => s.contractedServiceId === serviceId);
  if (!service) {
    throw new Error(`pairFromItinerary: serviço ${serviceId} não encontrado no itinerário`);
  }
  return `${service.cobertas}/${service.contratadas.weekly ?? '—'}`;
}

/**
 * Registra, a partir de ANTES do `goto` do board, toda requisição `fetch`/`xhr` cujo
 * `pathname` comece com `/api/admin/patients` (DX-8.14 — a assinatura de N+1 é uma
 * requisição por card; a fase faz exatamente 2: listagem + agregado, nunca uma por
 * paciente). Devolve uma função que lê o acumulado até aquele instante — a contagem é
 * SEMPRE pelo `pathname` da própria requisição, nunca por porta/host literal.
 */
export function collectDataRequests(page: Page): () => string[] {
  const requests: string[] = [];
  page.on('request', (req) => {
    const type = req.resourceType();
    if (type !== 'fetch' && type !== 'xhr') return;
    let pathname: string;
    try {
      pathname = new URL(req.url()).pathname;
    } catch {
      return;
    }
    if (!pathname.startsWith('/api/admin/patients')) return;
    requests.push(`${req.method()} ${pathname}`);
  });
  return () => [...requests];
}
