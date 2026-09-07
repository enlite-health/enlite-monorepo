/**
 * admin-map-prestadores-pacientes.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK DE API: navegador real → worker-functions real (Docker,
 * imagem desta branch) → Postgres+PostGIS real → Firebase Auth EMULATOR real.
 * Nenhuma interceptação de request no navegador. O Google Maps JS é o real (chave do .env) quando há rede;
 * sem ele o placeholder assume e a LISTA continua sendo a prova.
 *
 * O que prova (REQ-04 · DEC-14 · lex 29/08 C1/C2/C3/C4/C7):
 *   - /admin/mapa abre com o PORTÃO FECHADO: sem âncora escolhida não há lista,
 *     não há filtros e NENHUM POST sai — a tela não é mais uma varredura;
 *   - escolher o paciente-âncora abre a tela em 5 km e centra nele; a lista
 *     mostra os prestadores dentro do raio e NÃO o que está fora; quem não tem
 *     coordenada aparece como "sin ubicación" e entra na contagem própria;
 *   - "Documentación: Registro incompleto" filtra pelo status INCOMPLETE_REGISTER;
 *   - o raio recorta pela distância REAL (o banco confirma com ST_DWithin), e o
 *     total da tela bate com o SQL;
 *   - a aba Pacientes lista o paciente pelo endereço, sem diagnóstico no DOM, e
 *     o paciente BR não aparece com país AR (C4); trocar para BR leva o mapa a
 *     São Paulo e o paciente BR (em coordenada REAL de SP) aparece — na lista
 *     e no seletor da âncora;
 *   - a coordenada do centro vai no CORPO do POST, nunca na URL (C2);
 *   - nenhuma request ao Google leva geocode/place/nome (C7);
 *   - a API, com token real: sem escopo → 400, filtro clínico → 400 (strict),
 *     sem país → 400, sem token → 401 (C1/C3/C4);
 *   - prestador com DUAS áreas: com filtro de província o pino é o da área que
 *     casa o filtro, não o da mais recente;
 *   - `toHaveScreenshot` da página com o canvas do mapa mascarado (visual).
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient, insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';

/**
 * Endereços do stack sob teste. Os defaults são os de sempre (CI e uso local
 * comum); as env vars existem para apontar a um stack ISOLADO por projeto
 * docker quando outra worktree ocupa `enlite-postgres`/9099/8080 — mesmo
 * padrão que `e2e/helpers/db-test-helper.ts` já adota. Sem elas, nada muda.
 */
const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.req04.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const STAFF_NAME = 'E2E Req04 Reclutadora';
const TS = Date.now().toString().slice(-6);

// Pontos reais de Buenos Aires. Paciente no Obelisco; A e B a < 5 km; C em Quilmes (~17,4 km, medido); D sem coordenada.
// (a 1ª rodada usou Palermo para B: 5,2 km — fora dos 5 km. O PostGIS é a régua, não o chute.)
const PATIENT_AT = { lat: -34.6083, lng: -58.3712 };
const WORKER_A = { lat: -34.6037, lng: -58.3816 }; // Obelisco, REGISTERED
const WORKER_B = { lat: -34.6094, lng: -58.3923 }; // Congreso, INCOMPLETE_REGISTER (~1.9 km do paciente; medido no PostGIS)
const WORKER_C = { lat: -34.7203, lng: -58.2543 }; // Quilmes, REGISTERED (~16 km)
// Prestador E com duas áreas: La Plata (a mais recente) e Córdoba (a que casa o filtro "Córdoba").
const AREA_LA_PLATA = { lat: -34.9214, lng: -57.9544 };
const AREA_CORDOBA = { lat: -31.4201, lng: -64.1888 };
// Paciente em Mar del Plata: ponto REAL a ~381 km do Obelisco — FORA do raio de 50 km do
// seletor da âncora. É o caso que motivou a busca por nome (07/09/2026): antes ele não estava
// na lista do seletor e digitar o nome respondia "Sin resultados".
const PATIENT_MDP_AT = { lat: -38.0055, lng: -57.5426 };
// Paciente BR num ponto REAL de São Paulo (MASP, Av. Paulista) — a ~1.500 km do Obelisco.
const PATIENT_BR_AT = { lat: -23.5614, lng: -46.6559 };
// Prestador BR a ~700 m do paciente de SP: é a ÂNCORA da aba Pacientes com país BR.
// Sem ele o portão da aba não abre em BR e o teste do C4 não teria como rodar.
const WORKER_BR_AT = { lat: -23.5558, lng: -46.6596 };
const API = process.env.E2E_API_URL || 'http://localhost:8080';

function runSQL(sql: string): string {
  return execSync(
    `docker exec ${process.env.E2E_PG_CONTAINER || 'enlite-postgres'} psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

/** Cria/loga a recrutadora no emulador, grava a claim de papel e devolve um token JÁ com a claim. */
async function loginAsRealStaff(page: Page): Promise<string> {
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  const auth = signUp.ok ? signUp : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(auth.ok).toBe(true);
  const { localId } = (await auth.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'recruiter' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', '${STAFF_NAME}', 'recruiter', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  // Token novo DEPOIS da claim (o do signUp nasceu sem papel).
  const fresh = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(fresh.ok).toBe(true);
  const { idToken } = (await fresh.json()) as { idToken: string };
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  return idToken;
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Mapa de prestadores e pacientes (REQ-04 · DEC-14) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let workerA = ''; let workerB = ''; let workerC = ''; let workerD = ''; let workerE = ''; let workerBr = '';
  let patientId = ''; let patientAddressId = ''; let patientBrId = ''; let patientBrAddressId = '';
  const nameA = `Req04A${TS}`; const nameB = `Req04B${TS}`; const nameC = `Req04C${TS}`; const nameD = `Req04D${TS}`; const nameE = `Req04E${TS}`;
  const patientName = `Req04Pac${TS}`;
  let patientMdpId = ''; const patientMdpName = `Req04Mdp${TS}`;
  const patientBrName = `Req04Bra${TS}`;
  const nameBr = `Req04Wbr${TS}`;

  test.beforeAll(() => {
    workerA = insertTestWorker({ firstName: nameA, lastName: 'Mapa', occupation: 'AT', status: 'REGISTERED', ...WORKER_A });
    workerB = insertTestWorker({ firstName: nameB, lastName: 'Mapa', occupation: 'CAREGIVER', status: 'INCOMPLETE_REGISTER', ...WORKER_B });
    workerC = insertTestWorker({ firstName: nameC, lastName: 'Mapa', occupation: 'AT', status: 'REGISTERED', ...WORKER_C });
    workerD = insertTestWorker({ firstName: nameD, lastName: 'Mapa', occupation: 'AT', status: 'INCOMPLETE_REGISTER', lat: null, lng: null });
    // E: duas áreas. A do helper vira La Plata (a MAIS RECENTE); a segunda é Córdoba, mais antiga.
    workerE = insertTestWorker({ firstName: nameE, lastName: 'Mapa', occupation: 'AT', status: 'REGISTERED', ...AREA_LA_PLATA });
    runSQL(`UPDATE worker_service_areas SET state = 'Buenos Aires', city = 'La Plata', updated_at = NOW() + INTERVAL '1 hour' WHERE worker_id = '${workerE}'`);
    runSQL(`INSERT INTO worker_service_areas (worker_id, country, latitude, longitude, state, city, radius_km, created_at, updated_at)
      VALUES ('${workerE}', 'AR', ${AREA_CORDOBA.lat}, ${AREA_CORDOBA.lng}, 'Córdoba', 'Córdoba', 20, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`);
    // O helper grava `occupation`; a lista e o mapa leem `profession` (a coluna que o filtro da casa usa).
    runSQL(`UPDATE workers SET profession = CASE id WHEN '${workerB}' THEN 'CAREGIVER' ELSE 'AT' END WHERE id IN ('${workerA}','${workerB}','${workerC}','${workerD}','${workerE}')`);
    const p = insertTestPatient({ firstName: patientName, lastName: 'Mapa', status: 'ACTIVE', diagnosis: 'F84.0 TEA', withAddress: true, addressLat: PATIENT_AT.lat, addressLng: PATIENT_AT.lng });
    patientId = p.patientId;
    patientAddressId = p.addressId as string;
    const br = insertTestPatient({ firstName: patientBrName, lastName: 'Mapa', status: 'ACTIVE', withAddress: true, addressLat: PATIENT_BR_AT.lat, addressLng: PATIENT_BR_AT.lng });
    patientBrId = br.patientId;
    patientBrAddressId = br.addressId as string;
    runSQL(`UPDATE patients SET country = 'BR' WHERE id = '${patientBrId}'`);
    const mdp = insertTestPatient({ firstName: patientMdpName, lastName: 'Mapa', status: 'ACTIVE', withAddress: true, addressLat: PATIENT_MDP_AT.lat, addressLng: PATIENT_MDP_AT.lng });
    patientMdpId = mdp.patientId;
    runSQL(`UPDATE patient_addresses SET city = 'Mar del Plata', state = 'Buenos Aires' WHERE id = '${mdp.addressId as string}'`);
    workerBr = insertTestWorker({ firstName: nameBr, lastName: 'Mapa', occupation: 'AT', status: 'REGISTERED', ...WORKER_BR_AT });
    runSQL(`UPDATE workers SET country = 'BR', profession = 'AT' WHERE id = '${workerBr}'`);
    runSQL(`UPDATE patient_addresses SET city = 'São Paulo', state = 'SP', address_formatted = 'Av. Paulista 1578, São Paulo, BR', address_raw = 'Av. Paulista 1578' WHERE id = '${patientBrAddressId}'`);
  });

  test.afterAll(() => {
    for (const id of [workerA, workerB, workerC, workerD, workerE, workerBr]) cleanupTestWorker(id);
    cleanupTestPatient(patientId);
    cleanupTestPatient(patientBrId);
    cleanupTestPatient(patientMdpId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('prestadores: portão fechado sem âncora, depois 5 km em volta do paciente, "registro incompleto" e a contagem que bate com o PostGIS', async ({ page }, testInfo) => {
    const googleRequests: string[] = [];
    const mapPosts: Array<{ url: string; body: string }> = [];
    page.on('request', (req) => {
      const url = req.url();
      if (/googleapis\.com|gstatic\.com|google\.com\/maps/.test(url)) googleRequests.push(url);
      if (url.endsWith('/api/admin/workers/map') || url.endsWith('/api/admin/patients/map')) mapPosts.push({ url, body: req.postData() ?? '' });
    });

    await loginAsRealStaff(page);
    await page.goto('/admin/mapa');

    // ── PORTÃO FECHADO: nada de lista, nada de filtro, e ZERO request ────────
    await expect(page.getByTestId('map-anchor-empty')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('map-list')).toHaveCount(0);
    await expect(page.getByTestId('map-counts')).toHaveCount(0);
    await expect(page.getByTestId('map-filters-block')).toHaveCount(0);
    await expect(page.getByTestId('points-map')).toHaveCount(0);
    // a prova mais dura do portão: a tela não chamou o backend nenhuma vez
    expect(mapPosts).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('00-mapa-portao-fechado.png'), fullPage: false });

    // ── Escolher a âncora abre a tela. O seletor só busca depois de tocado ────
    const picker = page.getByTestId('map-center-patient');
    await picker.getByRole('button').click();
    const pickerOption = picker.getByRole('option').filter({ hasText: patientName });
    await expect(pickerOption).toHaveCount(1, { timeout: 15_000 });
    // até aqui só o SELETOR foi ao servidor — a lista de prestadores, nunca
    expect(mapPosts.filter((m) => m.url.endsWith('/api/admin/workers/map'))).toHaveLength(0);
    await pickerOption.click();
    await expect(page.getByTestId('map-center-label')).toContainText(patientName, { timeout: 15_000 });

    const list = page.getByTestId('map-list');
    await expect(page.getByTestId('map-total')).toBeVisible({ timeout: 30_000 });
    // o raio NASCE em 5 km (Marcel na tela, 02/09): A e B ficam, C (~16 km) não
    await expect(page.getByTestId('map-radius')).toHaveValue('5');
    await expect(page.getByTestId('map-counts')).toContainText('en 5 km');
    await expect(list.locator(`[data-point-id="${workerC}"]`)).toHaveCount(0, { timeout: 15_000 });

    // Abrindo para 25 km, Quilmes entra — o raio é filtro de verdade
    await page.getByTestId('map-radius').selectOption('25');
    await expect(page.getByTestId('map-counts')).toContainText('en 25 km');
    await expect(list.locator(`[data-point-id="${workerC}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(list.locator(`[data-point-id="${workerA}"]`)).toContainText(nameA);
    await expect(list.locator(`[data-point-id="${workerA}"]`)).toContainText('AT · Documentación completa');
    await expect(list.locator(`[data-point-id="${workerB}"]`)).toContainText('Cuidador');
    await expect(list.locator(`[data-point-id="${workerB}"]`)).toContainText('Registro incompleto');
    const rowD = list.locator(`[data-point-id="${workerD}"]`);
    await expect(rowD).toHaveAttribute('data-has-coords', 'false');
    await expect(rowD).toContainText('sin ubicación');
    await expect(page.getByTestId('map-without-coords')).toBeVisible();

    // Mapa: ou carregou o Google (pinos = itens com coordenada) ou ficou indisponível (placeholder); nunca "loading" eterno
    const map = page.getByTestId('points-map');
    await expect(map).not.toHaveAttribute('data-map-status', 'loading', { timeout: 30_000 });
    const mapStatus = await map.getAttribute('data-map-status');
    if (mapStatus === 'ready') {
      const withCoords = await list.locator('[data-has-coords="true"]').count();
      await expect(map).toHaveAttribute('data-markers', String(withCoords));
    } else {
      await expect(page.getByTestId('points-map-placeholder')).toBeVisible();
    }
    testInfo.annotations.push({ type: 'evidência', description: `mapa Google: ${mapStatus}` });
    if (mapStatus === 'ready') await expect(map).toHaveAttribute('data-tiles', 'loaded', { timeout: 20_000 });

    await page.screenshot({ path: testInfo.outputPath('01-mapa-prestadores-25km.png'), fullPage: false });
    await expect(page).toHaveScreenshot('req04-mapa-prestadores.png', { mask: [map], maxDiffPixelRatio: 0.05 });

    // Filtro "Registro incompleto": B e D ficam; A e C somem
    await page.getByTestId('map-docs').selectOption('incomplete');
    await expect(list.locator(`[data-point-id="${workerA}"]`)).toHaveCount(0, { timeout: 15_000 });
    await expect(list.locator(`[data-point-id="${workerC}"]`)).toHaveCount(0);
    await expect(list.locator(`[data-point-id="${workerB}"]`)).toBeVisible();
    await expect(rowD).toBeVisible();
    await page.getByTestId('map-docs').selectOption('all');
    await expect(list.locator(`[data-point-id="${workerA}"]`)).toBeVisible({ timeout: 15_000 });

    // De volta aos 5 km em volta do paciente: A e B ficam (< 5 km), C some (~16 km),
    // D (sem coordenada) continua — quem não tem ponto não é recortado pelo raio.
    await page.getByTestId('map-radius').selectOption('5');
    await expect(page.getByTestId('map-counts')).toContainText('en 5 km');
    await expect(list.locator(`[data-point-id="${workerC}"]`)).toHaveCount(0, { timeout: 15_000 });
    await expect(list.locator(`[data-point-id="${workerA}"]`)).toBeVisible();
    await expect(list.locator(`[data-point-id="${workerB}"]`)).toBeVisible();
    await expect(rowD).toBeVisible();

    // O total da tela bate com o PostGIS (mesma regra: AR, ativos, dentro de 5 km OU sem coordenada)
    const expected = runSQL(`
      SELECT COUNT(*) FROM workers w
      LEFT JOIN LATERAL (SELECT s.location, s.latitude FROM worker_service_areas s WHERE s.worker_id = w.id AND s.deleted_at IS NULL ORDER BY (s.latitude IS NULL), s.updated_at DESC LIMIT 1) wsa ON true
      WHERE w.merged_into_id IS NULL AND w.country = 'AR' AND w.status IN ('REGISTERED','INCOMPLETE_REGISTER')
        AND (wsa.location IS NULL OR ST_DWithin(wsa.location, ST_SetSRID(ST_MakePoint(${PATIENT_AT.lng}, ${PATIENT_AT.lat}), 4326)::geography, 5000))`);
    await expect(page.getByTestId('map-total')).toHaveText(expected);
    testInfo.annotations.push({ type: 'evidência', description: `total 5 km em volta do paciente: tela=${await page.getByTestId('map-total').textContent()} sql=${expected}` });
    await page.waitForTimeout(1_500); // o pan até o paciente traz tiles novos
    await page.screenshot({ path: testInfo.outputPath('02-mapa-prestadores-paciente-5km.png'), fullPage: false });

    // Selecionar na lista destaca (o balão é do Google; aqui a lista)
    await list.locator(`[data-point-id="${workerA}"]`).click();
    await expect(list.locator(`[data-point-id="${workerA}"]`)).toHaveClass(/bg-blue-50/);

    // lex C2: a coordenada foi no CORPO, nunca na URL
    expect(mapPosts.length).toBeGreaterThan(0);
    for (const { url, body } of mapPosts) {
      expect(url).not.toMatch(/-?\d{2}\.\d{3,}/);
      expect(body).toMatch(/"center"/);
    }
    // lex C7: ao Google só SDK/tiles — nada de geocode/place, nem nome de gente
    expect(googleRequests.filter((u) => /\/maps\/api\/geocode|\/maps\/api\/place|AutocompletionService|GeocodeService/.test(u))).toEqual([]);
    for (const u of googleRequests) expect(u).not.toMatch(new RegExp(`${nameA}|${nameB}|${patientName}`));
    testInfo.annotations.push({ type: 'evidência', description: `requests ao Google: ${googleRequests.length} (nenhuma geocode/place)` });
  });

  test('pacientes: um pino por endereço, sem diagnóstico no DOM, e o paciente BR não entra com país AR (C4)', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await page.goto('/admin/mapa');
    await page.getByTestId('map-tab-patients').click();

    // A aba de pacientes tem portão PRÓPRIO, e a âncora dela é um PRESTADOR.
    await expect(page.getByTestId('map-anchor-empty')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('map-list')).toHaveCount(0);
    const ancorarEm = async (nome: string): Promise<void> => {
      const sel = page.getByTestId('map-center-worker');
      await sel.getByRole('button').click();
      const opt = sel.getByRole('option').filter({ hasText: nome });
      await expect(opt).toHaveCount(1, { timeout: 15_000 });
      await opt.click();
      await expect(page.getByTestId('map-center-label')).toContainText(nome, { timeout: 15_000 });
    };
    // workerA está no Obelisco, a < 5 km do paciente semeado
    await ancorarEm(nameA);
    await expect(page.getByTestId('map-total')).toBeVisible({ timeout: 30_000 });
    const list = page.getByTestId('map-list');
    // Um ponto por ENDEREÇO: a linha se identifica pelo id do endereço (o do paciente vai em data-patient-id)
    const row = list.locator(`[data-point-id="${patientAddressId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute('data-patient-id', patientId);
    await expect(row).toContainText(patientName);
    await expect(row).toContainText('Activo');
    await expect(row).toHaveAttribute('data-has-coords', 'true');
    await expect(list.locator(`[data-patient-id="${patientBrId}"]`)).toHaveCount(0);
    // O diagnóstico semeado é 'F84.0 TEA'. A régua tem de ser o CÓDIGO e a sigla
    // como PALAVRA: `/TEA/i` solto casa dentro de sobrenome ("Zortea"), e o teste
    // reprovava por um nome de outra spec no banco compartilhado — falso positivo
    // que esconderia um vazamento real no meio do ruído.
    const corpo = (await page.locator('body').textContent()) ?? '';
    expect(corpo, 'o código CID do diagnóstico não aparece na tela').not.toContain('F84');
    expect(corpo, 'nem a sigla do diagnóstico como palavra').not.toMatch(/\bTEA\b/);
    expect(corpo, 'nem a palavra "diagnóstico"').not.toMatch(/diagn[oó]stic/i);
    await expect(page.getByRole('link', { name: `${patientName} Mapa` })).toHaveAttribute('href', `/admin/patients/${patientId}`);

    // Trocar de país SOLTA a âncora (ela era do país anterior) e o portão fecha:
    // a régua do C4 é justamente que nada de AR sobrevive à troca para BR.
    const brRow = list.locator(`[data-point-id="${patientBrAddressId}"]`);
    await page.getByTestId('map-country').selectOption('BR');
    await expect(page.getByTestId('map-anchor-empty')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('map-list')).toHaveCount(0);
    // ancorando no prestador BR, o paciente de São Paulo aparece e o AR some
    await ancorarEm(nameBr);
    await expect(brRow).toBeVisible({ timeout: 15_000 });
    await expect(brRow).toContainText('São Paulo');
    await expect(row).toHaveCount(0);

    // Na aba de prestadores com país BR, o seletor da âncora encontra o paciente de SP e NÃO o de CABA
    await page.getByTestId('map-tab-workers').click();
    const picker = page.getByTestId('map-center-patient');
    await picker.getByRole('button').click();
    await expect(picker.getByRole('option').filter({ hasText: patientBrName })).toHaveCount(1, { timeout: 15_000 });
    await expect(picker.getByRole('option').filter({ hasText: patientName })).toHaveCount(0);
    await picker.getByRole('option').filter({ hasText: patientBrName }).click();
    await expect(page.getByTestId('map-counts')).toBeVisible();

    // De volta a AR: portão fechado de novo nas DUAS abas, e a âncora AR é re-escolhida
    await page.getByTestId('map-country').selectOption('AR');
    await expect(page.getByTestId('map-anchor-empty')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('map-tab-patients').click();
    await ancorarEm(nameA);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Filtro de status: SUSPENDED esconde o ativo
    await page.getByTestId('map-patient-status').selectOption('SUSPENDED');
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await page.getByTestId('map-patient-status').selectOption('');
    await expect(row).toBeVisible({ timeout: 15_000 });

    const map = page.getByTestId('points-map');
    await expect(map).not.toHaveAttribute('data-map-status', 'loading', { timeout: 30_000 });
    if ((await map.getAttribute('data-map-status')) === 'ready') await expect(map).toHaveAttribute('data-tiles', 'loaded', { timeout: 20_000 });
    await page.screenshot({ path: testInfo.outputPath('03-mapa-pacientes.png'), fullPage: false });
    await expect(page).toHaveScreenshot('req04-mapa-pacientes.png', { mask: [map], maxDiffPixelRatio: 0.05 });
  });

  test('a API recusa sem escopo, com filtro clínico e sem país (lex C1/C3/C4) — direto no backend real', async ({ page, request }) => {
    // Sem token → 401 (rota montada e protegida)
    const noAuth = await request.post(`${API}/api/admin/patients/map`, { data: { country: 'AR', city: 'x' } });
    expect(noAuth.status()).toBe(401);

    const token = await loginAsRealStaff(page);
    const headers = { Authorization: `Bearer ${token}` };
    for (const path of ['/api/admin/patients/map', '/api/admin/workers/map']) {
      // C3: sem escopo (só país) → 400
      const noScope = await request.post(`${API}${path}`, { headers, data: { country: 'AR' } });
      expect(noScope.status(), `${path} sem escopo`).toBe(400);
      expect((await noScope.json()).error).toBe('Invalid map filters');
      // C1: filtro clínico no corpo → 400 pelo `.strict()`
      for (const clinical of ['clinical_specialty', 'dependency_level', 'diagnosis']) {
        const strict = await request.post(`${API}${path}`, { headers, data: { country: 'AR', city: 'x', [clinical]: 'ASD' } });
        expect(strict.status(), `${path} com ${clinical}`).toBe(400);
      }
      // C4: sem país → 400
      const noCountry = await request.post(`${API}${path}`, { headers, data: { city: 'x' } });
      expect(noCountry.status(), `${path} sem país`).toBe(400);
      // e o mesmo corpo, com país e escopo, é 200 — a recusa é pelo motivo certo
      const ok = await request.post(`${API}${path}`, { headers, data: { country: 'AR', city: 'x' } });
      expect(ok.status(), `${path} válido`).toBe(200);
    }
  });

  test('prestador com duas áreas: com filtro de província o pino é o da área que casa o filtro, não o da mais recente', async ({ page, request }) => {
    const token = await loginAsRealStaff(page);
    const headers = { Authorization: `Bearer ${token}` };
    type Point = { id: string; lat: number | null; lng: number | null; state: string | null; city: string | null };
    const find = async (body: Record<string, unknown>): Promise<Point | undefined> => {
      const res = await request.post(`${API}/api/admin/workers/map`, { headers, data: body });
      expect(res.status()).toBe(200);
      return ((await res.json()).data as Point[]).find((p) => p.id === workerE);
    };

    // Filtro "Córdoba": E entra (tem área lá) e o pino é o de Córdoba — mesmo sendo a área mais ANTIGA
    const cordoba = await find({ country: 'AR', state: 'Córdoba' });
    expect(cordoba).toBeDefined();
    expect(cordoba!.state).toBe('Córdoba');
    expect(cordoba!.lat).toBeCloseTo(AREA_CORDOBA.lat, 3);
    expect(cordoba!.lng).toBeCloseTo(AREA_CORDOBA.lng, 3);

    // Sem filtro de província (raio largo em volta de La Plata): a mais recente, La Plata
    const recent = await find({ country: 'AR', center: AREA_LA_PLATA, radius_km: 10 });
    expect(recent).toBeDefined();
    expect(recent!.lat).toBeCloseTo(AREA_LA_PLATA.lat, 3);

    // O banco confirma: a área de Córdoba é a mais antiga das duas
    const older = runSQL(`SELECT city FROM worker_service_areas WHERE worker_id = '${workerE}' ORDER BY updated_at ASC LIMIT 1`);
    expect(older).toBe('Córdoba');
  });

  test('busca por nome acha quem mora FORA do raio do seletor — o caso Mar del Plata', async ({ page }, testInfo) => {
    // O corpo de cada POST ao mapa de pacientes: é nele que se vê o escopo trocar.
    const mapPosts: Array<Record<string, unknown>> = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/admin/patients/map')) {
        mapPosts.push(JSON.parse(r.postData() ?? '{}'));
      }
    });

    await loginAsRealStaff(page);
    await page.goto('/admin/mapa');

    const picker = page.getByTestId('map-center-patient');
    await picker.getByRole('button').click();

    // ── O defeito, reproduzido: sem digitar, o seletor só traz os 50 km ──────
    await expect.poll(() => mapPosts.length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(mapPosts[0]).toMatchObject({ country: 'AR', radius_km: 50 });
    // o paciente do Obelisco está na lista; o de Mar del Plata (381 km) NÃO
    await expect(picker.getByRole('option').filter({ hasText: patientName })).toHaveCount(1, { timeout: 15_000 });
    await expect(picker.getByRole('option').filter({ hasText: patientMdpName })).toHaveCount(0);

    // ── O conserto: digitar o nome troca o ESCOPO da busca ──────────────────
    await picker.getByRole('textbox').fill(patientMdpName);
    await expect.poll(() => mapPosts.some((b) => b.search === patientMdpName), { timeout: 15_000 }).toBe(true);

    const buscaPost = mapPosts.find((b) => b.search === patientMdpName)!;
    // o escopo é o NOME: sem centro, sem raio — senão o nome só valeria dentro dos 50 km
    expect(buscaPost).not.toHaveProperty('center');
    expect(buscaPost).not.toHaveProperty('radius_km');
    expect(buscaPost).toMatchObject({ country: 'AR' });

    // e agora ele está na lista
    const achado = picker.getByRole('option').filter({ hasText: patientMdpName });
    await expect(achado).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('searchable-select-empty')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('10-busca-por-nome-achou.png'), fullPage: false });

    // escolher leva o mapa até lá: o centro passa a ser Mar del Plata
    await achado.click();
    await expect(page.getByTestId('map-center-label')).toContainText(patientMdpName, { timeout: 15_000 });
    await expect(page.getByTestId('map-total')).toBeVisible({ timeout: 30_000 });

    const map = page.getByTestId('points-map');
    await expect(page).toHaveScreenshot('req04-mapa-busca-por-nome.png', { mask: [map], maxDiffPixelRatio: 0.05 });

    // 🔒 o nome NUNCA vai na URL — é corpo de POST (lex C2)
    expect(page.url()).not.toContain(patientMdpName);
  });
});
