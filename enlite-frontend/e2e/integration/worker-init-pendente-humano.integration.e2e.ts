/**
 * worker-init-pendente-humano @integration — o 1º login cujo `POST /api/workers/init` não dá `ok` (DP-20).
 *
 * Antes do #871 o init religava a ficha a QUALQUER conta com o e-mail dela; agora, com o token sem `email_verified`,
 * ele pede o código ao telefone DA FICHA (`claim_pending`), devolve `EMAIL_NOT_VERIFIED` ou, com a cota de OTP cheia,
 * 429. Estes casos provam a TELA que trata cada resposta (o 1º login descartava a resposta: o SMS saía sem modal e o
 * resto caía em /no-access).
 *
 * Sem mock de DADO: só o Auth do Firebase é forjado (padrão da suíte, `installAuthInterceptors`) e o `Authorization` vira
 * `mock_*` com `email_verified: false` — a request segue para a API REAL, com banco real. O OTP é o bypass do stack de
 * teste (`E2E_OTP_BYPASS`, sid `TEST_`, código `E2E_OTP_CODE`): nenhum SMS real. As rotas do init e do claim levam um
 * `X-Forwarded-For` próprio por caso (o limitador de OTP é por IP e a suíte inteira sai do mesmo host).
 * Entrada pela tela de `/login` como uma pessoa: click + foco + `keyboard.type`; valor lido da tela.
 *
 *   feliz   ficha importada com telefone → modal do código → digita o código → home, e a ficha é do login
 *   alt 1   ficha de outro login, sem telefone → "Revisá tu correo" → "Reenviar enlace" → aviso de reenvio; ficha intacta
 *   alt 2   cota de OTP do IP cheia → "Esperá unos minutos" (e não /no-access); ficha intacta
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-c-helper';
import { installAuthInterceptors, tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const API = process.env.E2E_API_URL || 'http://localhost:8080';
const OTP = process.env.E2E_OTP_CODE ?? '123456';
const SENHA = 'TestAdmin123!';
const STAMP = Date.now();
const DOMINIO = `init-pendente-${STAMP}.e2e.local`;
const CHECK_ROUTE = /\/cuenta\/verificacion$/;

const conta = (quem: string): MockUser => ({
  uid: `e2e-ip-${quem}-${STAMP}`, email: `${quem}@${DOMINIO}`, role: 'worker', country: 'AR', email_verified: false,
});
const ipDoCaso = (n: number): string => `198.18.${(STAMP % 200) + 1}.${n}`;
const telefone = (n: number): string => `5491170${String(STAMP).slice(-5)}${n}`;

function fichaImportada(u: MockUser, phone: string | null, uid = `anacareimport_dp20_${u.uid}`): string {
  const tel = phone ? `'${phone}'` : 'NULL';
  return runSQL(`INSERT INTO workers (auth_uid, email, phone, status, country) VALUES ('${uid}', '${u.email}', ${tel}, 'INCOMPLETE_REGISTER', 'AR') RETURNING id`).split('\n')[0].trim();
}
const authUidDa = (id: string): string => runSQL(`SELECT auth_uid FROM workers WHERE id = '${id}'`).trim();

/** Init e claim saem com o IP do caso (cota de OTP por IP), com o mesmo token `mock_*` do swap da suíte. */
async function ipProprio(page: Page, u: MockUser, ip: string): Promise<void> {
  await page.route(/\/api\/(workers\/init|auth\/claim\/)/, async (route: Route) => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${tokenFor(u)}`, 'x-forwarded-for': ip } });
  });
}

async function entrar(page: Page, u: MockUser, ip: string): Promise<void> {
  await installAuthInterceptors(page, u);
  await ipProprio(page, u, ip);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/login');
  const campoEmail = page.locator('input[type="email"]');
  await campoEmail.click();
  await expect(campoEmail).toBeFocused();
  await page.keyboard.type(u.email);
  await expect(campoEmail).toHaveValue(u.email);
  const campoSenha = page.locator('input[type="password"]');
  await campoSenha.click();
  await expect(campoSenha).toBeFocused();
  await page.keyboard.type(SENHA);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
}

test.describe('@integration init pendente no 1º login (DP-20)', () => {
  test.setTimeout(120_000);

  test.afterAll(() => {
    try { runSQL(`DELETE FROM workers WHERE email LIKE '%@${DOMINIO}'`); } catch { /* limpeza não esconde o resultado */ }
  });

  test('feliz: ficha importada com telefone → modal do código → digita → home, e a ficha passa ao login', async ({ page }) => {
    const u = conta('claim');
    const fichaId = fichaImportada(u, telefone(1));

    await entrar(page, u, ipDoCaso(1));
    await expect(page).toHaveURL(CHECK_ROUTE, { timeout: 30_000 });
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Detectamos tu ficha preexistente');
    expect(authUidDa(fichaId), 'religou antes do código').not.toBe(u.uid);

    const campoCodigo = page.getByTestId('otp-input');
    await campoCodigo.click();
    await expect(campoCodigo).toBeFocused();
    await page.keyboard.type(OTP);
    await expect(campoCodigo).toHaveValue(OTP);
    await modal.getByRole('button', { name: 'Confirmar' }).click();

    await expect(page).toHaveURL((url) => url.pathname === '/', { timeout: 30_000 });
    expect(authUidDa(fichaId)).toBe(u.uid);
  });

  test('alt 1: ficha de outro login sem telefone → "Revisá tu correo" → reenviar o enlace; a ficha não muda', async ({ page }) => {
    const u = conta('correo');
    const uidDaDona = `e2e-ip-dona-${STAMP}`;
    const fichaId = fichaImportada(u, null, uidDaDona);

    await entrar(page, u, ipDoCaso(2));
    await expect(page).toHaveURL(CHECK_ROUTE, { timeout: 30_000 });
    const tela = page.getByTestId('email-not-verified');
    await expect(tela.getByRole('heading', { name: 'Revisá tu correo' })).toBeVisible();
    await expect(tela).toContainText(u.email);

    await tela.getByRole('button', { name: 'Reenviar enlace' }).click();
    await expect(page.getByTestId('email-not-verified-feedback')).toHaveText('Te enviamos un nuevo enlace. Revisá también la carpeta de spam.');
    expect(authUidDa(fichaId)).toBe(uidDaDona);
    expect(runSQL(`SELECT count(*) FROM workers WHERE email = '${u.email}'`).trim()).toBe('1');
  });

  test('alt 2: cota de OTP do IP cheia → "Esperá unos minutos", e não /no-access; a ficha não muda', async ({ page }) => {
    const u = conta('espera');
    const fichaId = fichaImportada(u, telefone(3));
    const ip = ipDoCaso(3);
    // Esgota a cota (3 inits que abrem OTP) pela API real, do mesmo IP; sem SMS real (bypass do stack).
    for (let n = 0; n < 3; n++) {
      const r = await fetch(`${API}/api/workers/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(u)}`, 'X-Forwarded-For': ip },
        body: JSON.stringify({ country: 'AR' }),
      });
      expect(r.status, `init ${n + 1} da cota`).toBe(200);
    }

    await entrar(page, u, ip);
    await expect(page).toHaveURL(CHECK_ROUTE, { timeout: 30_000 });
    await expect(page.getByTestId('init-rate-limited').getByRole('heading', { name: 'Esperá unos minutos' })).toBeVisible();
    await expect(page).not.toHaveURL(/no-access/);
    expect(authUidDa(fichaId)).not.toBe(u.uid);
  });
});
