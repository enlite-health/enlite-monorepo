/**
 * cadeia-completa-e2e-helper.ts
 *
 * Helper do e2e da cadeia inteira (Fase 16, change cadeia-paciente-vacante-itinerario, P2 —
 * DX-16.5, DX-16.6, DX-16.7, DX-16.14). Só COMPÕE os helpers das Fases 1-15; novo aqui é só o que
 * nenhum irmão tem: coordenadas de X/Y/Z, marca dos workers por papel, régua de host do navegador,
 * fonte da última mudança de status, resíduo por id e a limpeza da cadeia inteira.
 * Semente: X (2 serviços em endereços diferentes, com horário), Y (outro paciente/endereço, passo
 * 7), Z (o silêncio). M pelo `seedWorkersNear` (entra no match); WA/WB/WC/WS/WZ com `CADEIA_MARK`,
 * sem coordenada, criados DEPOIS do publish. A régua dos critérios 5/6 é por id (DX-16.7).
 *
 * Limpeza (regra 13 do brief), por `patient_id`: ausência → alocação → marcas → montado
 * (`cleanupSubstituicao`, que já chama `cleanupItineraryWrite` → `cleanupQuadroC`) → WJA/vaga
 * (`cleanupWJAAndEncuadre`) → worker (`cleanupTestWorker`) → serviço → paciente (`seed.cleanup()`,
 * que é o `cleanupPatientDeep`).
 *
 * NÃO importar nada que a Fase 15 criou (DX-16.9: o revert do P8 quebraria a coleta). URL só por
 * `backendUrl()`, lida DENTRO das funções; nenhum `throw` no import; nenhum host/porta literal.
 */
import { type APIRequestContext, type Page } from '@playwright/test';
import {
  backendUrl, seedLaunchablePatient, seedWorkersNear, readPatientKanbanColumn,
} from './lancamento-e2e-helper';
import { createServiceViaApi, activateRecruitmentViaApi } from './itinerario-e2e-helper';
import { insertSecondAddress } from './itinerario-escrita-e2e-helper';
import { cleanupSubstituicao } from './substituicao-e2e-helper';
import { cleanupWJAAndEncuadre } from './wja-test-helper';
import { insertTestWorker, cleanupTestWorker } from './db-test-helper';
import { runSQL } from './patient-detail-a-helper';
import { readSubcardPair, collectDataRequests } from './kanban-subcard-e2e-helper';

/** Marca SINTÉTICA dos workers por papel (`first_name`/`last_name`). Nunca impressa na prova. */
export const CADEIA_MARK = 'CadeiaE2E';

/** Coordenadas PRÓPRIAS deste arquivo (DX-16.5) — nenhum outro spec usa estas. */
export const CADEIA_COORDS = {
  X: { lat: -47.1234, lng: -65.4321 },
  Y: { lat: -47.1834, lng: -65.4921 },
  Z: { lat: -47.2434, lng: -65.5521 },
} as const;

/** Canal real (DX-16.6 (i)): o navegador NUNCA fala com estes HOSTNAMES → 0. */
export const CADEIA_FORBIDDEN_HOSTS = /twilio|whatsapp|wa\.me|facebook|periskope|talentum\.chat|groq|generativelanguage/i;

/** Contado À PARTE (DX-16.6 (iii)): só entra no `expect` se a 1ª rodada medir 0 (P7). */
export const CADEIA_OBSERVED_HOSTS = /maps\.googleapis\.com/i;

export interface CadeiaPatientX {
  patientId: string; addressId: string; address2Id: string;
  service1Id: string; service2Id: string; cleanup: () => void;
}

export interface CadeiaPatientWithVacancy {
  patientId: string; addressId: string; serviceId: string; vacancyId: string; cleanup: () => void;
}

/** Falha no meio da semente desmonta o que já nasceu (mesma ordem da limpeza) e relança. */
function orUndo<T>(patientId: string, cleanup: () => void, build: () => Promise<T>): Promise<T> {
  return build().catch((err: unknown) => {
    cleanupSubstituicao(patientId);
    cleanup();
    throw err;
  });
}

/** X: `seedLaunchablePatient` (Admissão, cobertura informada; serviço 1 seg 08-12) + 2º endereço + serviço 2 ter 08-12. */
export async function seedPatientX(request: APIRequestContext): Promise<CadeiaPatientX> {
  const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', ...CADEIA_COORDS.X });
  return orUndo(seed.patientId, seed.cleanup, async () => {
    const address2Id = insertSecondAddress(seed.patientId);
    const service2Id = await createServiceViaApi(request, seed.patientId, {
      addressId: address2Id,
      schedule: [{ dayOfWeek: 2, startTime: '08:00', endTime: '12:00' }],
    });
    return {
      patientId: seed.patientId, addressId: seed.addressId, address2Id,
      service1Id: seed.serviceId, service2Id, cleanup: seed.cleanup,
    };
  });
}

/** Y: outro endereço; serviço com 2 faixas na seg (12:30 e 13:00 até 16:00) e a vaga ativa (WJA de WA, passo 7). */
export async function seedPatientY(request: APIRequestContext): Promise<CadeiaPatientWithVacancy> {
  const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', ...CADEIA_COORDS.Y });
  return orUndo(seed.patientId, seed.cleanup, async () => {
    const serviceId = await createServiceViaApi(request, seed.patientId, {
      addressId: seed.addressId,
      schedule: [
        { dayOfWeek: 1, startTime: '12:30', endTime: '16:00' },
        { dayOfWeek: 1, startTime: '13:00', endTime: '16:00' },
      ],
    });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, serviceId);
    return { patientId: seed.patientId, addressId: seed.addressId, serviceId, vacancyId, cleanup: seed.cleanup };
  });
}

/** Z (o silêncio): Admissão + a vaga do serviço dele ativa; o publish fica com o teste (stub). */
export async function seedPatientZ(request: APIRequestContext): Promise<CadeiaPatientWithVacancy> {
  const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', ...CADEIA_COORDS.Z });
  return orUndo(seed.patientId, seed.cleanup, async () => {
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    return { patientId: seed.patientId, addressId: seed.addressId, serviceId: seed.serviceId, vacancyId, cleanup: seed.cleanup };
  });
}

/** X + Y + M (o único worker perto de X — é quem prova o match). Os de papel vêm depois do publish. */
export async function seedCadeia(request: APIRequestContext): Promise<{ x: CadeiaPatientX; y: CadeiaPatientWithVacancy; m: string }> {
  const x = await seedPatientX(request);
  const y = await orUndo(x.patientId, x.cleanup, () => seedPatientY(request));
  const [m] = seedWorkersNear(CADEIA_COORDS.X.lat, CADEIA_COORDS.X.lng, 1);
  return { x, y, m };
}

/** Worker AT sintético com a marca e o papel no nome; sem coordenada (fora do match). */
export function seedMarkedWorker(role: string): string {
  return insertTestWorker({ occupation: 'AT', firstName: `${CADEIA_MARK}${role}`, lastName: CADEIA_MARK });
}

/** WA titular, WB só-Selecionados-de-B, WC rejeitado em C, WS substituto (DX-16.5). */
export function seedRoleWorkers(): { wa: string; wb: string; wc: string; ws: string } {
  return { wa: seedMarkedWorker('WA'), wb: seedMarkedWorker('WB'), wc: seedMarkedWorker('WC'), ws: seedMarkedWorker('WS') };
}

/** `change_source` da ÚLTIMA linha de `patient_status_history` do paciente ('' se nenhuma). */
export function lastStatusChangeSource(patientId: string): string {
  return runSQL(
    `SELECT change_source FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
}

/** `count(*)` da tabela de pacientes inteira — o `pre` do início e o do fim (DX-16.7). */
export function countPatients(): number {
  return Number(runSQL('SELECT count(*) FROM patients'));
}

const inList = (ids: string[]): string => (ids.length ? ids.map((id) => `'${id}'`).join(',') : 'NULL');

/** As 4 contagens da DX-16.7, por id (controle ANTES da limpeza: `patients` = nº de ids). */
export function residueByIds(opts: { patientIds: string[]; workerIds: string[] }): {
  patients: number; workers: number; wja: number; assignments: number;
} {
  const p = inList(opts.patientIds);
  const w = inList(opts.workerIds);
  const n = (sql: string): number => Number(runSQL(sql));
  return {
    patients: n(`SELECT count(*) FROM patients WHERE id IN (${p})`),
    workers: n(`SELECT count(*) FROM workers WHERE id IN (${w})`),
    wja: n(`SELECT count(*) FROM worker_job_applications WHERE worker_id IN (${w})`),
    assignments: n(`SELECT count(*) FROM patient_itinerary_assignment WHERE worker_id IN (${w})`),
  };
}

/** Desmonta a cadeia na ordem da regra 13 (cabeçalho). Repetível: todo passo tolera zero linha. */
export function cleanupCadeia(opts: {
  patientIds: string[];
  workerVacancyPairs: Array<{ workerId: string; vacancyId: string }>;
  workerIds: string[];
  seeds: Array<{ cleanup: () => void }>;
}): void {
  for (const patientId of opts.patientIds) cleanupSubstituicao(patientId);
  for (const { workerId, vacancyId } of opts.workerVacancyPairs) cleanupWJAAndEncuadre(workerId, vacancyId);
  for (const workerId of new Set(opts.workerIds)) cleanupTestWorker(workerId);
  for (const seed of opts.seeds) seed.cleanup();
}

export interface CadeiaRequestTally {
  forbidden: string[]; observedHits: number; apiHits: number; dataRequests: string[];
}

/**
 * Registrar DEPOIS do `loginAndMockAi` (DX-16.6 (i)). Compara só o HOSTNAME (a própria api tem
 * `/workers/sync-talentum`); controle positivo `apiHits` = host da api (`backendUrl()`) → > 0.
 * `dataRequests` = `collectDataRequests` (as chamadas `/api/admin/patients` do navegador).
 */
export function collectRequests(page: Page): () => CadeiaRequestTally {
  const apiHost = new URL(backendUrl()).host;
  const forbidden: string[] = [];
  let observedHits = 0;
  let apiHits = 0;
  const dataRequests = collectDataRequests(page);
  page.on('request', (req) => {
    let url: URL;
    try { url = new URL(req.url()); } catch { return; }
    if (CADEIA_FORBIDDEN_HOSTS.test(url.hostname)) forbidden.push(url.hostname);
    if (CADEIA_OBSERVED_HOSTS.test(url.hostname)) observedHits += 1;
    if (url.host === apiHost) apiHits += 1;
  });
  return () => ({ forbidden: [...forbidden], observedHits, apiHits, dataRequests: dataRequests() });
}

/** Coluna do card do paciente no Kanban + o par `cobertas/contratadas` do subcard do serviço. */
export async function readKanbanState(page: Page, patientId: string, serviceId: string): Promise<{ column: string; pair: string }> {
  return { column: await readPatientKanbanColumn(page, patientId), pair: await readSubcardPair(page, serviceId) };
}

/** Caminho do print em `PRINT_DIR` (lido aqui dentro); `null` sem a env — o teste não printa. */
export function printPath(name: string): string | null {
  return process.env.PRINT_DIR ? `${process.env.PRINT_DIR}/${name}.png` : null;
}
