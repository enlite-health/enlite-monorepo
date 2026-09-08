/**
 * Ficha do paciente — UM rolável só (05/09, Gabriel: "a aba de serviço contratado tem 2 scrolls,
 * rolo até o fim e rolo de novo").
 *
 * Medido antes do conserto, viewport 1400×700, aba "Servicio Contratado": `main.scrollHeight` 1509
 * (o rolável esperado) E `html.scrollHeight` 958 — o documento inteiro rolava 258 px além da tela.
 * Depois de rolar o <main> até o fim, a roda passava a rolar o <html> (`scrollTop` 258). Causa: um
 * `<span class="sr-only">` (Tailwind: `position:absolute`) dentro de um <th> do LocalizacoesCard,
 * sem ancestral posicionado — containing block = <body>, fora do clip do <main>, esticando o
 * documento. Conserto: `relative` no <main> do AdminLayout (o main vira o containing block).
 *
 * Régua: (1) o documento NÃO rola (html.scrollHeight === clientHeight); (2) só <main> e o <nav> da
 * sidebar são roláveis; (3) rolar 10 000 px com a roda não move o <html>. A hipótese anterior (drawer
 * encadeando para a página) foi testada e NÃO reproduziu — o drawer não era a causa.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedPatientForDiagnosis, cleanupPatientDeep, runSQL } from '../helpers/terminology-diagnosis-helper';

// `E2E_FIREBASE_EMULATOR` aponta para o emulador de um stack isolado (`docker compose -p`); default inalterado.
const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_PASSWORD = 'TestAdmin123!';

/** E-mail novo a CADA chamada — um retry do Playwright (CI: retries 2) não pode reusar o da tentativa anterior. */
function novoStaffEmail(): string {
  return `e2e.scroll-unico.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@enlite.health`;
}

async function loginAsAdmin(page: Page, STAFF_EMAIL: string): Promise<void> {
  const auth = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(auth.ok).toBe(true);
  const { localId } = (await auth.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Scroll Unico', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

interface Scroller { tag: string; testid: string | null; scrollHeight: number; clientHeight: number; scrollTop: number }
async function scrollers(page: Page): Promise<{ list: Scroller[]; html: { scrollHeight: number; clientHeight: number; scrollTop: number } }> {
  return page.evaluate(() => {
    const list: Scroller[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        list.push({ tag: el.tagName, testid: el.getAttribute('data-testid'), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop });
      }
    }
    const h = document.documentElement;
    return { list, html: { scrollHeight: h.scrollHeight, clientHeight: h.clientHeight, scrollTop: h.scrollTop } };
  });
}

// Viewport BAIXO de propósito: é a condição em que o <main> precisa rolar e o defeito aparecia.
test.use({ viewport: { width: 1400, height: 700 } });

test.describe('Ficha do paciente — um rolável só @integration', () => {
  test.setTimeout(120_000);

  test('aba "Servicio Contratado": o documento não rola, só o <main>; rolar até o fim não move o <html>', async ({ page }, testInfo) => {
    const patient = seedPatientForDiagnosis();
    const STAFF_EMAIL = novoStaffEmail();
    try {
      await loginAsAdmin(page, STAFF_EMAIL);
      await page.goto(`/admin/patients/${patient.patientId}`);
      await page.getByTestId('patient-profile-tabs').waitFor();
      await page.getByRole('button', { name: 'Servicio Contratado' }).click();
      await page.getByTestId('new-service-btn').waitFor();
      // regra visual do CLAUDE.md do front: o estado final da aba, como a operadora vê
      await expect(page.getByTestId('patient-profile-tabs')).toHaveScreenshot('scroll-unico-tabs.png', { maxDiffPixelRatio: 0.02 });

      const before = await scrollers(page);
      testInfo.annotations.push({ type: 'evidência', description: `antes de rolar: ${JSON.stringify(before)}` });
      // (1) o documento tem EXATAMENTE a altura da tela — nada escapa do <main>
      expect(before.html.scrollHeight).toBe(before.html.clientHeight);
      // (2) o <main> é rolável (a página é longa) e é o único rolável além do <nav> da sidebar
      const main = before.list.find((s) => s.tag === 'MAIN');
      expect(main, 'o <main> precisa ser rolável nesta viewport para a régua valer').toBeDefined();
      expect(before.list.filter((s) => s.tag !== 'MAIN' && s.tag !== 'NAV')).toEqual([]);

      // (3) roda do mouse no meio da página, muito além do fim do <main>; espera o main chegar ao fim
      await page.mouse.move(700, 350);
      await page.mouse.wheel(0, 10_000);
      await expect.poll(() => page.evaluate(() => { const m = document.querySelector('main')!; return m.scrollHeight - m.clientHeight - m.scrollTop; })).toBe(0);
      const after = await scrollers(page);
      testInfo.annotations.push({ type: 'evidência', description: `depois de rolar 10 000 px: ${JSON.stringify(after)}` });
      const mainAfter = after.list.find((s) => s.tag === 'MAIN')!;
      expect(mainAfter.scrollTop).toBe(mainAfter.scrollHeight - mainAfter.clientHeight); // chegou ao fim do main…
      expect(after.html.scrollTop).toBe(0); // …e o documento continuou parado
    } finally {
      cleanupPatientDeep(patient.patientId);
      runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
    }
  });
});
