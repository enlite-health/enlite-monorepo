/**
 * quadro-c-e2e-helper.ts
 *
 * Helpers do e2e do quadro C ("Encuadre" do serviço contratado — D432, o nome só existe como
 * TEXTO de tela; o identificador é `serviceTeam`, critério 14), Fase 10, DX-10.13. Só o que os
 * irmãos ainda não têm: ler/agir no `GET/POST .../team[/reject|/revert]` cru, contar marcas em
 * `contracted_service_rejections` e navegar até a seção dentro da aba "Servicio Contratado".
 *
 * Reusa sem copiar: `backendUrl()` (lancamento-e2e-helper.ts:32-34), `tokenFor` (abac-stack-helper.ts:97),
 * `runSQL` (patient-detail-a-helper.ts:9), `cleanupItinerary` (itinerario-e2e-helper.ts:191-199).
 * URL só por `backendUrl()`, lida DENTRO das funções; nenhum `throw` no import (o Playwright
 * carrega todos os specs antes do `--grep`); nenhum host/porta literal.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { backendUrl } from './lancamento-e2e-helper';
import { tokenFor, type MockUser } from './abac-stack-helper';
import { runSQL } from './patient-detail-a-helper';
import { cleanupItinerary } from './itinerario-e2e-helper';

/** Staff interno só para autenticar as chamadas de API deste helper (nunca exposto ao teste). */
const QUADRO_C_STAFF: MockUser = {
  uid: 'e2e-int-admin-quadro-c-f10',
  email: 'admin.quadro-c.f10@e2e.test',
  role: 'admin',
  country: 'AR',
};

export interface ServiceTeamMemberDto {
  workerId: string;
  displayName: string | null;
  vacancyId: string | null;
  reasonCategory?: string;
}

export interface ServiceTeamDto {
  serviceId: string;
  vacancyId: string | null;
  selected: ServiceTeamMemberDto[];
  inService: ServiceTeamMemberDto[];
  rejected: ServiceTeamMemberDto[];
}

export interface ServiceTeamApiResult {
  status: number;
  body: { success: boolean; data?: ServiceTeamDto; error?: string; code?: string };
}

/** `GET /api/admin/patients/:id/contracted-services/:sid/team` — cru, sem mock. */
export async function readServiceTeamApi(
  request: APIRequestContext,
  patientId: string,
  serviceId: string,
): Promise<ServiceTeamApiResult> {
  const token = tokenFor(QUADRO_C_STAFF);
  const res = await request.get(
    `${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/team`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const status = res.status();
  const body = (await res.json().catch(() => ({ success: false }))) as ServiceTeamApiResult['body'];
  return { status, body };
}

export interface PostServiceTeamActionBody {
  workerId: string;
  reasonCategory?: string;
}

/**
 * `POST /api/admin/patients/:id/contracted-services/:sid/team/reject|revert` — cru, sem mock.
 * Devolve `{ status, body }` para o teste decidir (200 recalculado, ou 422
 * `SERVICE_TEAM_REASON_REQUIRED`/`SERVICE_TEAM_REASON_INVALID`/`SERVICE_TEAM_WORKER_ALLOCATED`).
 */
export async function postServiceTeamAction(
  request: APIRequestContext,
  patientId: string,
  serviceId: string,
  action: 'reject' | 'revert',
  body: PostServiceTeamActionBody,
): Promise<ServiceTeamApiResult> {
  const token = tokenFor(QUADRO_C_STAFF);
  const res = await request.post(
    `${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/team/${action}`,
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: body,
    },
  );
  const status = res.status();
  const responseBody = (await res.json().catch(() => ({ success: false }))) as ServiceTeamApiResult['body'];
  return { status, body: responseBody };
}

/**
 * Conta linhas de `contracted_service_rejections` para o par (serviceId, workerId).
 * `active: true` → só `reverted_at IS NULL`; `active: false` → só revertidas; omitido → todas.
 */
export function countMarks(serviceId: string, workerId: string, opts: { active?: boolean } = {}): number {
  let sql = `SELECT count(*) FROM contracted_service_rejections WHERE service_id = '${serviceId}' AND worker_id = '${workerId}'`;
  if (opts.active === true) sql += ' AND reverted_at IS NULL';
  if (opts.active === false) sql += ' AND reverted_at IS NOT NULL';
  return Number(runSQL(sql));
}

/**
 * Ficha do paciente → clique real na aba `contractedService` (`PD/PatientProfileTabs.tsx:19`) →
 * espera o card renderizar. Molde `clickFoguete` (lancamento-e2e-helper.ts:354-378), sem o
 * `realClick` por `evaluate` — os irmãos que só clicam a aba usam `.click()` direto (achado: a
 * maioria dos specs @integration desta pasta, ex. `admission-b-campos...ts:154`).
 */
export async function openContractedServiceTab(page: Page, patientId: string): Promise<void> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  const detailLoaded = page
    .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
    .catch(() => null);
  await page.goto(`/admin/patients/${patientId}`);
  await detailLoaded;
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
  await expect(page.getByTestId('servicos-contratados-card')).toBeVisible({ timeout: 15_000 });
}

/**
 * Clica a linha do serviço (seleciona o quadro C **e** abre o drawer de detalhe, DX-10.9) e fecha
 * o drawer pelo testid `contracted-service-detail-close` (`ContractedServiceDetailDrawer.tsx:110`)
 * — o quadro C continua selecionado, só o drawer sai do caminho das asserções da seção.
 */
export async function selectServiceRow(page: Page, serviceId: string): Promise<void> {
  const row = page.getByTestId(`contracted-service-row-${serviceId}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const closeBtn = page.getByTestId('contracted-service-detail-close');
  await expect(closeBtn).toBeVisible({ timeout: 15_000 });
  await closeBtn.click();
  // O drawer some da tela em `CLOSE_MS` (300 ms, `ContractedServiceDetailDrawer.tsx:19,54`) e só
  // DESMONTA (`selected` vira `null` no pai) depois desse timer — sem esperar o unmount, uma
  // re-seleção da MESMA linha logo em seguida cai no meio da animação (o `key={selected.id}` não
  // muda, o componente não remonta) e o botão de fechar fica "detached", achado do P24.
  await expect(closeBtn).not.toBeAttached({ timeout: 2_000 });
}

/**
 * Limpa o que é DESTE quadro (marcas + itinerário) por `patient_id`/`service_id`, nunca por
 * título (aprendizado da Fase 8). A marca aponta para `workers` NO ACTION — por isso esta função
 * sai ANTES de `cleanupWJAAndEncuadre`/`cleanupTestWorker`/`seed.cleanup()` na ordem do chamador.
 */
export function cleanupQuadroC(patientId: string): void {
  if (!patientId) return;
  runSQL(
    `DELETE FROM contracted_service_rejections WHERE service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id = '${patientId}')`,
  );
  cleanupItinerary(patientId);
}
