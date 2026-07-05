/**
 * vacancy-enum-i18n-real.e2e.ts
 *
 * Flow-guard proof — AUTH FIREBASE REAL (enlite-prd) + backend real (prod-auth)
 * + banco real. Nenhum page.route no caminho do fluxo.
 *
 * Regressão coberta: enum de profession renderizado cru na tela de detalhe da
 * vaga ("CASO 798 - CAREGIVER - …"). Com o fix, uma vaga real no banco com
 * required_professions={CAREGIVER} deve renderizar "Cuidador/a" no
 * VacancyCaseCard e no chip Profesión do modal de match.
 *
 * Setup real:
 *  - Login via UI em /admin/login com a conta real (gabriel.g.stein@gmail.com)
 *  - Um row admin dedicado é UPSERTado em users com o uid REAL do Firebase
 *    prod (obtido via signInWithPassword REST) — NUNCA muta o row existente
 *    (firebase_uid é PK referenciado por FKs sem ON UPDATE CASCADE)
 *  - Vaga CAREGIVER é semeada direto no Postgres e removida no teardown
 *
 * Roda SOMENTE no projeto chromium-admin (login manual de admin): os testes
 * compartilham seed + sessão, então o arquivo é serial e fica fora dos
 * projetos chromium/firefox/webkit (ver playwright.config.ts).
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const TEST_EMAIL = process.env.E2E_TEST_EMAIL ?? 'gabriel.g.stein@gmail.com';
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'Teste@123';
// Mesma API key real do frontend (enlite-prd) — ver vite .env VITE_FIREBASE_API_KEY
const FIREBASE_API_KEY =
  process.env.VITE_FIREBASE_API_KEY || 'AIzaSyByRp-NCY0m12iEoKyuIrV6vR49MZateXI';

const CONTAINER = 'enlite-postgres';
const DB = `docker exec ${CONTAINER} psql -U enlite_admin -d enlite_e2e -tAc`;

const SEED_VACANCY_ID = 'e2ee2ee2-caa1-4e2e-9e2e-00000caa0001';
// Email alias exclusivo deste suite — o teardown só deleta o row que ele criou.
const E2E_ADMIN_EMAIL = 'gabriel.g.stein+e2e-enum-i18n@gmail.com';

function sql(query: string): string {
  const escaped = query.replace(/'/g, "'\\''");
  return execSync(`${DB} '${escaped}'`, { stdio: 'pipe' }).toString().trim();
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(TEST_EMAIL);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page
    .getByRole('button', { name: /iniciar sesi[oó]n/i })
    .first()
    .click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

// Seed compartilhado entre os 2 testes → serial (um worker), sem race no teardown.
test.describe.configure({ mode: 'serial' });

test.describe('Vacancy enums via i18n — auth real + backend real @real-auth', () => {
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(async () => {
    // 1. signIn REAL no Firebase prod via REST → uid real da conta de teste
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_EMAIL,
          password: TEST_PASSWORD,
          returnSecureToken: true,
        }),
      },
    );
    const data = (await res.json()) as { localId?: string; error?: { message: string } };
    if (!data.localId) {
      throw new Error(`Firebase prod signIn failed: ${JSON.stringify(data.error)}`);
    }
    const realUid = data.localId;
    if (!/^[A-Za-z0-9_-]+$/.test(realUid)) {
      throw new Error(`Firebase uid com formato inesperado: ${realUid}`);
    }

    // 2. Garante um row admin com o uid REAL — sem mutar row existente
    //    (firebase_uid é PK com FKs sem ON UPDATE CASCADE; UPDATE quebraria
    //    em banco semeado). Se o uid já existe (ex: conta real já cadastrada),
    //    DO NOTHING — o teardown só apaga o row de email-alias deste suite.
    sql(
      `INSERT INTO users (firebase_uid, email, role, is_active)
       VALUES ('${realUid}', '${E2E_ADMIN_EMAIL}', 'admin', true)
       ON CONFLICT (firebase_uid) DO NOTHING`,
    );

    // 3. Semeia vaga real com profession CAREGIVER (enum cru no banco, como em prod)
    const vacancyNumber = sql(
      "SELECT nextval('job_postings_vacancy_number_seq')",
    );
    sql(
      `INSERT INTO job_postings
         (id, title, status, country, case_number, vacancy_number,
          required_professions, required_sex, is_draft)
       VALUES
         ('${SEED_VACANCY_ID}', 'CASO 79800-${vacancyNumber}', 'SEARCHING', 'AR',
          79800, ${vacancyNumber},
          ARRAY['CAREGIVER'], 'BOTH', false)
       ON CONFLICT (id) DO UPDATE
         SET required_professions = ARRAY['CAREGIVER'], required_sex = 'BOTH'`,
    );
  });

  test.afterAll(async () => {
    // Cada statement isolado: falha em um não pode pular o outro.
    try {
      sql(`DELETE FROM job_postings WHERE id = '${SEED_VACANCY_ID}'`);
    } finally {
      sql(`DELETE FROM users WHERE email = '${E2E_ADMIN_EMAIL}'`);
    }
  });

  test('detalhe da vaga mostra "Cuidador/a", nunca "CAREGIVER" cru', async ({
    page,
  }) => {
    await loginAsAdmin(page);

    // Fluxo real: detalhe da vaga semeada, dados vindos do backend prod-auth
    await page.goto(`/admin/vacancies/${SEED_VACANCY_ID}`);
    await expect(page.getByText(/CASO\s+79800/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // Profession traduzida no caseDesc (zone null → "Cuidador/a - Indistinto")
    const caseDesc = page.getByText(/Cuidador\/a - Indistinto/).first();
    await expect(caseDesc).toBeVisible();

    // Nenhum enum cru na página inteira
    await expect(page.locator('text=CAREGIVER')).toHaveCount(0);
    await expect(page.locator('text=/\\bBOTH\\b/')).toHaveCount(0);

    // Prova visual obrigatória — o elemento do caseDesc (conteúdo estável,
    // sem datas; screenshot do card inteiro incluiria created_at do seed)
    await expect(caseDesc).toHaveScreenshot('vacancy-case-desc-caregiver-i18n.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('modal Hacer match mostra chip Profesión "Cuidador/a"', async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto(`/admin/vacancies/${SEED_VACANCY_ID}`);
    await expect(page.getByText(/CASO\s+79800/i).first()).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole('button', { name: /Hacer match/i }).click();

    // Chip Profesión com label traduzida, sem enum cru
    const profesionLabel = page.getByText('Profesión:', { exact: false });
    await expect(profesionLabel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Cuidador/a').first()).toBeVisible();
    await expect(page.locator('text=CAREGIVER')).toHaveCount(0);

    // Prova visual obrigatória — o chip inteiro (ícone + label + valor)
    const profesionChip = profesionLabel.locator('..');
    await expect(profesionChip).toHaveScreenshot('match-chip-profesion-caregiver.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});
