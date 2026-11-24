/**
 * home-vagas-api-publica-096-mapa-raio.integration.e2e.ts @integration
 *
 * Spec 096 — home do prestador: mapa com o raio, contagem por região (barrio) e a lista abaixo escopada pelo raio.
 * (O nome do arquivo casa `home-vagas-api-publica` do `grep:` do pr-gate E o `--grep "home.*mapa.*raio"` do CA-9: um nome fora
 * do grep reduzido do CI não rodaria lá.)
 *
 * SEM MOCK de rede na parte que importa: frontend real (Vite) + backend real (USE_MOCK_AUTH) + Postgres real.
 * `/api/workers/me/jobs` NUNCA é interceptada com resposta fabricada: o `worker-auth-helper` tem um stub genérico de
 * `GET /api/workers/me*` que a engoliria, então este spec registra uma rota SUA, depois do login, que só repassa a chamada
 * à API real trocando o token pelo `mock_*` (a mesma passagem que o helper faz para o resto de `/api/**`).
 * `/api/public/v1/jobs` também vem do Postgres. O único mock é a IDENTIDADE (`loginAsWorker`).
 *
 * Interação humana: foco + teclado (setas) no controle de raio e click nos botões; leitura NA TELA (contagem do controle,
 * chips, cards). Massa 100% sintética (prefixo E2E-096, barrios "... E2E096"). Mapa: sem chave do Google
 * (`VITE_GOOGLE_MAPS_API_KEY`) o `PointsMap` fica em `data-map-status="unavailable"` e o spec prova o resto.
 *
 * Run:
 *   E2E_PG_CONTAINER=<postgres do stack> PW_BASE_URL=http://localhost:<vite> \
 *     pnpm test:e2e:integration --grep "home.*mapa.*raio"
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { loginAsWorker, buildMockToken } from '../helpers/worker-auth-helper';

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';
const PREFIX = 'E2E-096-';
const PRINT_DIR = process.env.PRINT_DIR_096 || '';
// Base: Rosario (longe do ponto -34.6037,-58.3816 das outras massas de e2e, que entrariam na contagem do raio). Com
// E2E096_BASE=ba (rodada isolada, para as fotos do mapa) a massa vai para Buenos Aires.
const BA = process.env.E2E096_BASE === 'ba';
const LAT0 = BA ? -34.6037 : -32.9468;
const LNG0 = BA ? -58.3816 : -60.6393;

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  return execSync(`docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -c '${escaped}'`, { stdio: 'pipe' }).toString();
}
const uuidOf = (out: string): string => {
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) throw new Error('seed: id nao encontrado');
  return m[0];
};

// Vagas: dLat 0,018 ≈ 2 km | 0,063 ≈ 7 km | 0,11 ≈ 12 km | 0,27 ≈ 30 km (1 grau de latitude ≈ 111 km). `ok` = cabe no perfil.
interface Seed { n: number; city: string; barrio: string | null; dLat: number; day: number; sex: string; ok: boolean }
const SEEDS: Seed[] = [
  { n: 1, city: 'Palermo E2E096', barrio: 'Palermo E2E096', dLat: 0.018, day: 1, sex: 'F', ok: true },
  { n: 2, city: 'Palermo E2E096', barrio: 'palermo e2e096', dLat: 0.019, day: 3, sex: 'BOTH', ok: true },
  { n: 3, city: 'Recoleta E2E096', barrio: 'Recoleta E2E096', dLat: 0.063, day: 1, sex: 'F', ok: true },
  { n: 4, city: 'Quilmes E2E096', barrio: null, dLat: 0.11, day: 3, sex: 'F', ok: true },
  { n: 5, city: 'Tigre E2E096', barrio: 'Tigre E2E096', dLat: 0.27, day: 1, sex: 'F', ok: true },
  { n: 6, city: 'Dia Descoberto E2E096', barrio: 'Dia Descoberto E2E096', dLat: 0.02, day: 5, sex: 'F', ok: false },
  { n: 7, city: 'Exige Varon E2E096', barrio: 'Exige Varon E2E096', dLat: 0.021, day: 1, sex: 'M', ok: false },
];
const caseOf = (n: number): number => 960000 + n;
const AUTH_PREFIX = 'e2e-worker-096-';

function cleanup(): void {
  runSQL(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${PREFIX}%');`);
  runSQL(`DELETE FROM patient_addresses WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${PREFIX}%');`);
  runSQL(`DELETE FROM patients WHERE clickup_task_id LIKE '${PREFIX}%';`);
  runSQL(`DELETE FROM workers WHERE auth_uid LIKE '${AUTH_PREFIX}%';`);
}

function seedVacancies(): void {
  for (const s of SEEDS) {
    const task = `${PREFIX}${s.n}`;
    runSQL(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, case_number, created_at, updated_at)
            VALUES ('${task}', 'Radio${s.n}', 'Paciente QA', 'ACTIVE', 'TEA', 'MODERATE', 'AR', ${caseOf(s.n)}, NOW(), NOW());`);
    const patientId = uuidOf(runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${task}'`));
    const nb = s.barrio ? `'${s.barrio}'` : 'NULL';
    runSQL(`INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, state, city, neighborhood, lat, lng, display_order, source, created_at, updated_at)
            VALUES ('${patientId}', 'Calle Sintetica ${s.n}', 'Calle Sintetica ${s.n}', 'CABA', '${s.city}', ${nb}, ${LAT0 + s.dLat}, ${LNG0}, 1, 'manual', NOW(), NOW());`);
    const addressId = uuidOf(runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`));
    const schedule = JSON.stringify([{ dayOfWeek: s.day, startTime: '09:00', endTime: '13:00' }]);
    runSQL(`INSERT INTO job_postings (vacancy_number, case_number, title, description, patient_id, patient_address_id, schedule,
              required_professions, required_sex, providers_needed, status, is_draft, is_test, country, talentum_whatsapp_url, social_short_links, created_at, updated_at)
            VALUES (nextval('job_postings_vacancy_number_seq'), ${caseOf(s.n)}, 'CASO SINTETICO ${caseOf(s.n)}', '', '${patientId}', '${addressId}', '${schedule}'::jsonb,
              ARRAY['AT']::varchar[], '${s.sex}', 1, 'SEARCHING', false, false, 'AR', 'https://wa.me/5491100000096',
              '{"site": "https://jobs.enlite.health/es/vagas/${caseOf(s.n)}/"}'::jsonb, NOW(), NOW());`);
  }
}

interface WorkerSeed { zona?: boolean; ocupacao?: boolean; sexo?: boolean; disponibilidade?: boolean; dLat?: number }

/** Prestador sintético. Completo por padrão: zona viva em (LAT0 + dLat), disponibilidade nos dias 1 e 3, ocupação AT, sexo F
 *  (cifrado como o stack de teste cifra). Cada flag `false` tira UM item do cadastro (decisão 19/11). */
function seedWorker(authUid: string, o: WorkerSeed = {}): void {
  const { zona = true, ocupacao = true, sexo = true, disponibilidade = true, dLat = 0 } = o;
  runSQL(`INSERT INTO workers (auth_uid, email, country, timezone, status, occupation, sex_encrypted)
          VALUES ('${authUid}', '${authUid}@test.local', 'AR', 'America/Argentina/Buenos_Aires', 'INCOMPLETE_REGISTER',
                  ${ocupacao ? "'AT'" : 'NULL'}, ${sexo ? "'RkVNQUxF'" : 'NULL'});`);
  const id = uuidOf(runSQL(`SELECT id FROM workers WHERE auth_uid = '${authUid}'`));
  if (zona) {
    runSQL(`INSERT INTO worker_service_areas (worker_id, latitude, longitude, radius_km, city, state, country)
            VALUES ('${id}', ${LAT0 + dLat}, ${LNG0}, 20, 'Buenos Aires', 'CABA', 'AR');`);
  }
  if (disponibilidade) {
    for (const day of [1, 3]) {
      runSQL(`INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
              VALUES ('${id}', ${day}, '08:00', '18:00', 'America/Argentina/Buenos_Aires');`);
    }
  }
}

async function goHome(page: Page, authUid: string): Promise<void> {
  await page.addInitScript(() => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
  });
  await loginAsWorker(page, authUid, `${authUid}@test.local`);
  // Registrada DEPOIS do login (a mais nova vence): repassa à API REAL, só trocando o token pelo `mock_*`. Sem resposta fabricada.
  await page.route('**/api/workers/me/jobs**', async (route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${buildMockToken(authUid, `${authUid}@test.local`)}` };
    await route.continue({ headers });
  });
  await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20_000 });
}

const countOnScreen = async (page: Page): Promise<number> => {
  const txt = (await page.getByTestId('radius-count').textContent()) ?? '';
  return Number(txt.match(/(\d+)/)![1]);
};
const chipsOnScreen = async (page: Page): Promise<string[]> =>
  (await page.getByTestId('radius-region').allTextContents()).map((s) => s.replace(/\s+/g, ' ').trim());

async function pressRadius(page: Page, key: 'ArrowRight' | 'ArrowLeft'): Promise<void> {
  await page.getByTestId('radius-range').focus();
  await page.keyboard.press(key);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!PRINT_DIR) return;
  mkdirSync(PRINT_DIR, { recursive: true });
  await page.screenshot({ path: join(PRINT_DIR, name), fullPage: true });
}

test.describe('@integration Home do prestador — mapa por raio (096)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);
  const stamp = Date.now();
  const uidMain = `${AUTH_PREFIX}main-${stamp}`;
  const uidLonge = `${AUTH_PREFIX}longe-${stamp}`;
  const uidSemEndereco = `${AUTH_PREFIX}sem-end-${stamp}`;
  const uidSemProfissao = `${AUTH_PREFIX}sem-prof-${stamp}`;
  const uidSemDisp = `${AUTH_PREFIX}sem-disp-${stamp}`;
  const uidDois = `${AUTH_PREFIX}dois-${stamp}`;
  const uidSemSexo = `${AUTH_PREFIX}sem-sexo-${stamp}`;

  test.beforeAll(() => {
    cleanup();
    seedVacancies();
    seedWorker(uidMain);
    seedWorker(uidLonge, { dLat: -0.09 });
    seedWorker(uidSemEndereco, { zona: false });
    seedWorker(uidSemProfissao, { ocupacao: false });
    seedWorker(uidSemDisp, { disponibilidade: false });
    seedWorker(uidDois, { ocupacao: false, disponibilidade: false });
    seedWorker(uidSemSexo, { sexo: false });
  });
  test.afterAll(() => { cleanup(); });

  test('home mapa raio — feliz: círculo, "N vacantes", chips por barrio e a lista escopada pelo raio (dado real do Postgres)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goHome(page, uidMain);
    const section = page.getByTestId('jobs-radius-section');
    await expect(section).toBeVisible({ timeout: 20_000 });

    // Padrão 10 km: vagas 1, 2 (≈2 km) e 3 (≈7 km). A 4 está a ≈12 km; 6 e 7 não cabem no perfil.
    await expect.poll(() => countOnScreen(page), { timeout: 15_000 }).toBe(3);
    await expect(page.getByTestId('radius-up-to')).toHaveText('Hasta 10 km');
    // 'Palermo' e 'palermo' (grafias do feed) agrupam num chip só; o rótulo é a grafia mais frequente (empate: a ordem alfabética).
    expect((await chipsOnScreen(page)).map((c) => c.toLowerCase())).toEqual(['palermo e2e096 · 2', 'recoleta e2e096 · 1']);
    await expect(page.getByTestId('job-card')).toHaveCount(3, { timeout: 15_000 });
    const distancias = await page.getByTestId('job-distance').allTextContents();
    expect(distancias).toHaveLength(3);
    for (const d of distancias) expect(d).toMatch(/^a \d+,\d km$/);
    const km = distancias.map((d) => Number(d.match(/(\d+),(\d)/)!.slice(1).join('.')));
    expect([...km].sort((a, b) => a - b)).toEqual(km); // ordenada por distância
    await expect(page.getByTestId('radius-availability-hint')).toHaveCount(0);

    // O mapa lido pelo DOM, nunca por tile (CA-10). Sem chave do Google: placeholder.
    const status = await page.getByTestId('points-map').getAttribute('data-map-status');
    expect(['unavailable', 'ready']).toContain(status);
    if (process.env.MAP_REAL === '1') expect(status, 'MAP_REAL=1 exige o mapa carregado de verdade').toBe('ready');
    await expect(page.getByTestId('points-map')).toHaveAttribute('data-rings', '10');
    console.log(`MAPA data-map-status=${status} data-rings=10`);

    await shot(page, 'home-mapa-raio-1440x900-10km.png');

    // Teclado: 10 → 15 km. A vaga 4 (Quilmes, sem barrio → cidade) entra; chips continuam somando o total.
    await pressRadius(page, 'ArrowRight');
    await expect(page.getByTestId('radius-up-to')).toHaveText('Hasta 15 km');
    await expect.poll(() => countOnScreen(page)).toBe(4);
    const chips = await chipsOnScreen(page);
    expect(chips.map((c) => c.toLowerCase())).toContain('quilmes e2e096 · 1');
    expect(chips.reduce((s, c) => s + Number(c.split('·')[1]), 0)).toBe(4);
    await expect(page.getByTestId('job-card')).toHaveCount(4);

    // Teclado: de volta a 5 km → só as 2 de Palermo.
    await pressRadius(page, 'ArrowLeft');
    await pressRadius(page, 'ArrowLeft');
    await expect(page.getByTestId('radius-up-to')).toHaveText('Hasta 5 km');
    await expect.poll(() => countOnScreen(page)).toBe(2);
    await expect(page.getByTestId('job-card')).toHaveCount(2);
    console.log('CONTAGEM LIDA NA TELA  10km=3 (Palermo 2, Recoleta 1) | 15km=4 (+Quilmes 1) | 5km=2');
  });

  /** Cadastro incompleto: UM bloco genérico (sem listar o que falta), nem mapa nem lista (nem a pública), nem chamada à rota de vagas. */
  async function expectAviso(page: Page, uid: string, print: string): Promise<void> {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    });
    await loginAsWorker(page, uid, `${uid}@test.local`);
    let jobsRouteCalls = 0;
    await page.route('**/api/workers/me/jobs**', async (route) => {
      jobsRouteCalls += 1;
      await route.continue();
    });
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.getByTestId('complete-profile-notice')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Completá tu registro para ver las vacantes')).toBeVisible();
    await expect(page.getByTestId('profile-notice-item')).toHaveCount(0);
    await expect(page.getByTestId('complete-registration-banner')).toHaveCount(0);
    expect(jobsRouteCalls).toBe(0);
    await expect(page.getByTestId('jobs-radius-section')).toHaveCount(0);
    await expect(page.getByTestId('points-map')).toHaveCount(0);
    await expect(page.locator('#jobs-section')).toHaveCount(0);
    await expect(page.getByTestId('job-card')).toHaveCount(0);
    await shot(page, print);
  }

  test('home mapa raio — A1: sem endereço → aviso "Tu dirección" com botão para a aba certa; nem mapa nem lista', async ({ page }) => {
    await expectAviso(page, uidSemEndereco, 'aviso-sem-endereco-1440x900.png');
    await page.getByRole('button', { name: 'Completar registro' }).click();
    await expect(page).toHaveURL(/\/worker\/profile/);
  });

  test('home mapa raio — A2: sem profissão → aviso "Tu profesión"; o botão leva ao campo', async ({ page }) => {
    await expectAviso(page, uidSemProfissao, 'aviso-sem-profissao-1440x900.png');
  });

  test('home mapa raio — A3: sem disponibilidade → aviso "Tu disponibilidad"; o botão leva à aba', async ({ page }) => {
    await expectAviso(page, uidSemDisp, 'aviso-sem-disponibilidade-1440x900.png');
  });

  test('home mapa raio — A4: sem sexo → aviso "Tu sexo"', async ({ page }) => {
    await expectAviso(page, uidSemSexo, 'aviso-sem-sexo-1440x900.png');
  });

  test('home mapa raio — A5: dois faltando (profissão e disponibilidade) → os dois itens, e a versão celular', async ({ page }) => {
    await expectAviso(page, uidDois, 'aviso-dois-faltando-1440x900.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('complete-profile-notice')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'aviso-dois-faltando-390x844.png');
  });

  test('home mapa raio — A6: raio sem vaga → "Ampliar" leva à próxima parada e a lista cresce', async ({ page }) => {
    await goHome(page, uidLonge);
    await expect(page.getByTestId('radius-empty')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('radius-empty')).toContainText('Sin vacantes en 10 km');
    await expect(page.getByTestId('job-card')).toHaveCount(0);
    await page.getByRole('button', { name: 'Ampliar a 15 km' }).click();
    await expect(page.getByTestId('radius-up-to')).toHaveText('Hasta 15 km');
    await expect.poll(() => countOnScreen(page), { timeout: 10_000 }).toBe(2);
    await expect(page.getByTestId('job-card')).toHaveCount(2);
    console.log('CONTAGEM LIDA NA TELA  prestador longe: 10km=0 -> Ampliar -> 15km=2');
  });

  /** A7 — a rota da home falha (500): a home FALHA FECHADA. O `page.route` com 500 SÓ nesta rota é o cenário de falha (não é mock de
   *  dado: nenhuma vaga é fabricada); depois do "Reintentar" (com `falhar=false`) a chamada segue para a API real. */
  test('home mapa raio — A7: rota da home com 500 → cartão de erro, nem mapa nem vaga nem lista pública; "Reintentar" recupera', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    });
    await loginAsWorker(page, uidMain, `${uidMain}@test.local`);
    // Falha ENQUANTO `falhar` for true (e não "na 1ª chamada"): o React.StrictMode do Vite dev roda o efeito duas vezes e a 1ª
    // chamada é cancelada, então contar chamadas deixaria a 2ª passar para a API real e o erro nunca apareceria.
    let falhar = true;
    await page.route('**/api/workers/me/jobs**', async (route) => {
      if (falhar) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'falha-simulada-e2e' }) });
        return;
      }
      const headers = { ...route.request().headers(), authorization: `Bearer ${buildMockToken(uidMain, `${uidMain}@test.local`)}` };
      await route.continue({ headers });
    });
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.getByTestId('home-load-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.getByTestId('jobs-radius-section')).toHaveCount(0);
    await expect(page.getByTestId('points-map')).toHaveCount(0);
    await expect(page.locator('#jobs-section')).toHaveCount(0);
    await expect(page.getByTestId('job-card')).toHaveCount(0);
    await expect(page.getByTestId('complete-profile-notice')).toHaveCount(0);
    await shot(page, 'erro-home-1440x900.png');

    falhar = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByTestId('jobs-radius-section')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('home-load-error')).toHaveCount(0);
  });

  test('home mapa raio — responsivo medido: 390 empilha, 1280 lado a lado, sem scroll horizontal', async ({ page }) => {
    await goHome(page, uidMain);
    await expect(page.getByTestId('jobs-radius-section')).toBeVisible({ timeout: 20_000 });
    const medidas: string[] = [];
    for (const [w, h] of [[390, 844], [768, 1024], [1280, 800]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => {
        const box = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
        const map = box('radius-map-box');
        const ctl = box('radius-slider');
        return {
          mapX: map.x, mapY: map.y, mapW: map.width, mapH: map.height, ctlX: ctl.x, ctlY: ctl.y, ctlW: ctl.width,
          scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        };
      });
      const lado = m.ctlX >= m.mapX + m.mapW - 1 && Math.abs(m.ctlY - m.mapY) < 80;
      const empilhado = m.ctlY >= m.mapY + m.mapH - 1;
      medidas.push(`${w}px mapa=${Math.round(m.mapW)}x${Math.round(m.mapH)}@(${Math.round(m.mapX)},${Math.round(m.mapY)}) controles=${Math.round(m.ctlW)}w@(${Math.round(m.ctlX)},${Math.round(m.ctlY)}) ladoALado=${lado} empilhado=${empilhado} scrollW=${m.scrollW}/${m.innerW}`);
      expect(m.scrollW, `${w}px: scroll horizontal`).toBeLessThanOrEqual(m.innerW);
      if (w >= 1024) expect(lado, `${w}px lado a lado`).toBe(true);
      else expect(empilhado, `${w}px empilhado`).toBe(true);
      if (w === 390) await shot(page, 'home-mapa-raio-390x844.png');
    }
    console.log('MEDIDAS\n' + medidas.join('\n'));
  });

  // Fotos do mapa (só com PRINT_DIR_096 e, para o mapa real, MAP_REAL=1 + E2E096_BASE=ba): raio 10 e 20 km, desktop e celular.
  test('home mapa raio — fotos: 10 km e 20 km em 1440x900 e 390x844', async ({ page }) => {
    test.skip(!PRINT_DIR, 'só gera fotos com PRINT_DIR_096');
    // Diagnóstico do mapa real: só o NOME do erro do Google (RefererNotAllowedMapError etc.), nunca a URL/chave.
    page.on('console', (m) => {
      const hit = m.text().match(/(RefererNotAllowedMapError|ApiNotActivatedMapError|InvalidKeyMapError|ExpiredKeyMapError|BillingNotEnabledMapError|MissingKeyMapError|OverQuotaMapError|ApiTargetBlockedMapError|[A-Za-z]+MapError)/);
      if (hit) console.log(`GOOGLE-MAPS-ERRO ${hit[1]}`);
    });
    await goHome(page, uidMain);
    await expect(page.getByTestId('jobs-radius-section')).toBeVisible({ timeout: 20_000 });
    for (const [w, h, tag] of [[1440, 900, '1440x900'], [390, 844, '390x844']] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const km of [10, 20]) {
        while (Number((await page.getByTestId('radius-up-to').textContent())!.match(/(\d+)/)![1]) < km) await pressRadius(page, 'ArrowRight');
        while (Number((await page.getByTestId('radius-up-to').textContent())!.match(/(\d+)/)![1]) > km) await pressRadius(page, 'ArrowLeft');
        await page.getByTestId('radius-map-box').scrollIntoViewIfNeeded();
        if (process.env.MAP_REAL === '1') {
          await expect(page.getByTestId('points-map')).toHaveAttribute('data-map-status', 'ready', { timeout: 20_000 });
          await expect(page.getByTestId('points-map')).toHaveAttribute('data-tiles', 'loaded', { timeout: 20_000 });
          await page.waitForTimeout(1500);
        }
        await shot(page, `mapa-real-${km}km-${tag}.png`);
      }
    }
  });
});
