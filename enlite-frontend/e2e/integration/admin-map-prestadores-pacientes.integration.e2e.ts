/**
 * admin-map-prestadores-pacientes.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK DE API: navegador real → worker-functions real (Docker,
 * imagem desta branch) → Postgres+PostGIS real → Firebase Auth EMULATOR real.
 * Nenhuma interceptação de request no navegador. O Google Maps JS é o real (chave do .env) quando há rede;
 * sem ele o placeholder assume e a LISTA continua sendo a prova.
 *
 * O que prova (REQ-04 · DEC-14 · lex 29/08 C1/C2/C3/C4/C7):
 *   - /admin/mapa nasce em CABA com 25 km; a lista mostra os prestadores semeados
 *     dentro do raio e NÃO o que está fora; quem não tem coordenada aparece como
 *     "sin ubicación" e entra na contagem própria;
 *   - "Documentación: Registro incompleto" filtra pelo status INCOMPLETE_REGISTER;
 *   - "Centrar en paciente" + 5 km recorta pela distância REAL (o banco confirma
 *     com ST_DWithin), e o total da tela bate com o SQL;
 *   - a aba Pacientes lista o paciente pelo endereço, sem diagnóstico no DOM, e
 *     o paciente BR não aparece com país AR (C4); trocar para BR leva o mapa a
 *     São Paulo e o paciente BR (em coordenada REAL de SP) aparece — na lista
 *     e no seletor "centrar en paciente";
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

const EMULATOR = 'http://127.0.0.1:9099';
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
// Paciente BR num ponto REAL de São Paulo (MASP, Av. Paulista) — a ~1.500 km do Obelisco.
const PATIENT_BR_AT = { lat: -23.5614, lng: -46.6559 };
const API = 'http://localhost:8080';

function runSQL(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
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

  let workerA = ''; let workerB = ''; let workerC = ''; let workerD = ''; let workerE = '';
  let patientId = ''; let patientAddressId = ''; let patientBrId = ''; let patientBrAddressId = '';
  const nameA = `Req04A${TS}`; const nameB = `Req04B${TS}`; const nameC = `Req04C${TS}`; const nameD = `Req04D${TS}`; const nameE = `Req04E${TS}`;
  const patientName = `Req04Pac${TS}`;
  const patientBrName = `Req04Bra${TS}`;

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
    runSQL(`UPDATE patient_addresses SET city = 'São Paulo', state = 'SP', address_formatted = 'Av. Paulista 1578, São Paulo, BR', address_raw = 'Av. Paulista 1578' WHERE id = '${patientBrAddressId}'`);
  });

  test.afterAll(() => {
    for (const id of [workerA, workerB, workerC, workerD, workerE]) cleanupTestWorker(id);
    cleanupTestPatient(patientId);
    cleanupTestPatient(patientBrId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('prestadores: raio padrão, "registro incompleto", centrar no paciente + 5 km, contagem bate com o PostGIS', async ({ page }, testInfo) => {
    const googleRequests: string[] = [];
    const mapPosts: Array<{ url: string; body: string }> = [];
    page.on('request', (req) => {
      const url = req.url();
      if (/googleapis\.com|gstatic\.com|google\.com\/maps/.test(url)) googleRequests.push(url);
      if (url.endsWith('/api/admin/workers/map') || url.endsWith('/api/admin/patients/map')) mapPosts.push({ url, body: req.postData() ?? '' });
    });

    await loginAsRealStaff(page);
    await page.goto('/admin/mapa');

    const list = page.getByTestId('map-list');
    await expect(page.getByTestId('map-total')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('map-counts')).toContainText('en 25 km');

    // A (Obelisco), B (Palermo) e C (Quilmes ~16 km) dentro de 25 km; D sem coordenada aparece como "sin ubicación"
    await expect(list.locator(`[data-point-id="${workerA}"]`)).toContainText(nameA);
    await expect(list.locator(`[data-point-id="${workerA}"]`)).toContainText('AT · Documentación completa');
    await expect(list.locator(`[data-point-id="${workerB}"]`)).toContainText('Cuidador');
    await expect(list.locator(`[data-point-id="${workerB}"]`)).toContainText('Registro incompleto');
    await expect(list.locator(`[data-point-id="${workerC}"]`)).toBeVisible();
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

    // Centrar no paciente + 5 km: A e B ficam (< 5 km), C some (~16 km), D (sem coordenada) continua.
    // O seletor só busca depois de tocado: até aqui, nenhum POST a /patients/map.
    expect(mapPosts.filter((m) => m.url.endsWith('/api/admin/patients/map'))).toHaveLength(0);
    // combobox com busca, não <select>: abrir dispara a busca preguiçosa e lista as opções
    const picker = page.getByTestId('map-center-patient');
    await picker.getByRole('button').click();
    const pickerOption = picker.getByRole('option').filter({ hasText: patientName });
    await expect(pickerOption).toHaveCount(1, { timeout: 15_000 });
    await pickerOption.click();
    await expect(page.getByTestId('map-center-label')).toContainText(patientName, { timeout: 15_000 });
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
    await expect(page.getByTestId('map-total')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('map-tab-patients').click();
    const list = page.getByTestId('map-list');
    // Um ponto por ENDEREÇO: a linha se identifica pelo id do endereço (o do paciente vai em data-patient-id)
    const row = list.locator(`[data-point-id="${patientAddressId}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute('data-patient-id', patientId);
    await expect(row).toContainText(patientName);
    await expect(row).toContainText('Activo');
    await expect(row).toHaveAttribute('data-has-coords', 'true');
    await expect(list.locator(`[data-patient-id="${patientBrId}"]`)).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toMatch(/F84|TEA|diagn/i);
    await expect(page.getByRole('link', { name: `${patientName} Mapa` })).toHaveAttribute('href', `/admin/patients/${patientId}`);

    // Trocar para BR: o centro vai para São Paulo, o paciente BR (a ~1.500 km do Obelisco) aparece e o AR some
    const brRow = list.locator(`[data-point-id="${patientBrAddressId}"]`);
    await page.getByTestId('map-country').selectOption('BR');
    await expect(brRow).toBeVisible({ timeout: 15_000 });
    await expect(brRow).toContainText('São Paulo');
    await expect(row).toHaveCount(0);
    await page.getByTestId('map-country').selectOption('AR');
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Na aba de prestadores com país BR, o seletor "centrar en paciente" encontra o paciente de São Paulo
    await page.getByTestId('map-tab-workers').click();
    await page.getByTestId('map-country').selectOption('BR');
    const picker = page.getByTestId('map-center-patient');
    await picker.getByRole('button').click();
    await expect(picker.getByRole('option').filter({ hasText: patientBrName })).toHaveCount(1, { timeout: 15_000 });
    await expect(picker.getByRole('option').filter({ hasText: patientName })).toHaveCount(0);
    await picker.getByRole('option').filter({ hasText: patientBrName }).click();
    await expect(page.getByTestId('map-counts')).toBeVisible();
    await page.getByTestId('map-country').selectOption('AR');
    await page.getByTestId('map-tab-patients').click();
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
});
