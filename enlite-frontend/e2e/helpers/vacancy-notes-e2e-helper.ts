/**
 * vacancy-notes-e2e-helper.ts
 *
 * Helpers dos e2e da Fase 3 (change cadeia-paciente-vacante-itinerario, P19):
 * anotações CRM da vaga (DX-3.3/DX-3.8), "última ação"/"dias sem divulgação"
 * (DX-3.4/DX-3.5/DX-3.6) e ordenação por distância (DX-3.10/DX-3.11).
 *
 * `seedMockStaff`/`cleanupMockStaff`: o mesmo INSERT/DELETE de `seedAdminUser`
 * em `funil-vacante.integration.e2e.ts:63-73`, parametrizado por `MockUser` —
 * os specs novos (DX-3.13) não copiam o helper privado de lá.
 *
 * `createNoteViaUi`: humano (click + `keyboard.type`), nunca `fill()`/`evaluate`
 * (memória `e2e-humano-nao-e-fill`). O campo "cuándo" é um `<input
 * type="datetime-local">`. A premissa original da DX-3.16 ("es-AR aceita
 * dígitos `ddmmaaaahhmm` por segmento") **não se sustentou**: MEDIDO (debug
 * descartável, contra a stack `cadeia-f3`, Chromium headless) que o widget
 * NATIVO de segmentos do Chromium ignora `test.use({ locale: 'es-AR' })` — a
 * ordem de clique é sempre `mm/dd/aaaa` (americana), e o segmento do ANO não
 * avança sozinho ao completar 4 dígitos (aceita até 6, por spec HTML de ano
 * estendido), então dígitos de hora digitados em seguida vazam pro ano e o
 * `el.value` fica com ano de 6 dígitos ou vazio ("incomplete or has an
 * invalid date"). A hora É 24h direto (sem segmento AM/PM) — isso sim é
 * `es-AR`/`Intl` chegando à página. Ordem que funciona, medida e reproduzida:
 * `mm` (2) → `dd` (2) → `aaaa` (4) → **ArrowRight explícito** (força sair do
 * ano) → `hh` 24h (2) → `mm` minuto (2). O fuso de Buenos Aires continua
 * vindo do `timezoneId` do `test.use` (DX-3.6/DX-3.16), não do locale de
 * exibição — "5 dias atrás" digitado é 5 dias de calendário de Buenos Aires
 * por construção (memória `teste-de-fuso-passa-por-coincidencia`).
 *
 * `seedVacancyWithCandidatesAtKm`: a mesma semente do P1
 * (`CH/evidencias/fase-3/prints/antes-spec.ts.txt`) — paciente com endereço,
 * vaga `SEARCHING`/publicada, um worker por km (ou sem coords quando o km é
 * `null`), WJA INVITED/system com `messaged_at` (sem isso a WJA fica presa em
 * "matched not invited" e não aparece em Invitados — `WJAFunnelController.ts`
 * ao redor de `isMatchedNotInvited`).
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  insertTestPatient,
  insertBaseVacancy,
  insertTestWorker,
  cleanupTestPatient,
  cleanupTestWorker,
} from './db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from './wja-test-helper';
import { runSQL } from './patient-detail-a-helper';
import type { MockUser } from './abac-stack-helper';

// ── Staff mock (users) ───────────────────────────────────────────────────────

/** Molde de `seedAdminUser` (`funil-vacante.integration.e2e.ts:63-73`), por `MockUser`. */
export function seedMockStaff(u: MockUser, displayName: string): void {
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, account_type, status) ` +
      `VALUES ('${u.uid}', '${u.email}', '${displayName.replace(/'/g, "''")}', 'admin', true, 'staff', 'ACTIVE') ` +
      `ON CONFLICT (firebase_uid) DO NOTHING`,
  );
}

export function cleanupMockStaff(u: MockUser): void {
  runSQL(`DELETE FROM users WHERE firebase_uid = '${u.uid}'`);
}

// ── Formulário da aba "Anotaciones" ──────────────────────────────────────────

export type VacancyNoteCategory = 'DIVULGACAO' | 'CONTATO' | 'OUTRO';

export interface CreateNoteViaUiOpts {
  /** Quando informado, digita o "cuándo" como `hoje − daysAgo` (fuso de Buenos
   *  Aires). Omitido: mantém o default do formulário (agora). */
  daysAgo?: number;
  /** Quando informado, digita o "cuándo" como `hoje + daysAhead` (fuso de
   *  Buenos Aires) — data no futuro, para provar a recusa do servidor
   *  (`occurredAt no futuro`, DX-3.3). Mutuamente exclusivo com `daysAgo`. */
  daysAhead?: number;
  category: VacancyNoteCategory;
  contact: string;
  body: string;
}

/**
 * Segmentos de `dd/mm/aaaa hh:mm` em Buenos Aires, separados (não
 * concatenados): a ORDEM de clique do widget nativo do Chromium é sempre
 * `mm/dd/aaaa` (medido — ignora `test.use({ locale })`), mas a hora é 24h
 * direto. `hourCycle: 'h23'` (não `hour12: false`): ICU vira `24` na meia-noite
 * com `hour12`, o segmento do input não aceita.
 */
function whenSegments(d: Date): { day: string; month: string; year: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { day: get('day'), month: get('month'), year: get('year'), hour: get('hour'), minute: get('minute') };
}

/**
 * Digita `d` no `when` (`<input type="datetime-local">`) na ordem REAL do
 * widget nativo do Chromium headless (MEDIDO 26/09, `CH/evidencias/fase-3/provas/P19-datetime.md`):
 * `mm` → `dd` → `aaaa` → **ArrowRight** (o segmento do ano não avança sozinho
 * ao completar 4 dígitos, aceita até 6 por spec de ano estendido — sem o
 * ArrowRight, os dígitos da hora vazam pro ano) → `hh` (24h) → `mm`.
 */
async function typeWhen(page: Page, when: ReturnType<Page['getByTestId']>, d: Date): Promise<void> {
  const { day, month, year, hour, minute } = whenSegments(d);
  await when.click();
  await expect(when).toBeFocused();
  await page.keyboard.type(month);
  await page.keyboard.type(day);
  await page.keyboard.type(year);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type(hour);
  await page.keyboard.type(minute);
}

/**
 * Cria uma anotação pela tela (aba "Anotaciones" já aberta). Devolve o status
 * HTTP do `POST /api/admin/vacancies/:id/notes` que o save dispara.
 */
export async function createNoteViaUi(page: Page, opts: CreateNoteViaUiOpts): Promise<number> {
  const { daysAgo, daysAhead, category, contact, body } = opts;

  if (daysAgo !== undefined && daysAhead !== undefined) {
    throw new Error('daysAgo e daysAhead são exclusivos');
  }

  await page.getByTestId('vacancy-notes-new-button').click();

  if (daysAgo !== undefined) {
    const when = page.getByTestId('vacancy-note-when');
    const target = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    await typeWhen(page, when, target);
  } else if (daysAhead !== undefined) {
    const when = page.getByTestId('vacancy-note-when');
    const target = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
    await typeWhen(page, when, target);
  }

  await page.getByTestId('vacancy-note-category').selectOption(category);

  const contactInput = page.getByTestId('vacancy-note-contact');
  await contactInput.click();
  await expect(contactInput).toBeFocused();
  await page.keyboard.type(contact);

  const bodyInput = page.getByTestId('vacancy-note-body');
  await bodyInput.click();
  await expect(bodyInput).toBeFocused();
  await page.keyboard.type(body);

  const [response] = await Promise.all([
    page.waitForResponse((r) => /\/notes$/.test(r.url()) && r.request().method() === 'POST'),
    page.getByTestId('vacancy-note-save').click(),
  ]);
  return response.status();
}

// ── Leitura pela API ──────────────────────────────────────────────────────────

export interface VacancyNoteApi {
  id: string;
  jobPostingId: string;
  occurredAt: string;
  category: VacancyNoteCategory;
  contact: string;
  body: string;
  createdBy: string;
  authorEmail: string | null;
  createdAt: string;
}

/** `GET /api/admin/vacancies/:id/notes` (DX-3.3) — resposta `{ success, data }`. */
export async function listNotesApi(
  request: APIRequestContext,
  backendUrl: string,
  token: string,
  vacancyId: string,
): Promise<VacancyNoteApi[]> {
  const res = await request.get(`${backendUrl}/api/admin/vacancies/${vacancyId}/notes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `GET /api/admin/vacancies/${vacancyId}/notes falhou: ${res.status()}`).toBe(true);
  const parsed = (await res.json()) as { success: boolean; data: VacancyNoteApi[] };
  return parsed.data;
}

export interface VacancyListRow {
  id: string;
  [key: string]: unknown;
}

/** Molde `funil-vacante.integration.e2e.ts:84-96` (`readApiStageCounts`), mas
 *  devolve a LINHA inteira (`lastAction`/`daysWithoutDivulgation`/`distanceKm`
 *  entram por passo, nunca fixados aqui). */
export async function readVacancyListRow(
  request: APIRequestContext,
  backendUrl: string,
  token: string,
  vacancyId: string,
): Promise<VacancyListRow> {
  const res = await request.get(`${backendUrl}/api/admin/vacancies?limit=20&offset=0`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `GET /api/admin/vacancies falhou: ${res.status()}`).toBe(true);
  const body = (await res.json()) as { data: VacancyListRow[] };
  const row = body.data.find((v) => v.id === vacancyId);
  if (!row) throw new Error(`vaga ${vacancyId} não encontrada em GET /api/admin/vacancies`);
  return row;
}

// ── Semente "vaga com candidatos a N km" (a mesma do P1) ─────────────────────

export interface SeedVacancyWithCandidatesResult {
  patientId: string;
  vacancyId: string;
  workerIds: string[];
  wjaIds: string[];
  cleanup: () => void;
}

// Latitude do paciente-base do P1 (`antes-spec.ts.txt:80-93`): 1 grau ~ 111,2 km,
// mesma longitude — cada worker nasce a exatamente `km` de distância.
const BASE_LAT = -34.6037;
const BASE_LNG = -58.3816;

/**
 * Paciente com endereço + vaga `SEARCHING`/publicada + um worker por km (ou
 * sem coords quando o km é `null`), cada um com WJA INVITED/system e
 * `messaged_at` (convite "real" — sem isso a WJA some de Invitados, vira
 * "matched not invited"). Devolve os ids e o `cleanup` (worker → WJA/encuadre
 * → paciente, que cascade-apaga a vaga).
 */
export function seedVacancyWithCandidatesAtKm(kms: Array<number | null>): SeedVacancyWithCandidatesResult {
  const { patientId, addressId } = insertTestPatient({
    withAddress: true,
    firstName: 'VacancyNotesE2E',
    lastName: `Seed-${Date.now()}`,
  });
  const caseNumber = 986_000 + Math.floor(Math.random() * 900);
  const vacancyId = insertBaseVacancy({
    patientId,
    patientAddressId: addressId!,
    caseNumber,
    status: 'SEARCHING',
    isDraft: false,
  });

  const workerIds: string[] = [];
  const wjaIds: string[] = [];
  kms.forEach((km, idx) => {
    const lat = km === null ? null : BASE_LAT + km / 111.2;
    const lng = km === null ? null : BASE_LNG;
    const label = km === null ? 'SemEndereco' : `Km${km}`;
    const workerId = insertTestWorker({
      firstName: `VacancyNotes${label}`,
      lastName: `E2E${Date.now()}-${idx}`,
      lat,
      lng,
    });
    workerIds.push(workerId);
    const wjaId = insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'INVITED', source: 'system' });
    runSQL(`UPDATE worker_job_applications SET messaged_at = NOW() WHERE id = '${wjaId}'`);
    wjaIds.push(wjaId);
  });

  const cleanup = (): void => {
    for (const workerId of workerIds) {
      try {
        cleanupWJAAndEncuadre(workerId, vacancyId);
      } catch (err) {
        console.error('[cleanup] wja/encuadre falhou (seguindo)', err);
      }
      try {
        cleanupTestWorker(workerId);
      } catch (err) {
        console.error('[cleanup] worker falhou (seguindo)', err);
      }
    }
    try {
      cleanupTestPatient(patientId);
    } catch (err) {
      console.error('[cleanup] patient falhou (seguindo)', err);
    }
  };

  return { patientId, vacancyId, workerIds, wjaIds, cleanup };
}
