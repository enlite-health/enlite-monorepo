/**
 * lancamento-e2e-helper.ts
 *
 * Helpers do lançamento da vaga à Talentum (Fase 6, change cadeia-paciente-vacante-itinerario,
 * P4 — DX-6.8/DX-6.9): stub HTTP da Talentum (molde `startPeriskopeStub`,
 * compativeis-e2e-helper.ts:276-301, com o ciclo login+prescreening que `TalentumApiClient`
 * exige), o mock do `/generate-ai-content`, a semente do paciente lançável, o caminho completo
 * pela tela (foguete → wizard → publish, molde `_prints-antes-fase-6...ts` do P1 e
 * `vacancy-draft-wizard-locked.integration.e2e.ts:285-304`) e o atalho por API para os irmãos
 * da sabotagem (DX-6.12).
 *
 * Reusa sem copiar: `insertTestPatient`/`insertTestWorker`/`cleanupTestWorker` (db-test-helper.ts),
 * `runSQL`/`cleanupPatientDeep` (patient-detail-a-helper.ts), `tokenFor`/`MockUser`
 * (abac-stack-helper.ts). Nunca mocka `publish-talentum` — vai ao backend, que vai ao stub.
 */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { insertTestPatient, insertTestWorker } from './db-test-helper';
import { runSQL, cleanupPatientDeep } from './patient-detail-a-helper';
import { tokenFor, loginAs, type MockUser } from './abac-stack-helper';
import { seedMockStaff, cleanupMockStaff } from './vacancy-notes-e2e-helper';

/**
 * URL do backend (E2E-F6/CI sempre setam `E2E_BACKEND_URL`) — nunca host/porta literal (G2).
 * Mesmo fallback dos irmãos (`funil-vacante.integration.e2e.ts:37`, `abac-stack-helper.ts`):
 * `?? 'http://localhost:8080'`, a api do CI. Lido DENTRO das funções que o usam — nunca no topo
 * do módulo/import: `const X = backendUrl()` de import quebrou a COLETA inteira do Playwright
 * (o projeto `integration` carrega todos os specs antes do `--grep`), derrubando 3 jobs do CI
 * que não setam a env (B1, `evidencias/fase-6/veredito-fecho.md`). Nenhum `throw` aqui.
 */
export function backendUrl(): string {
  return process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';
}

/** Staff interno só para autenticar as chamadas de API deste helper (nunca exposto ao teste). */
const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-admin-lancamento-f6',
  email: 'admin.lancamento.f6@e2e.test',
  role: 'admin',
  country: 'AR',
};

// ── Stub da Talentum (DX-6.8) ────────────────────────────────────────────────────

export interface TalentumStubCall {
  method: string;
  path: string;
}

export interface TalentumStub {
  server: http.Server;
  calls: TalentumStubCall[];
  mode: 'accept' | 'reject';
  close: () => Promise<void>;
}

/**
 * Stub da Talentum v2: aceita o ciclo `POST /auth/login` (cookies `tl_auth`+`tl_refresh`, os dois —
 * `TalentumApiClient.login()` exige ambos), `POST /projects` (cria; devolve só `projectId`), e por projeto
 * `GET /projects/:id/prescreening` (dá `publicId`/`slug`, os campos que `PublishVacancyToTalentumUseCase`
 * lê para montar o link WEB), `PATCH /prescreening`, `PUT /prescreening/job-description`, `POST
 * /complete-submodule`, `POST /init` e `DELETE /projects/:id`. Porta de `TALENTUM_STUB_PORT` (default
 * 9914) — um processo por vez (Playwright `--workers=1`, o stub é por processo). `stub.mode = 'reject'`
 * faz o PRÓXIMO `POST /projects` devolver 500 `{"error":"stub-reject"}` (critério 7,
 * DX-6.12). `calls` guarda só `{ method, path }` — nunca o corpo (a vaga leva título/descrição nele).
 */
export function startTalentumStub(): Promise<TalentumStub> {
  const port = Number(process.env.TALENTUM_STUB_PORT ?? 9914);
  const calls: TalentumStubCall[] = [];
  let mode: 'accept' | 'reject' = 'accept';
  let projectSeq = 0;
  const publicIds = new Map<string, string>();

  const server = http.createServer((req, res) => {
    req.on('data', () => {
      /* corpo descartado de propósito — calls nunca registra body (PII/texto da vaga) */
    });
    req.on('end', () => {
      const method = req.method ?? '';
      const path = (req.url ?? '').split('?')[0];
      calls.push({ method, path });

      if (method === 'POST' && path === '/auth/login') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': ['tl_auth=stub-auth', 'tl_refresh=stub-refresh'],
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === 'POST' && path === '/projects') {
        if (mode === 'reject') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'stub-reject' }));
          return;
        }
        projectSeq += 1;
        // `talentum_public_id` é UUID no schema (migration 106) — publicId tem de ser um UUID de
        // verdade; só `projectId` (VARCHAR) precisa ser previsível para o GET/DELETE por caminho.
        // v2: o POST devolve só `projectId`; o `publicId` vem do GET /projects/:id/prescreening.
        const id = `stub-proj-${projectSeq}`;
        publicIds.set(id, randomUUID());
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projectId: id }));
        return;
      }

      const projMatch = /^\/projects\/(stub-proj-\d+)(\/.*)?$/.exec(path);
      if (projMatch && publicIds.has(projMatch[1])) {
        const id = projMatch[1];
        const sub = projMatch[2] ?? '';
        if (method === 'GET' && sub === '/prescreening') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              projectId: id,
              title: id,
              publicId: publicIds.get(id),
              slug: `stub-slug-${id}`,
              active: true,
              jobDescription: { text: '', truncated: false },
              questions: [],
            }),
          );
          return;
        }
        if (method === 'GET' && sub === '') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ project: { _id: id, status: 'IN_PROGRESS', type: 'FULL', myRole: 'OWNER' } }));
          return;
        }
        if (method === 'PATCH' && sub === '/prescreening') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (method === 'PUT' && sub === '/prescreening/job-description') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: '', truncated: false }));
          return;
        }
        if (method === 'POST' && sub === '/complete-submodule') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (method === 'POST' && sub === '/init') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
        if (method === 'DELETE' && sub === '') {
          publicIds.delete(id);
          res.writeHead(204);
          res.end();
          return;
        }
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stub: rota não coberta' }));
    });
  });

  return new Promise<TalentumStub>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`porta ${port} ocupada — outro stub/sessão`));
        return;
      }
      reject(err);
    });
    server.listen(port, '0.0.0.0', () => {
      const stub: TalentumStub = {
        server,
        calls,
        get mode(): 'accept' | 'reject' {
          return mode;
        },
        set mode(v: 'accept' | 'reject') {
          mode = v;
        },
        close: () => new Promise<void>((res) => server.close(() => res())),
      };
      resolve(stub);
    });
  });
}

// ── Mock do /generate-ai-content (Gemini custaria — só essa rota é mockada) ─────────

/**
 * Instala `page.route('**\/generate-ai-content', …)` com 1 pergunta e descrição não vazia —
 * molde `admission-patient-flow.integration.e2e.ts:38-54` e
 * `vacancy-draft-wizard-locked.integration.e2e.ts:132-146`. É a única rota mockada no navegador
 * (`publish-talentum` NUNCA é mockado aqui).
 */
export async function mockGenerateAiContent(page: Page): Promise<void> {
  await page.route('**/generate-ai-content', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          description: 'Descripción generada por IA para el lanzamiento — Fase 6.',
          prescreening: {
            questions: [
              {
                question: '¿Tenés disponibilidad para este caso?',
                responseType: ['YES_NO'],
                desiredResponse: 'YES',
                weight: 2,
                required: true,
                analyzed: true,
                earlyStoppage: false,
              },
            ],
            faq: [],
          },
        },
      }),
    });
  });
}

// ── Boilerplate comum aos 5 specs de lançamento (G2: DRY, sem mudar asserção) ───────

/** `FunnelStageItem` do corpo de `GET /funnel` — mesmo shape repetido nos specs de lançamento. */
export interface FunnelStageItem {
  id: string;
  workerId?: string | null;
}

/** Viewport/locale/timezone padrão dos specs que passam por `/talentum` (es-AR, Buenos Aires). */
export const LANCAMENTO_VIEWPORT_ES_AR = {
  viewport: { width: 1366, height: 768 },
  locale: 'es-AR',
  timezoneId: 'America/Argentina/Buenos_Aires',
} as const;

/** Staff admin isolado por spec — mesmo shape de `MOCK_STAFF` acima, uid/email próprios por `slug`. */
export function mockAdminUserFor(slug: string): MockUser {
  return {
    uid: `e2e-int-admin-lancamento-${slug}-f6`,
    email: `admin.lancamento.${slug}.f6@e2e.test`,
    role: 'admin',
    country: 'AR',
  };
}

/** `beforeAll`/`afterAll` do staff mock do spec — mesmo par `seedMockStaff`/`cleanupMockStaff` repetido nos 5. */
export function useLancamentoStaff(user: MockUser, label: string): void {
  test.beforeAll(() => {
    seedMockStaff(user, label);
  });
  test.afterAll(() => {
    cleanupMockStaff(user);
  });
}

/**
 * Login + mock do `/generate-ai-content` NA ORDEM CERTA: `mockGenerateAiContent` tem de vir
 * DEPOIS do `loginAs` — `swapToken` (registrado por `loginAs`, `abac-stack-helper.ts:134`) vence
 * rotas registradas antes dele, então instalar o mock antes do login manda `/generate-ai-content`
 * para a API real (medido: 400 "Prompt document ID não configurado"). Molde original em
 * `funil-vacante-lancamento.integration.e2e.ts` (P12).
 */
export async function loginAndMockAi(page: Page, user: MockUser): Promise<void> {
  await loginAs(page, user);
  await mockGenerateAiContent(page);
}

// ── POST .../contracted-services (fonte única — G2: DRY entre seedLaunchablePatient e
//    o e2e de itinerário, `itinerario-e2e-helper.ts`) ────────────────────────────────

export interface ContractedServiceBody {
  serviceCode: 'AT' | 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST';
  providersNeeded: number;
  weeklyHours: number;
  careLocation: string;
  addressId: string;
  schedule?: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
}

/**
 * `POST /patients/:id/contracted-services` — MESMO POST que `seedLaunchablePatient` fazia
 * inline (mesma URL, headers, corpo e leitura de `data.id`); reusado também por
 * `itinerario-e2e-helper.ts` (`createServiceViaApi`, G2). `token` fica a cargo do chamador
 * (cada helper autentica com o próprio `MockUser` — molde `launchViaApi` acima).
 */
export async function postContractedServiceViaApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  body: ContractedServiceBody,
): Promise<string> {
  const res = await request.post(`${backendUrl()}/api/admin/patients/${patientId}/contracted-services`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
  });
  if (!res.ok()) {
    throw new Error(
      `postContractedServiceViaApi: POST contracted-services falhou ${res.status()}: ${await res.text()}`,
    );
  }
  return ((await res.json()) as { data: { id: string } }).data.id;
}

// ── Semente do paciente lançável ─────────────────────────────────────────────────

export interface SeedLaunchablePatientOpts {
  status: string;
  lat: number;
  lng: number;
}

export interface SeedLaunchablePatientResult {
  patientId: string;
  addressId: string;
  serviceId: string;
  /** Apaga a(s) vaga(s) nascidas do foguete/wizard e o paciente inteiro. */
  cleanup: () => void;
}

/**
 * Paciente com endereço (status/lat/lng dados) + 1 serviço contratado (AT, 20h, 1 faixa) criado
 * pela API real com token de `tokenFor` (molde `vacancy-draft-wizard-locked...:212-224` /
 * `_prints-antes-fase-6...:86-98`). `cleanup()` chama `cleanupPatientDeep`, que já apaga
 * `job_postings`/`patient_contracted_services`/`patient_addresses` do paciente.
 */
export async function seedLaunchablePatient(
  request: APIRequestContext,
  opts: SeedLaunchablePatientOpts,
): Promise<SeedLaunchablePatientResult> {
  const { status, lat, lng } = opts;
  const { patientId, addressId } = insertTestPatient({
    status,
    withAddress: true,
    addressLat: lat,
    addressLng: lng,
    hasConsent: true,
    insuranceInformed: 'OSDE',
  });
  if (!addressId) {
    throw new Error('seedLaunchablePatient: insertTestPatient não devolveu addressId');
  }

  const token = tokenFor(MOCK_STAFF);
  const serviceId = await postContractedServiceViaApi(request, token, patientId, {
    serviceCode: 'AT',
    providersNeeded: 1,
    weeklyHours: 20,
    careLocation: 'HOME',
    addressId,
    schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
  });

  const cleanup = (): void => {
    cleanupPatientDeep(patientId);
  };

  return { patientId, addressId, serviceId, cleanup };
}

/** Insere `n` workers REGISTERED/AT perto de (lat,lng), um por 0.0009° de latitude (~100 m). */
export function seedWorkersNear(lat: number, lng: number, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(insertTestWorker({ occupation: 'AT', lat: lat + 0.0009 * (i + 1), lng }));
  }
  return ids;
}

// ── Caminho pela tela: foguete → wizard → publish ───────────────────────────────────

/**
 * Clique real (`evaluate`) — o mesmo motivo do `forceClick` do P1
 * (`_prints-antes-fase-6...ts`): o banner do Firebase Auth Emulator fica fixo no rodapé e
 * intercepta o hit-test de coordenada mesmo com `force:true`.
 */
async function realClick(locator: ReturnType<Page['getByTestId']>): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el: HTMLElement) => el.click());
}

/**
 * Ficha do paciente → aba "Servicio Contratado" → foguete
 * `contracted-service-activate-recruitment-<sid>` (molde
 * `admission-c-servico-contratado.integration.e2e.ts:208-211`). Espera o `POST
 * .../activate-recruitment` (201) e devolve o `vacancyId` do corpo.
 */
export async function clickFoguete(page: Page, patientId: string, serviceId: string): Promise<string> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  const detailLoaded = page
    .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
    .catch(() => null);
  await page.goto(`/admin/patients/${patientId}`);
  await detailLoaded;
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 15_000 });
  await realClick(page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }));

  const activateBtn = page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`);
  await expect(activateBtn).toBeVisible({ timeout: 15_000 });

  const activated = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/activate-recruitment$/.test(r.url()),
    { timeout: 30_000 },
  );
  await realClick(activateBtn);
  const res = await activated;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data?: { vacancyId?: string } };
  const vacancyId = body.data?.vacancyId;
  if (!vacancyId) throw new Error('clickFoguete: resposta de activate-recruitment sem vacancyId');
  return vacancyId;
}

/**
 * `/admin/vacancies/<v>/borrador` → `complete-vacancy-btn` → wizard (profissão AT, salário,
 * meet — molde `vacancy-draft-wizard-locked.integration.e2e.ts:285-304`) → `create-vacancy-save-btn`
 * → a URL vira `/admin/vacancies/<v>/talentum`. Nunca `fill()`.
 */
export async function completeDraftViaWizard(page: Page, vacancyId: string): Promise<void> {
  await page.goto(`/admin/vacancies/${vacancyId}/borrador`);
  await expect(page.getByTestId('complete-vacancy-btn')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('complete-vacancy-btn').click();
  await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}/edit$`), { timeout: 15_000 });

  await page.locator('label[for="profession-AT"]').click();
  await expect(page.getByTestId('profession-checkbox-AT')).toBeChecked();

  const salaryInput = page.getByTestId('salary-text-input');
  await salaryInput.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('$5000');
  await expect(salaryInput).toHaveValue('$5000');

  const meetInput = page.getByTestId('meet-link-0');
  await meetInput.click();
  await page.keyboard.type('meet.google.com/abc-defg-hij');
  await meetInput.blur();

  const saveBtn = page.getByTestId('create-vacancy-save-btn');
  await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
  await saveBtn.click();
  await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}/talentum`), { timeout: 30_000 });
}

/**
 * `/admin/vacancies/<v>/talentum` → botão "Publicar en Talentum" (`TalentumConfigPage.tsx:150-160`,
 * mesmo `getByRole` usado em `admission-patient-flow.integration.e2e.ts:335` — a página não tem
 * testid próprio no botão). Devolve o status HTTP do `POST .../publish-talentum` (por
 * `waitForResponse`) — a rota nunca é mockada.
 */
export async function publishOnTalentumPage(page: Page, vacancyId: string): Promise<number> {
  await page.goto(`/admin/vacancies/${vacancyId}/talentum`);
  const publishBtn = page.getByRole('button', { name: /Publicar en Talentum/i });
  await expect(publishBtn).toBeVisible({ timeout: 15_000 });

  const publishResp = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/publish-talentum$/.test(r.url()),
    { timeout: 30_000 },
  );
  await publishBtn.click();
  const res = await publishResp;
  return res.status();
}

/**
 * Abre `/admin/patients/kanban` e espera o board renderizar (regra 10: sem `fill()`, nenhum
 * aqui). Base de `readPatientKanbanColumn` abaixo e do `openPatientKanban` de
 * `kanban-subcard-e2e-helper.ts` (G2, achado 7 — as mesmas 2 linhas não se copiam duas vezes).
 */
export async function openPatientKanbanBoard(page: Page): Promise<void> {
  await page.goto('/admin/patients/kanban');
  await expect(page.locator('[data-testid="patient-kanban-board"]')).toBeVisible({ timeout: 20_000 });
}

/**
 * Id da coluna `kanban-column-*` que contém `patient-kanban-card-<p>` (mesma seleção de
 * `kanban-pacientes.integration.e2e.ts:110-111` / P1), depois de `scrollIntoViewIfNeeded`.
 */
export async function readPatientKanbanColumn(page: Page, patientId: string): Promise<string> {
  await openPatientKanbanBoard(page);
  const card = page.getByTestId(`patient-kanban-card-${patientId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.scrollIntoViewIfNeeded();
  const columnTestId = await card.evaluate((el) => {
    const col = el.closest(
      '[data-testid^="kanban-column-"]:not([data-testid$="-count"]):not([data-testid$="-collapse"])',
    );
    return col?.getAttribute('data-testid') ?? null;
  });
  return columnTestId ? columnTestId.replace('kanban-column-', '') : 'NOT_FOUND';
}

// ── Trilha do lançamento ─────────────────────────────────────────────────────────────

/** Conta `patient_status_history` do paciente com `change_source = 'vacancy_launch'`. */
export function countLaunchTrail(patientId: string): number {
  const out = runSQL(
    `SELECT count(*) FROM patient_status_history WHERE patient_id = '${patientId}' AND change_source = 'vacancy_launch'`,
  );
  return Number(out.trim());
}

// ── Atalho por API (irmãos da sabotagem, DX-6.12) ───────────────────────────────────

/**
 * Monta o cenário de publish SEM tela: grava as perguntas de prescreening + a descrição
 * (a mesma ordem de `useTalentumConfig.ts:214-222` — sem isso o publish regeneraria via IA ou
 * devolveria 400 "No prescreening questions") e então publica. Devolve o status HTTP do publish
 * (200 aceito; 502 quando `stub.mode = 'reject'`). Nunca mocka `publish-talentum`.
 */
export async function launchViaApi(
  request: APIRequestContext,
  token: string,
  vacancyId: string,
): Promise<number> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const url = backendUrl();

  const prescreeningRes = await request.post(
    `${url}/api/admin/vacancies/${vacancyId}/prescreening-config`,
    {
      headers,
      data: {
        questions: [
          {
            question: '¿Tenés disponibilidad para este caso?',
            responseType: ['YES_NO'],
            desiredResponse: 'YES',
            weight: 2,
            required: true,
            analyzed: true,
            earlyStoppage: false,
          },
        ],
        faq: [],
      },
    },
  );
  if (!prescreeningRes.ok()) {
    throw new Error(
      `launchViaApi: POST prescreening-config falhou ${prescreeningRes.status()}: ${await prescreeningRes.text()}`,
    );
  }

  const descRes = await request.put(`${url}/api/admin/vacancies/${vacancyId}/talentum-description`, {
    headers,
    data: { description: 'Descripción de prueba — lanzamiento Fase 6.' },
  });
  if (!descRes.ok()) {
    throw new Error(
      `launchViaApi: PUT talentum-description falhou ${descRes.status()}: ${await descRes.text()}`,
    );
  }

  const publishRes = await request.post(`${url}/api/admin/vacancies/${vacancyId}/publish-talentum`, {
    headers,
  });
  return publishRes.status();
}
