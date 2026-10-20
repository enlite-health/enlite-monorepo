/**
 * insurance-058a-helper.ts — o que os 6 specs `058a-*.integration.e2e.ts` (spec 058, Parte A) repetem: atores (staff REAL em grupo, células
 * concedidas por SQL), cenário montado pela API REAL (obra social, contrato, termo, vínculo), digitação humana e a limpeza.
 *
 * SEM MOCK de resposta: a API é a do stack (engine ABAC LIGADO), o banco é o do stack. A única interceptação de requisição do conjunto vem de `loginAs`
 * (troca o cabeçalho de autenticação; a resposta é a real) — fora dos arquivos 058a.
 * Massa SINTÉTICA: nomes `QA058A …`, nenhum dado de pessoa real.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { psql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, tokenFor, ABAC_API_URL, type MockUser } from './abac-stack-helper';

export const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();

export type Cell = [resource: string, action: string];

/** Cartões da obra social: todas as células da 058 Parte A que a tela usa (inclusive o valor e a cobertura). */
export const CELLS_INSURANCE_ALL: Cell[] = [
  ['catalog_insurance_providers', 'read'], ['catalog_insurance_providers', 'create'], ['catalog_insurance_providers', 'update'],
  ['insurance_provider_contacts', 'read'], ['insurance_provider_contacts', 'create'], ['insurance_provider_contacts', 'update'],
  ['insurance_contracts', 'read'], ['insurance_contracts', 'create'], ['insurance_contracts', 'update'],
  ['patient_contract_value', 'read'], ['patient_contract_value', 'create'],
  ['insurance_provider_patients', 'read'],
];

/** A ficha do paciente (abas, serviço, cobertura, projeto terapêutico) — o piso do molde do spec 048 + serviço + cobertura + valor. */
export const CELLS_FICHA: Cell[] = [
  ['patient', 'read'], ['patient_identity', 'read'], ['patient_coverage', 'read'], ['patient_coverage', 'update'], ['patient_address', 'read'],
  ['patient_services', 'read'], ['patient_services', 'update'], ['patient_family', 'read'], ['patient_care_team', 'read'],
  ['patient_clinical', 'read'], ['patient_clinical', 'write'],
  ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'update'],
  ['patient_therapeutic_project', 'export'],
  ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_segments', 'read'],
  ['own_notifications', 'read'], ['own_notifications', 'update'],
];

export interface Actor {
  user: MockUser;
  groupId: string;
}

const actors: Actor[] = [];

/** Staff REAL (linha em `users`) num grupo com EXATAMENTE as células pedidas. Concede ANTES do 1º login (o contrato tem cache de ~30 s). */
export function seedActor(tag: string, cells: Cell[]): Actor {
  const uid = `e2e-058a-${tag}-${RUN_ID}`.toLowerCase();
  const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };
  const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `058A ${tag} ${RUN_ID}`, country: 'AR' });
  for (const [r, a] of cells) grantCell(groupId, r, a);
  const actor = { user, groupId };
  actors.push(actor);
  return actor;
}

export function dropActors(): void {
  for (const a of actors.splice(0)) cleanupStaffAndGroup(a.user.uid, a.groupId);
}

// ── API real, como um ator ──────────────────────────────────────────────────────────────────────────────────────────

export interface ApiResult<T = any> {
  status: number;
  body: { success?: boolean; data?: T; error?: string; code?: string; details?: any } | null;
}

export async function api<T = any>(
  request: APIRequestContext,
  actor: Actor,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  data?: unknown,
): Promise<ApiResult<T>> {
  const res = await request.fetch(`${ABAC_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokenFor(actor.user)}`, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { data }),
    failOnStatusCode: false,
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Chama e exige o status (a falha do cenário aparece no passo certo, com o corpo). */
export async function apiOk<T = any>(
  request: APIRequestContext, actor: Actor, method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, data: unknown, status: number,
): Promise<T> {
  const r = await api<T>(request, actor, method, path, data);
  expect(r.status, `${method} ${path} -> ${JSON.stringify(r.body)}`).toBe(status);
  return r.body!.data as T;
}

/** O "hoje" de Buenos Aires, vindo da API (nunca do relógio do teste): `for-service` devolve `asOf` do país. */
export async function asOfAR(request: APIRequestContext, actor: Actor): Promise<string> {
  return (await apiOk<{ asOf: string }>(request, actor, 'GET', '/api/admin/insurance-providers/for-service?country=AR', undefined, 200)).asOf;
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export interface ProviderMade { code: string; name: string }

/** Cria a obra social pela API (só com o nome) e, se pedido, a classifica. O nome leva o RUN_ID: o código sai dele. */
export async function makeProvider(
  request: APIRequestContext, actor: Actor, label: string, payerKind: 'OBRA_SOCIAL' | 'PREPAGA' | null = 'OBRA_SOCIAL',
): Promise<ProviderMade> {
  const name = `QA058A ${label} ${RUN_ID}`;
  const created = await apiOk<{ code: string }>(request, actor, 'POST', '/api/admin/catalogs/insurance-providers', { name }, 201);
  if (payerKind) await apiOk(request, actor, 'PATCH', `/api/admin/insurance-providers/${created.code}`, { payerKind }, 200);
  return { code: created.code, name };
}

export interface ContractMade { id: string; name: string }

/** Contrato de AR com o 1º termo (vigente desde antes de hoje: o termo cobre o "hoje" do país). */
export async function makeContract(
  request: APIRequestContext, actor: Actor, providerCode: string, label: string,
  term: { hourlyRate: number; taxRatePercent: number; validFrom: string },
): Promise<ContractMade> {
  const name = `Contrato ${label} ${RUN_ID}`;
  const item = await apiOk<{ id: string }>(request, actor, 'POST', `/api/admin/insurance-providers/${providerCode}/contracts`,
    { name, country: 'AR', firstTerm: term }, 201);
  return { id: item.id, name };
}

// ── digitação humana ────────────────────────────────────────────────────────────────────────────────────────────────

/** Clica no campo como um humano, confere o foco e digita (sem `fill`). Devolve o que a TELA mostra. */
export async function digitar(page: Page, testId: string, texto: string): Promise<string> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

/** `<input type=date>`: foca o 1º segmento e digita MMDDAAAA (locale en-US do Chromium); o valor que FICOU é lido de volta. */
export async function digitarData(page: Page, testId: string, iso: string): Promise<void> {
  const campo = page.getByTestId(testId);
  await campo.focus();
  await expect(campo).toBeFocused();
  const [y, m, d] = iso.split('-');
  await page.keyboard.type(`${m}${d}${y}`);
  await expect(campo).toHaveValue(iso);
}

/** Troca o texto de um campo como um humano: clica, seleciona tudo (Ctrl/Cmd+A) e digita por cima. */
export async function substituir(page: Page, testId: string, texto: string): Promise<string> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(texto);
  return campo.inputValue();
}

/** Opção de um `<select>` nativo pelo RÓTULO que a pessoa lê. */
export async function escolher(page: Page, testId: string, rotulo: string): Promise<void> {
  await page.getByTestId(testId).selectOption({ label: rotulo });
  await expect(page.getByTestId(testId).locator('option:checked')).toHaveText(rotulo);
}

// ── limpeza ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Apaga o que esta rodada criou (obras sociais `QA058A … <RUN_ID>` e tudo que pende delas). `session_replication_role = replica`
 * desliga os triggers de imutabilidade só para o DELETE (superusuário do banco de teste). Chamar ANTES de apagar os pacientes (o vínculo
 * aponta para o serviço).
 */
export function purgeProviders(): void {
  // Nome `QA058A <rótulo> <RUN>` (criado por `makeProvider`) OU código explícito `QA058A…<RUN>…` (o caso "só símbolos" informa o código).
  const mine = `(name LIKE 'QA058A % ${RUN_ID}' OR code LIKE 'QA058A%${RUN_ID}%')`;
  const prov = `SELECT code FROM insurance_providers WHERE ${mine}`;
  const contr = `SELECT id FROM insurance_contracts WHERE provider_code IN (${prov})`;
  psql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    DELETE FROM contracted_service_contract WHERE contract_id IN (${contr});
    DELETE FROM insurance_contract_terms WHERE contract_id IN (${contr});
    DELETE FROM insurance_contracts WHERE provider_code IN (${prov});
    DELETE FROM insurance_provider_contacts WHERE provider_code IN (${prov});
    DELETE FROM insurance_provider_payer_kind_history WHERE provider_code IN (${prov});
    DELETE FROM patient_insurance_verified WHERE provider_code IN (${prov});
    DELETE FROM insurance_provider_aliases WHERE code IN (${prov});
    DELETE FROM insurance_providers WHERE ${mine};
    COMMIT;`);
}
