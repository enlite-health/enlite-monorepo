/**
 * workerRegistrationUi — completa o cadastro do prestador DIRIGINDO A TELA.
 *
 * Existe porque a versão por API (`workerRegistration.ts`) não é uma jornada: ela
 * prova que o backend grava, nunca que o formulário chama o backend. Em 31/08/2026
 * um `<select>` da aba Geral parou de salvar (a tela não tem botão Guardar e o
 * campo não disparava o autosave); 50 prestadoras travaram e o monitor das 3h
 * seguiu verde, porque rodava `workerCtx.put(...)` no lugar do formulário.
 * Regra 3 do CLAUDE.md desta suíte: *setup/teardown via API; fluxo sob teste via UI.*
 *
 * PRINCÍPIOS destes helpers — o que os torna capazes de ver aquele bug:
 *
 *  1. **Nenhum gesto de resgate.** É PROIBIDO forçar blur, clicar num campo vizinho
 *     ou apertar algo só para arrancar o save. Se o teste precisa de empurrão para o
 *     PUT sair, o empurrão É o bug. O helper do frontend fazia exatamente isso
 *     (`#fullName`.blur()) e por isso passava verde com o campo quebrado.
 *  2. **Um gesto, um save.** Cada campo é preenchido e o PUT dele é esperado ANTES
 *     do próximo. Preencher 15 campos e olhar um PUT só mascara o campo que não
 *     salva — o vizinho dispara o save e carrega o valor junto.
 *  3. **Assertar efeito, não status.** `status < 400` não prova que o dado ficou.
 *     Quem fecha a prova é o spec, relendo pela API admin o valor que a TELA
 *     escolheu (`fillGeneralInfoViaUi` devolve esse valor justamente para isso).
 *
 * Zero mock (`page.route` é banido aqui): o autocomplete de endereço é o Google real
 * de prod, e o documento sobe pelo fluxo de signed URL real.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { readTinyDocumentPng } from './workerRegistration';

/** Espera o PUT/POST de um endpoint e assere que passou — sem gesto de resgate. */
async function expectSaved(
  page: Page,
  urlPart: string,
  method: 'PUT' | 'POST',
  gesture: () => Promise<void>,
  label: string,
  timeout = 20_000,
): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.url().includes(urlPart) && r.request().method() === method,
    { timeout },
  );
  await gesture();
  // Sem este catch a falha vira um "waitForResponse timeout" anônimo e some a
  // informação que interessa: QUAL campo não salvou.
  const resp = await saved.catch(() => {
    throw new Error(
      `[${label}] o gesto na tela NÃO disparou ${method} ${urlPart} em ${timeout / 1000}s. ` +
        'O campo não está salvando sozinho — é exatamente o defeito de 31/08.',
    );
  });
  expect(resp.status(), `${label}: o autosave tem de sair sozinho e passar`).toBeLessThan(400);
}

/** Abre uma aba do perfil e espera ela pintar. */
async function gotoTab(
  page: Page,
  tab: 'general' | 'address' | 'availability' | 'documents',
): Promise<void> {
  await page.goto(`/worker/profile?tab=${tab}`);
  await expect(page.locator(`[data-testid="tab-btn-${tab}"]`)).toBeVisible({ timeout: 30_000 });
}

/** Abre um MultiSelect, marca a 1ª opção e fecha. Estes JÁ salvam no onChange. */
async function pickFirstMultiSelect(page: Page, testId: string, label: string): Promise<void> {
  const trigger = page.locator(`[data-testid="${testId}-trigger"]`);
  await expect(trigger, `${label}: gatilho visível`).toBeVisible({ timeout: 15_000 });
  await expectSaved(
    page,
    '/api/workers/me/general-info',
    'PUT',
    async () => {
      await trigger.click();
      const dropdown = page.locator(`[data-testid="${testId}-dropdown"]`);
      await expect(dropdown, `${label}: dropdown abriu`).toBeVisible({ timeout: 10_000 });
      await dropdown.locator('div').first().click();
      await page.keyboard.press('Escape');
      await expect(dropdown, `${label}: dropdown fechou`).toBeHidden({ timeout: 10_000 });
    },
    label,
  );
}

/**
 * Cria a conta pela TELA de cadastro (`/register`): e-mail + senha + confirmação +
 * consentimento. Sem WhatsApp de propósito — com telefone o init pode cair no ramo
 * `claim_pending` (modal de OTP), que é outro fluxo e tem spec própria.
 *
 * A página chama `initWorker` e navega para `/login` — é onde esperamos parar.
 */
export async function registerWorkerViaUi(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/register');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/crear su cuenta/i, {
    timeout: 30_000,
  });

  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('#confirmPassword').fill(password);

  // O <input> do Checkbox é `sr-only` (acessível, não clicável). Quem o usuário
  // clica é o <label> — e é isso que fazemos, em vez de `force: true`, que pularia
  // justamente a camada que o usuário toca.
  const consent = page.locator('#lgpdOptIn');
  if ((await consent.count()) > 0) {
    await page.locator('label[for="lgpdOptIn"]').click();
    await expect(consent, 'consentimento marcado').toBeChecked({ timeout: 10_000 });
  }

  await page.getByRole('button', { name: 'Registrarse' }).click();

  // A RegisterPage só navega DEPOIS do initWorker resolver — sair de /register é a
  // prova de que a conta Firebase e a linha em `workers` existem. (Ela vai para
  // `returnUrl ?? '/'`, NÃO para /login: o cadastro já deixa a sessão autenticada.)
  await expect(page, 'o cadastro concluiu e saiu de /register').not.toHaveURL(/\/register/, {
    timeout: 45_000,
  });
}

/**
 * Abre o perfil do prestador com a sessão que o cadastro já deixou aberta.
 * Se o `ProtectedRoute` mandar para /login, este assert falha alto — que é o
 * comportamento certo: seria uma regressão do fluxo de cadastro.
 */
export async function openWorkerProfile(page: Page): Promise<void> {
  await page.goto('/worker/profile?tab=general');
  await expect(page.locator('#fullName'), 'perfil abriu com a sessão do cadastro').toBeVisible({
    timeout: 45_000,
  });
}

/**
 * Preenche a aba "Información General" campo a campo, esperando o autosave de CADA
 * gesto. É aqui que mora a regressão: os `<select>` têm de salvar sozinhos.
 *
 * @returns o valor escolhido em "anos de experiência", para o assert de ida-e-volta.
 */
export async function fillGeneralInfoViaUi(
  page: Page,
  opts: { phone: string; cuil: string; profession: 'CAREGIVER' | 'AT' },
): Promise<{ yearsExperience: string }> {
  await gotoTab(page, 'general');

  const YEARS = '6_10';
  const put = '/api/workers/me/general-info';

  // Campos de texto: o autosave sai no blur do próprio campo (Tab), que é o que o
  // usuário faz ao seguir para o campo seguinte — não é gesto de resgate.
  const text: Array<[string, string, string]> = [
    ['#fullName', 'Worker', 'nombre'],
    ['#lastName', 'JourneyE2E', 'apellido'],
    ['#birthDate', '01/01/1990', 'fecha de nacimiento'],
    ['#cpf', opts.cuil, 'CUIL'],
    ['#professionalLicense', 'Cert-Journey-E2E', 'título'],
  ];
  for (const [sel, value, label] of text) {
    await expectSaved(page, put, 'PUT', async () => {
      await page.locator(sel).fill(value);
      await page.locator(sel).press('Tab');
    }, label);
  }

  await expectSaved(page, put, 'PUT', async () => {
    const phone = page.locator('input[type="tel"]').first();
    await phone.fill(opts.phone);
    await phone.press('Tab');
  }, 'teléfono');

  // ── Os 5 <select> nativos — o coração desta regressão ──────────────────────
  // Cada um é UM gesto isolado: seleciona e o PUT tem de sair. Sem tocar em mais
  // nada. Foi assim que a prestadora usou a tela, e foi assim que o dado se perdeu.
  const selects: Array<[string, string, string]> = [
    ['select#sex', 'female', 'sexo'],
    ['select#gender', 'female', 'género'],
    ['select#profession', opts.profession, 'profesión'],
    ['select#knowledgeLevel', 'TERTIARY', 'nivel de formación'],
    ['select#yearsExperience', YEARS, 'años de experiencia'],
  ];
  for (const [sel, value, label] of selects) {
    await expectSaved(
      page,
      put,
      'PUT',
      async () => {
        await page.locator(sel).selectOption(value);
      },
      label,
    );
  }

  await pickFirstMultiSelect(page, 'languages', 'idiomas');
  await pickFirstMultiSelect(page, 'experience-types', 'experiencia con');
  await pickFirstMultiSelect(page, 'preferred-types', 'preferencia de pacientes');
  await pickFirstMultiSelect(page, 'preferred-age-range', 'franja etaria');

  return { yearsExperience: YEARS };
}

/**
 * Escolhe o endereço no autocomplete REAL do Google (sem mock: `page.route` é banido
 * nesta suíte). Digitar já não basta — o componente exige seleção de um `place`,
 * então clicamos na sugestão do `.pac-container`, que é o DOM do próprio Google.
 */
export async function fillServiceAreaViaUi(page: Page): Promise<void> {
  await gotoTab(page, 'address');
  const input = page.locator('[data-testid="address-autocomplete-input"]');
  await expect(input).toBeVisible({ timeout: 20_000 });

  // A escuta do PUT começa ANTES de digitar: o Autocomplete do Google pode disparar
  // `place_changed` ainda durante a datilografia (ele auto-seleciona a 1ª predição), e
  // aí o autosave sai antes de qualquer ArrowDown — foi o que fez as primeiras versões
  // deste passo "não ver" um save que tinha acontecido. Janela maior porque digitar +
  // esperar o Google responder passa de 20s.
  // (`fill()` não serve: o Autocomplete escuta digitação de verdade, não `value=`.)
  await expectSaved(
    page,
    '/api/workers/me/service-area',
    'PUT',
    async () => {
      await input.click();
      await input.pressSequentially('Av. Corrientes 1234', { delay: 120 });
      await expect(page.locator('.pac-item').first(), 'Google devolveu sugestão').toBeVisible({
        timeout: 30_000,
      });
      // Clique de mouse pelas COORDENADAS do item. `locator.click()` não serve: a
      // lista do Google se desmonta no blur e o elemento some entre a checagem de
      // actionability e o mousedown (medido: timeout de 20s).
      // ⚠️ ArrowDown+Enter TAMBÉM não serve — e não é limitação do teste: medido em
      // prod, escolher pelo teclado NÃO grava o endereço (60s sem PUT). Está na lista
      // de achados; quando for corrigido, vale um caso a mais aqui cobrindo o teclado.
      const box = await page.locator('.pac-item').first().boundingBox();
      expect(box, 'a sugestão do Google tem caixa clicável').not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    },
    'dirección',
    60_000,
  );
}

/** Marca disponibilidade na tela (segunda-feira, faixa padrão). */
export async function fillAvailabilityViaUi(page: Page): Promise<void> {
  await gotoTab(page, 'availability');
  await expect(page.locator('[data-testid="day-schedule-editor"]')).toBeVisible({ timeout: 20_000 });

  await expectSaved(
    page,
    '/api/workers/me/availability',
    'PUT',
    () => page.locator('[data-testid="day-schedule-add-monday"]').click(),
    'disponibilidad',
  );
}

/**
 * Sobe os documentos pelo input de arquivo real. O fluxo de 3 passos
 * (upload-url → PUT ao GCS → documents/save) roda inteiro contra prod.
 * O último save cumpre o gate e o `recalculateStatus` leva o worker a REGISTERED.
 */
export async function uploadDocumentsViaUi(page: Page, docTypes: string[]): Promise<void> {
  await gotoTab(page, 'documents');
  const png = readTinyDocumentPng();

  for (const docType of docTypes) {
    const slot = page.locator(`[data-testid="doc-slot-${docType}"]`);
    await expect(slot, `slot ${docType} visível`).toBeVisible({ timeout: 20_000 });

    await expectSaved(
      page,
      '/api/workers/me/documents/save',
      'POST',
      () =>
        slot.locator('input[type="file"]').setInputFiles({
          name: 'tiny-document.png',
          mimeType: 'image/png',
          buffer: png,
        }),
      `documento ${docType}`,
      60_000, // 3 saltos: upload-url → PUT ao GCS → documents/save
    );

    await expect(
      slot.locator('[data-state="uploaded"]'),
      `slot ${docType} pinta como enviado`,
    ).toBeVisible({ timeout: 20_000 });
  }
}

interface AdminWorkerRow {
  success: boolean;
  data: { workers?: Array<{ id: string }> } | Array<{ id: string }>;
}

/** Resolve o id do worker pelo e-mail, via API admin (busca por e-mail é suportada). */
export async function findWorkerIdByEmail(
  adminCtx: APIRequestContext,
  email: string,
): Promise<string> {
  const res = await adminCtx.get(`/api/admin/workers?search=${encodeURIComponent(email)}&limit=5`);
  expect(res.status(), 'GET /api/admin/workers deve responder 200').toBe(200);
  const body = (await res.json()) as AdminWorkerRow;
  const rows = Array.isArray(body.data) ? body.data : (body.data?.workers ?? []);
  const first = rows[0];
  expect(first?.id, 'a busca por e-mail encontra o worker recém-cadastrado').toBeTruthy();
  return first!.id;
}
