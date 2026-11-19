/**
 * 097-filtros-vagas.integration.e2e.ts @integration
 *
 * Spec 097 — os 4 filtros da lista de vagas da home do prestador (tipo, provincia, localidad, sexo)
 * devolviam 0 resultado para QUALQUER opcao (opcoes fixas do scraper legado comparadas com `===`
 * ao valor cru do feed: "CABA" x "caba", "F" x "mujer", ["AT"] x "acompañante terapéutico").
 *
 * SEM MOCK de rede na parte que importa (molde: 027-public-jobs-search-en-code): frontend real
 * (Vite) + backend real (worker-functions, USE_MOCK_AUTH=true) + Postgres real. `/api/public/v1/jobs`
 * NUNCA e interceptado; a lista vem do Postgres. O unico mock e a IDENTIDADE do worker
 * (`loginAsWorker`), que nao tem relacao com o que se prova aqui.
 *
 * Interacao humana: click no combobox e click na opcao (nunca `fill`), e leitura da contagem NA TELA
 * ("N vacantes encontradas" e numero de cards). A contagem esperada sai do rotulo da propria opcao
 * ("Mujer (2)"), entao o teste nao depende de quantas vagas outros specs deixaram no banco.
 *
 * Dados 100% sinteticos (case_number 970001..970004, prefixo E2E-097, localidades "... E2E097").
 *
 * Run:
 *   E2E_PG_CONTAINER=<postgres do stack> PW_BASE_URL=http://localhost:<vite> \
 *     pnpm test:e2e:integration --grep "filtros.*vagas"
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { loginAsWorker } from '../helpers/worker-auth-helper';

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';
const TASK_PREFIX = 'E2E-097-';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  return execSync(`docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -c '${escaped}'`, { stdio: 'pipe' }).toString();
}

function extractUUID(out: string): string | null {
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

// Valores como o FEED real os entrega (medido 18/11): estado "CABA"/"Provincia de Buenos Aires", sexo F/M/BOTH,
// tipo AT/CAREGIVER. "Palermo E2E097" aparece em 2 grafias (caixa) para provar o agrupamento.
const SEEDS = [
  { n: 1, state: 'CABA', city: 'Palermo E2E097', sex: 'F', prof: 'AT' },
  { n: 2, state: 'CABA', city: 'palermo e2e097', sex: 'BOTH', prof: 'AT' },
  { n: 3, state: 'Provincia de Buenos Aires', city: 'Quilmes E2E097', sex: 'M', prof: 'CAREGIVER' },
  { n: 4, state: 'Provincia de Buenos Aires', city: 'Quilmes E2E097', sex: 'F', prof: 'AT' },
];
const caseOf = (n: number): number => 970000 + n;

function cleanup(): void {
  runSQL(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${TASK_PREFIX}%');`);
  runSQL(`DELETE FROM patient_addresses WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${TASK_PREFIX}%');`);
  runSQL(`DELETE FROM patients WHERE clickup_task_id LIKE '${TASK_PREFIX}%';`);
}

function seed(): void {
  for (const s of SEEDS) {
    const task = `${TASK_PREFIX}${s.n}`;
    runSQL(`
      INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, case_number, created_at, updated_at)
      VALUES ('${task}', 'Filtro${s.n}', 'E2E097', 'ACTIVE', 'TEA', 'MODERATE', 'AR', ${caseOf(s.n)}, NOW(), NOW());
    `);
    const patientId = extractUUID(runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${task}'`));
    if (!patientId) throw new Error('seed: paciente nao foi inserido');
    runSQL(`
      INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, state, city, lat, lng, display_order, source, created_at, updated_at)
      VALUES ('${patientId}', 'Calle Sintetica ${s.n}', 'Calle Sintetica ${s.n}', '${s.state}', '${s.city}', -34.6037, -58.3816, 1, 'manual', NOW(), NOW());
    `);
    const addressId = extractUUID(runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`));
    runSQL(`
      INSERT INTO job_postings (
        vacancy_number, case_number, title, description, patient_id, patient_address_id,
        required_professions, required_sex, providers_needed, status, is_draft, is_test, country,
        talentum_whatsapp_url, social_short_links, created_at, updated_at
      ) VALUES (
        nextval('job_postings_vacancy_number_seq'), ${caseOf(s.n)}, 'CASO SINTETICO ${caseOf(s.n)}', '',
        '${patientId}', '${addressId}',
        ARRAY['${s.prof}']::varchar[], '${s.sex}', 1, 'SEARCHING', false, false, 'AR',
        'https://wa.me/5491100000097',
        '{"site": "https://jobs.enlite.health/es/vagas/${caseOf(s.n)}/"}'::jsonb,
        NOW(), NOW()
      );
    `);
  }
}

async function goHome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
  });
  const authUid = `e2e-worker-097-filtros-${Date.now()}`;
  await loginAsWorker(page, authUid, `${authUid}@test.local`);
  await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('job-card').first()).toBeVisible({ timeout: 20_000 });
}

const FILTER_NAME = { type: 'Tipos de Trabajador', province: 'Provincia', locality: 'Localidad', sex: 'Sexo' } as const;
type Filter = keyof typeof FILTER_NAME;

async function open(page: Page, filter: Filter): Promise<void> {
  await page.getByRole('combobox', { name: FILTER_NAME[filter], exact: true }).click();
}

/** Rotulos das opcoes do painel aberto (sem a linha "Todas"). */
async function optionLabels(page: Page): Promise<string[]> {
  return (await page.getByRole('option').allTextContents()).map((s) => s.trim());
}

/** Abre o filtro e escolhe a opcao cujo rotulo casa com `label` (click humano, nunca fill). */
async function choose(page: Page, filter: Filter, label: RegExp): Promise<string> {
  await open(page, filter);
  const opt = page.getByRole('option', { name: label });
  const text = ((await opt.first().textContent()) ?? '').trim();
  await opt.first().click();
  return text;
}

async function resultsOnScreen(page: Page): Promise<number> {
  const txt = (await page.getByText(/vacantes encontradas/).first().textContent()) ?? '';
  return Number(txt.match(/(\d+)\s+vacantes encontradas/)![1]);
}

const countInLabel = (label: string): number => Number(label.match(/\((\d+)\)\s*$/)![1]);

async function expectScreenCount(page: Page, expected: number): Promise<void> {
  await expect.poll(() => resultsOnScreen(page), { timeout: 10_000 }).toBe(expected);
  await expect(page.getByTestId('job-card')).toHaveCount(expected);
}

test.describe('@integration Home — filtros de vagas do prestador (097)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  test.beforeAll(() => { cleanup(); seed(); });
  test.afterAll(() => { cleanup(); });

  test('feliz — cada filtro devolve >= 1 vaga e a contagem da tela e a do rotulo da opcao (dado real do Postgres)', async ({ page }) => {
    await goHome(page);
    const total = await resultsOnScreen(page);
    expect(total).toBeGreaterThanOrEqual(SEEDS.length);

    const casos: Array<[Filter, RegExp, number]> = [
      ['province', /^CABA \(\d+\)$/i, 2],
      ['province', /^Provincia de Buenos Aires \(\d+\)$/i, 2],
      ['type', /^Acompañante Terapéutico \(\d+\)$/, 3],
      ['type', /^Cuidador\/a \(\d+\)$/, 1],
      ['sex', /^Mujer \(\d+\)$/, 2],
      ['sex', /^Varón \(\d+\)$/, 1],
      ['sex', /^Indistinto \(\d+\)$/, 1],
      ['locality', /^palermo e2e097 \(2\)$|^Palermo E2E097 \(2\)$/, 2],
      ['locality', /^Quilmes E2E097 \(2\)$/, 2],
    ];
    const lidas: string[] = [];
    for (const [filter, label, minimo] of casos) {
      const escolhida = await choose(page, filter, label);
      const n = countInLabel(escolhida);
      expect(n, escolhida).toBeGreaterThanOrEqual(minimo);
      await expectScreenCount(page, n);
      lidas.push(`${filter}: "${escolhida}" -> ${n} na tela`);
      await page.getByRole('button', { name: 'Limpiar Filtros' }).click();
      await expectScreenCount(page, total);
    }
    console.log('CONTAGEM LIDA NA TELA\n' + lidas.join('\n'));
  });

  test('feliz — as opcoes saem dos valores do feed: sem duplicata de sexo, sem Misiones', async ({ page }) => {
    await goHome(page);
    await open(page, 'sex');
    const sexos = (await optionLabels(page)).filter((l) => /\(\d+\)$/.test(l)).map((l) => l.replace(/ \(\d+\)$/, ''));
    expect(sexos.sort()).toEqual(['Indistinto', 'Mujer', 'Varón']);
    await page.keyboard.press('Escape');
    await open(page, 'province');
    const provs = (await optionLabels(page)).join('|');
    expect(provs).not.toMatch(/Misiones/i);
  });

  test('A1 — combinar tipo + provincia da a intersecao e "Limpiar Filtros" volta ao total', async ({ page }) => {
    await goHome(page);
    const total = await resultsOnScreen(page);

    const tipo = await choose(page, 'type', /^Cuidador\/a \(\d+\)$/);
    const nTipo = countInLabel(tipo);
    await expectScreenCount(page, nTipo);

    const prov = await choose(page, 'province', /^Provincia de Buenos Aires \(\d+\)$/i);
    const nProv = countInLabel(prov);
    const inter = await resultsOnScreen(page);
    expect(inter).toBeGreaterThanOrEqual(1); // a vaga 970003 e CAREGIVER em Provincia de Buenos Aires
    expect(inter).toBeLessThanOrEqual(Math.min(nTipo, nProv));
    await expect(page.getByTestId('job-card')).toHaveCount(inter);

    await page.getByRole('button', { name: 'Limpiar Filtros' }).click();
    await expectScreenCount(page, total);
  });

  test('A2 — escolher "Todas" restaura a lista sem apertar Limpiar', async ({ page }) => {
    await goHome(page);
    const total = await resultsOnScreen(page);

    const sexo = await choose(page, 'sex', /^Mujer \(\d+\)$/);
    await expectScreenCount(page, countInLabel(sexo));

    await open(page, 'sex');
    await page.getByRole('option', { name: 'Todos', exact: true }).click();
    await expectScreenCount(page, total);
  });
});
