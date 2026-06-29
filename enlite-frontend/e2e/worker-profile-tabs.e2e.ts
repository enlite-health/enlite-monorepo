/**
 * worker-profile-tabs.e2e.ts
 *
 * Testes E2E para as 4 abas do formulário de perfil do worker:
 *   Aba 1 — Información General  → PUT /api/workers/me/general-info
 *   Aba 2 — Dirección de Atención → PUT /api/workers/me/service-area
 *   Aba 3 — Disponibilidad        → PUT /api/workers/me/availability
 *   Aba 4 — Documentos            → GET/POST/DELETE /api/workers/me/documents/*
 *
 * Modelo de salvamento (importante):
 *   NÃO há botão "Guardar". O formulário usa AUTOSAVE on-blur/on-change
 *   (useAutoSave, debounce 500ms). Cada salvamento bem-sucedido dispara um
 *   TOAST flutuante (data-testid="toast-success"); erros disparam
 *   data-testid="toast-error". A navegação entre etapas fica no rodapé
 *   ProfileWizardFooter (Atrás/Siguiente/Finalizar), dentro do card.
 *
 * Componentes:
 *   - Selects nativos (SelectField): #sex #gender #profession #knowledgeLevel
 *     #yearsExperience — valores canônicos (profession/knowledge em UPPERCASE).
 *   - MultiSelect (dropdown custom, data-testid `<id>-trigger`/`<id>-dropdown`):
 *     languages, experience-types, preferred-types, preferred-age-range.
 *   - DayScheduleEditor + TimeSelect (dropdown custom, NÃO input[type=time]).
 *
 * Pré-requisitos: dev server em http://localhost:5173 + auth state do worker
 *   (e2e/auth.setup.ts). O bloco "ponta a ponta" só roda com E2E_REAL_API=1.
 */

import { test, expect, Page } from '@playwright/test';

// Worker auth — gerado pelo auth.setup.ts (REST no Firebase)
test.use({ storageState: 'e2e/.auth/profile-worker.json' });

// Mensagens — exatamente como definidas em es.json
const MSG = {
  fullNameMin:         'El nombre completo debe tener al menos 3 caracteres',
  lastNameRequired:    'El apellido es obligatorio',
  documentInvalid:     'Documento inválido',
  licenseRequired:     'El registro profesional es obligatorio',
  selectKnowledge:     'Por favor, seleccione el nivel de conocimiento',
  selectYears:         'Por favor, seleccione los años de experiencia',
  saveSuccess:         'Información guardada con éxito',
};

// ─────────────────────────────────────────────────────────────
// Helpers — interação com componentes customizados
// ─────────────────────────────────────────────────────────────

/** Abre o dropdown de um MultiSelect via data-testid e seleciona uma opção. */
async function selectInMultiSelect(page: Page, testId: string, optionLabel: string): Promise<void> {
  await page.locator(`[data-testid="${testId}-trigger"]`).click();
  await page.locator(`[data-testid="${testId}-dropdown"]`).getByText(optionLabel, { exact: true }).click();
}

/** Fecha MultiSelect aberto pressionando Escape */
async function closeMultiSelect(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
}

/** Aguarda o toast de sucesso do autosave aparecer. */
async function expectSaveToast(page: Page): Promise<void> {
  await expect(page.getByTestId('toast-success')).toBeVisible({ timeout: 6_000 });
}

/**
 * Captura o body do último PUT em `urlPart` e responde 200.
 * Retorna um getter para o último payload capturado.
 */
async function capturePut(
  page: Page,
  urlPart: string,
  status = 200,
): Promise<{ getBody: () => Record<string, unknown> | null }> {
  let captured: Record<string, unknown> | null = null;
  await page.route(`**${urlPart}`, async (route) => {
    if (route.request().method() === 'PUT') {
      captured = route.request().postDataJSON();
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(status < 400 ? { success: true, data: {} } : { success: false, error: 'error' }),
      });
    } else {
      await route.continue();
    }
  });
  return { getBody: () => captured };
}

/**
 * Dispara um autosave da aba General e aguarda o PUT correspondente.
 * O autosave roda em qualquer blur enviando o form inteiro (getValues()).
 */
async function triggerGeneralInfoSave(page: Page): Promise<Record<string, unknown>> {
  await page.waitForTimeout(700); // deixa eventuais saves debounced pendentes resolverem
  const respPromise = page.waitForResponse(
    (r) => r.url().includes('/api/workers/me/general-info') && r.request().method() === 'PUT',
  );
  await page.locator('#fullName').click();
  await page.locator('#fullName').blur();
  const resp = await respPromise;
  return resp.request().postDataJSON();
}

/** Preenche todos os campos obrigatórios da aba Información General. */
async function fillGeneralInfoForm(page: Page): Promise<void> {
  await page.locator('#fullName').fill('Alberto');
  await page.locator('#lastName').fill('Marquez');

  await page.locator('#birthDate').fill('');
  await page.locator('#birthDate').pressSequentially('18031990', { delay: 30 });

  await page.locator('#cpf').fill('20123456780');

  // Selects nativos — valores canônicos
  await page.selectOption('#sex', 'male');
  await page.selectOption('#gender', 'male');
  await page.selectOption('#profession', 'CAREGIVER');
  await page.selectOption('#knowledgeLevel', 'TECNICATURA');
  await page.selectOption('#yearsExperience', '0_2');

  await page.locator('#professionalLicense').fill('Técnico en cuidados geriátricos');

  // Telefone — PhoneInputIntl renderiza <input type="tel">
  const phoneInput = page.locator('input[type="tel"]').first();
  if (await phoneInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await phoneInput.fill('+5491112345678');
  }

  // MultiSelects customizados
  await selectInMultiSelect(page, 'languages', 'Español');
  await closeMultiSelect(page);
  await selectInMultiSelect(page, 'experience-types', 'Adicciones');
  await closeMultiSelect(page);
  await selectInMultiSelect(page, 'preferred-types', 'Adicciones');
  await closeMultiSelect(page);
  await selectInMultiSelect(page, 'preferred-age-range', 'Adultos mayores');
  await closeMultiSelect(page);
}

/** Localiza os botões TimeSelect (start/end) de um dia. */
function timeSelects(page: Page, dayKey: string) {
  return page.getByTestId(`day-schedule-row-${dayKey}`).locator('button').filter({ hasText: /\d{2}:\d{2}/ });
}

/** Abre o TimeSelect indicado e escolhe um horário no dropdown. */
async function setSlotTime(page: Page, dayKey: string, index: number, time: string): Promise<void> {
  await timeSelects(page, dayKey).nth(index).click();
  await page.locator('li button', { hasText: new RegExp(`^${time}$`) }).first().click();
}

// ─────────────────────────────────────────────────────────────
// Suite principal
// ─────────────────────────────────────────────────────────────

test.describe('Worker Profile — Abas de Edição', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    // Intercepta getProgress para não depender de dados pré-existentes no banco
    await page.route('**/api/workers/me', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              email: 'worker@test.com',
              firstName: '', lastName: '', phone: '', documentNumber: '',
              birthDate: null, sex: null, gender: null, documentType: 'DNI',
              titleCertificate: '', languages: [], profession: null,
              knowledgeLevel: null, experienceTypes: [], yearsExperience: null,
              preferredTypes: [], preferredAgeRange: null, profilePhotoUrl: null,
              serviceAddress: null, serviceRadiusKm: 10, availability: [],
            },
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/worker/profile');
    await page.waitForSelector('nav[aria-label="Tabs"]', { timeout: 10_000 });
  });

  // ══════════════════════════════════════════════════════════
  // ESTRUTURA DA PÁGINA
  // ══════════════════════════════════════════════════════════

  test.describe('Estrutura da Página', () => {
    test('exibe título "Mi Perfil" em espanhol', async ({ page }) => {
      await expect(page.locator('h1')).toContainText('Mi Perfil');
    });

    test('exibe 4 abas com labels exatos em espanhol', async ({ page }) => {
      const nav = page.locator('nav[aria-label="Tabs"]');
      await expect(nav.getByRole('button', { name: 'Información General' })).toBeVisible();
      await expect(nav.getByRole('button', { name: 'Dirección de Atención' })).toBeVisible();
      await expect(nav.getByRole('button', { name: 'Disponibilidad' })).toBeVisible();
      await expect(nav.getByRole('button', { name: 'Documentos' })).toBeVisible();
    });

    test('primeira aba fica ativa por padrão (aria-current="page")', async ({ page }) => {
      const activeTab = page.locator('nav[aria-label="Tabs"] button[aria-current="page"]');
      await expect(activeTab).toContainText('Información General');
    });

    test('NÃO existe botão "Guardar" (form usa autosave on-blur)', async ({ page }) => {
      await expect(page.getByRole('button', { name: 'Guardar' })).toHaveCount(0);
    });

    test('rodapé de navegação exibe Atrás/Siguiente', async ({ page }) => {
      const footer = page.getByTestId('profile-wizard-footer');
      await expect(footer).toBeVisible();
      await expect(footer.getByTestId('wizard-back')).toBeVisible();
      await expect(footer.getByTestId('wizard-next')).toBeVisible();
    });

    test('Siguiente avança para a próxima aba', async ({ page }) => {
      await page.getByTestId('wizard-next').click();
      const activeTab = page.locator('nav[aria-label="Tabs"] button[aria-current="page"]');
      await expect(activeTab).toContainText('Dirección de Atención');
    });

    test('na última aba o rodapé exibe Finalizar', async ({ page }) => {
      await page.getByRole('button', { name: 'Documentos' }).click();
      await expect(page.getByTestId('wizard-finish')).toBeVisible();
    });

    test('conteúdo muda ao clicar em cada aba', async ({ page }) => {
      await page.getByRole('button', { name: 'Dirección de Atención' }).click();
      await expect(page.getByText('¿A cuántos km está dispuesto a atender?')).toBeVisible();

      await page.getByRole('button', { name: 'Disponibilidad' }).click();
      await expect(page.getByText('Seleccione los días y horarios de su disponibilidad:')).toBeVisible();

      await page.getByRole('button', { name: 'Información General' }).click();
      await expect(page.locator('#email')).toBeVisible();
    });
  });

  // ══════════════════════════════════════════════════════════
  // ABA 1 — INFORMACIÓN GENERAL
  // ══════════════════════════════════════════════════════════

  test.describe('Aba 1 — Información General', () => {

    // ── Validações de campo (on-blur) ───────────────────────
    test.describe('Validações — mensagens exatas em espanhol', () => {

      test('nome com < 3 chars → mensagem de mínimo', async ({ page }) => {
        await page.locator('#fullName').fill('Ab');
        await page.locator('#fullName').blur();
        await expect(page.getByText(MSG.fullNameMin)).toBeVisible();
      });

      test('sobrenome vazio após interação → "El apellido es obligatorio"', async ({ page }) => {
        await page.locator('#lastName').fill('x');
        await page.locator('#lastName').fill('');
        await page.locator('#lastName').blur();
        await expect(page.getByText(MSG.lastNameRequired)).toBeVisible();
      });

      test('documento com < 11 dígitos → "Documento inválido"', async ({ page }) => {
        await page.locator('#cpf').fill('1234567890');
        await page.locator('#cpf').blur();
        await expect(page.getByText(MSG.documentInvalid)).toBeVisible();
      });

      test('título profissional vazio → "El registro profesional es obligatorio"', async ({ page }) => {
        await page.locator('#professionalLicense').fill('x');
        await page.locator('#professionalLicense').fill('');
        await page.locator('#professionalLicense').blur();
        await expect(page.getByText(MSG.licenseRequired)).toBeVisible();
      });

      test('nível de conhecimento limpo → mensagem de seleção', async ({ page }) => {
        await page.selectOption('#knowledgeLevel', 'BACHELOR');
        await page.selectOption('#knowledgeLevel', '');
        await page.locator('#knowledgeLevel').blur();
        await expect(page.getByText(MSG.selectKnowledge)).toBeVisible();
      });

      test('anos de experiência limpos → mensagem de seleção', async ({ page }) => {
        await page.selectOption('#yearsExperience', '0_2');
        await page.selectOption('#yearsExperience', '');
        await page.locator('#yearsExperience').blur();
        await expect(page.getByText(MSG.selectYears)).toBeVisible();
      });
    });

    // ── Máscara de Data ─────────────────────────────────────
    test.describe('Máscara de data de nascimento', () => {

      test('digitar "18031990" formata para "18/03/1990"', async ({ page }) => {
        const input = page.locator('#birthDate');
        await input.click();
        await input.fill('');
        await input.pressSequentially('18031990', { delay: 30 });
        await expect(input).toHaveValue('18/03/1990');
      });

      test('placeholder exibe o formato esperado "18/03/1960"', async ({ page }) => {
        await expect(page.locator('#birthDate')).toHaveAttribute('placeholder', '18/03/1960');
      });

      test('inserir data parcial mantém máscara parcial', async ({ page }) => {
        const input = page.locator('#birthDate');
        await input.fill('');
        await input.pressSequentially('1803', { delay: 30 });
        expect(await input.inputValue()).toBe('18/03');
      });

      test('autosave: API recebe birthDate no formato AAAA-MM-DD', async ({ page }) => {
        await capturePut(page, '/api/workers/me/general-info');
        await fillGeneralInfoForm(page);
        const body = await triggerGeneralInfoSave(page);
        await expectSaveToast(page);
        expect(body?.birthDate).toBe('1990-03-18');
      });
    });

    // ── Labels e Opções em Espanhol ─────────────────────────
    test.describe('Select — labels e opções em espanhol', () => {

      test('campo Sexo tem opções "Masculino" e "Femenino"', async ({ page }) => {
        const select = page.locator('#sex');
        await expect(select.locator('option[value="male"]')).toHaveText('Masculino');
        await expect(select.locator('option[value="female"]')).toHaveText('Femenino');
      });

      test('campo Sexo tem placeholder "Seleccione"', async ({ page }) => {
        await expect(page.locator('#sex').locator('option[value=""]')).toHaveText('Seleccione');
      });

      test('campo Profissão tem as opções canônicas em espanhol', async ({ page }) => {
        const select = page.locator('#profession');
        await expect(select.locator('option[value="AT"]')).toHaveText('Acompañante Terapéutico');
        await expect(select.locator('option[value="CAREGIVER"]')).toHaveText('Cuidador(a)');
        await expect(select.locator('option[value="NURSE"]')).toHaveText('Enfermera(o)');
        await expect(select.locator('option[value="PSYCHOLOGIST"]')).toHaveText('Psicóloga(o)');
      });

      test('campo Nível de Conhecimento tem opções em espanhol', async ({ page }) => {
        const select = page.locator('#knowledgeLevel');
        await expect(select.locator('option[value="BACHELOR"]')).toHaveText('Licenciatura');
        await expect(select.locator('option[value="TECNICATURA"]')).toHaveText('Tecnicatura');
        await expect(select.locator('option[value="MASTERS"]')).toHaveText('Maestría');
        await expect(select.locator('option[value="DOCTORATE"]')).toHaveText('Doctorado');
      });

      test('campo Anos de Experiência tem as 4 faixas em espanhol', async ({ page }) => {
        const select = page.locator('#yearsExperience');
        await expect(select.locator('option[value="0_2"]')).toHaveText('0-2 años');
        await expect(select.locator('option[value="3_5"]')).toHaveText('3-5 años');
        await expect(select.locator('option[value="6_10"]')).toHaveText('6-10 años');
        await expect(select.locator('option[value="10_plus"]')).toHaveText('10 o más');
      });

      test('campo de documento exibe CUIL/CUIT (sem dropdown de tipo)', async ({ page }) => {
        await expect(page.locator('#documentType')).toHaveCount(0);
        await expect(page.locator('#cpf')).toBeVisible();
        await expect(page.locator('#cpf')).toHaveAttribute('placeholder', '00-00000000-0');
      });
    });

    // ── Campos Readonly ──────────────────────────────────────
    test.describe('Campos readonly', () => {

      test('campo email é somente leitura (readonly)', async ({ page }) => {
        await expect(page.locator('#email')).toHaveAttribute('readonly', '');
      });

      test('campo email não pode ser editado pelo usuário', async ({ page }) => {
        const emailInput = page.locator('#email');
        const originalValue = await emailInput.inputValue();
        await emailInput.fill('hacked@evil.com');
        await expect(emailInput).toHaveValue(originalValue);
      });
    });

    // ── Autosave — Happy Path ────────────────────────────────
    test.describe('Autosave — fluxo de sucesso', () => {

      test('preencher formulário válido → toast "Información guardada con éxito"', async ({ page }) => {
        const { getBody } = await capturePut(page, '/api/workers/me/general-info');
        await fillGeneralInfoForm(page);
        await triggerGeneralInfoSave(page);
        await expectSaveToast(page);
        expect(getBody()).not.toBeNull();
      });

      test('payload tem firstName e lastName corretos', async ({ page }) => {
        await capturePut(page, '/api/workers/me/general-info');
        await fillGeneralInfoForm(page);
        const body = await triggerGeneralInfoSave(page);
        expect(body?.firstName).toBe('Alberto');
        expect(body?.lastName).toBe('Marquez');
      });

      test('payload tem profession = "CAREGIVER"', async ({ page }) => {
        await capturePut(page, '/api/workers/me/general-info');
        await fillGeneralInfoForm(page);
        const body = await triggerGeneralInfoSave(page);
        expect(body?.profession).toBe('CAREGIVER');
      });

      test('payload sempre envia documentType = "CUIL_CUIT"', async ({ page }) => {
        await capturePut(page, '/api/workers/me/general-info');
        await fillGeneralInfoForm(page);
        const body = await triggerGeneralInfoSave(page);
        expect(body?.documentType).toBe('CUIL_CUIT');
      });

      test('payload tem termsAccepted e privacyAccepted = true', async ({ page }) => {
        await capturePut(page, '/api/workers/me/general-info');
        await fillGeneralInfoForm(page);
        const body = await triggerGeneralInfoSave(page);
        expect(body?.termsAccepted).toBe(true);
        expect(body?.privacyAccepted).toBe(true);
      });

      test('payload tem languages como array com "es"', async ({ page }) => {
        await capturePut(page, '/api/workers/me/general-info');
        await fillGeneralInfoForm(page);
        const body = await triggerGeneralInfoSave(page);
        expect(Array.isArray(body?.languages)).toBe(true);
        expect((body?.languages as string[]).includes('es')).toBe(true);
      });

      test('toast de sucesso desaparece após ~3 segundos', async ({ page }) => {
        await capturePut(page, '/api/workers/me/general-info');
        await fillGeneralInfoForm(page);
        await triggerGeneralInfoSave(page);
        await expectSaveToast(page);
        await expect(page.getByTestId('toast-success')).toBeHidden({ timeout: 6_000 });
      });
    });

    // ── Autosave — Erros ─────────────────────────────────────
    test.describe('Autosave — erros', () => {

      test('API retorna 500 → toast de erro', async ({ page }) => {
        await capturePut(page, '/api/workers/me/general-info', 500);
        await fillGeneralInfoForm(page);
        await page.locator('#fullName').click();
        await page.locator('#fullName').blur();
        await expect(page.getByTestId('toast-error')).toBeVisible({ timeout: 6_000 });
      });
    });
  });

  // ══════════════════════════════════════════════════════════
  // ABA 2 — DIRECCIÓN DE ATENCIÓN
  // ══════════════════════════════════════════════════════════

  test.describe('Aba 2 — Dirección de Atención', () => {

    test.beforeEach(async ({ page }) => {
      await page.getByRole('button', { name: 'Dirección de Atención' }).click();
      await page.waitForTimeout(300);
    });

    test.describe('Labels em espanhol', () => {

      test('rótulo do complemento é "Complemento de la dirección"', async ({ page }) => {
        await expect(page.getByText('Complemento de la dirección')).toBeVisible();
      });

      test('rótulo do raio de atendimento em espanhol', async ({ page }) => {
        await expect(page.getByText('¿A cuántos km está dispuesto a atender?')).toBeVisible();
      });

      test('label do checkbox em espanhol', async ({ page }) => {
        await expect(page.getByText('Acepto realizar atenciones remotas/online')).toBeVisible();
      });
    });

    test.describe('Validação visual — mapa de área de atendimento', () => {

      test('sem endereço selecionado → exibe placeholder do mapa', async ({ page }) => {
        await expect(page.getByTestId('service-area-map-placeholder')).toBeVisible();
        await expect(page.getByTestId('service-area-map')).toHaveCount(0);
      });

      test('endereço pré-salvo → mapa real visível no lugar do placeholder', async ({ page }) => {
        await page.route('**/api/workers/me', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: {
                  serviceAddress: 'Av. Corrientes 1234, Buenos Aires',
                  serviceRadiusKm: 10, serviceLat: -34.6037, serviceLng: -58.3816,
                },
              }),
            });
          } else {
            await route.continue();
          }
        });

        await page.goto('/worker/profile');
        await page.getByRole('button', { name: 'Dirección de Atención' }).click();
        await page.waitForTimeout(800);

        await expect(page.getByTestId('service-area-map-placeholder')).toHaveCount(0);
        await expect(page.getByTestId('service-area-map')).toBeVisible({ timeout: 3_000 });
      });
    });

    test.describe('Campo de raio de atendimento', () => {

      test('valor padrão do raio é 10 km', async ({ page }) => {
        await expect(page.locator('#serviceRadius')).toHaveValue('10');
      });

      test('alterar raio para 20 reflete no input', async ({ page }) => {
        const input = page.locator('#serviceRadius');
        await input.fill('20');
        await input.blur();
        await expect(input).toHaveValue('20');
      });

      test('checkbox de atendimento remoto visível e desmarcado por padrão', async ({ page }) => {
        const checkbox = page.locator('#acceptsRemoteService');
        await expect(checkbox).toBeVisible();
        await expect(checkbox).not.toBeChecked();
      });

      test('marcar checkbox de atendimento remoto dispara autosave (toast)', async ({ page }) => {
        await capturePut(page, '/api/workers/me/service-area');
        await page.locator('#acceptsRemoteService').check();
        await expect(page.locator('#acceptsRemoteService')).toBeChecked();
        await expectSaveToast(page);
      });
    });

    test.describe('Integração com API', () => {

      test('endereço pré-salvo via getProgress preenche raio correto', async ({ page }) => {
        await page.route('**/api/workers/me', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: {
                  serviceAddress: 'Av. Santa Fe 1234, Buenos Aires',
                  serviceAddressComplement: 'Piso 3', serviceRadiusKm: 20,
                },
              }),
            });
          } else {
            await route.continue();
          }
        });
        await page.goto('/worker/profile');
        await page.getByRole('button', { name: 'Dirección de Atención' }).click();
        await page.waitForTimeout(800);
        await expect(page.locator('#serviceRadius')).toHaveValue('20');
      });

      test('autosave com endereço pré-salvo → PUT com payload correto', async ({ page }) => {
        await page.route('**/api/workers/me', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: { serviceAddress: 'Av. Santa Fe 1234, Buenos Aires', serviceRadiusKm: 10 },
              }),
            });
          } else {
            await route.continue();
          }
        });
        const { getBody } = await capturePut(page, '/api/workers/me/service-area');

        await page.goto('/worker/profile');
        await page.getByRole('button', { name: 'Dirección de Atención' }).click();
        await page.waitForTimeout(800);

        // Muda o raio para disparar o autosave
        await page.locator('#acceptsRemoteService').check();
        await expectSaveToast(page);

        const body = getBody();
        expect(body).not.toBeNull();
        expect(body?.serviceRadiusKm).toBeDefined();
        expect(body?.address).toBeTruthy();
      });

      test('API retorna 500 → toast de erro', async ({ page }) => {
        await page.route('**/api/workers/me', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ success: true, data: { serviceAddress: 'Rua Teste, 123', serviceRadiusKm: 10 } }),
            });
          } else {
            await route.continue();
          }
        });
        await capturePut(page, '/api/workers/me/service-area', 500);

        await page.goto('/worker/profile');
        await page.getByRole('button', { name: 'Dirección de Atención' }).click();
        await page.waitForTimeout(800);
        await page.locator('#acceptsRemoteService').check();
        await expect(page.getByTestId('toast-error')).toBeVisible({ timeout: 6_000 });
      });
    });
  });

  // ══════════════════════════════════════════════════════════
  // ABA 3 — DISPONIBILIDAD
  // ══════════════════════════════════════════════════════════

  test.describe('Aba 3 — Disponibilidad', () => {

    test.beforeEach(async ({ page }) => {
      await page.getByRole('button', { name: 'Disponibilidad' }).click();
      await page.waitForTimeout(300);
    });

    test.describe('Estrutura — 7 dias em espanhol', () => {
      const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
      for (const dia of DIAS) {
        test(`exibe ${dia}`, async ({ page }) => {
          await expect(page.getByText(dia, { exact: true })).toBeVisible();
        });
      }
    });

    test.describe('Interações — adicionar e remover horários', () => {

      test('clicar em + no Lunes adiciona slot com TimeSelect 09:00-17:00', async ({ page }) => {
        await page.getByTestId('day-schedule-add-monday').click();
        const selects = timeSelects(page, 'monday');
        await expect(selects.nth(0)).toContainText('09:00');
        await expect(selects.nth(1)).toContainText('17:00');
      });

      test('pode editar horário de início do slot via TimeSelect', async ({ page }) => {
        await page.getByTestId('day-schedule-add-tuesday').click();
        await setSlotTime(page, 'tuesday', 0, '08:00');
        await expect(timeSelects(page, 'tuesday').nth(0)).toContainText('08:00');
      });

      test('TimeSelect oferece granularidade de 5 min (08:05 disponível)', async ({ page }) => {
        await page.getByTestId('day-schedule-add-wednesday').click();
        await timeSelects(page, 'wednesday').nth(0).click();
        await expect(page.locator('li button', { hasText: /^08:05$/ })).toBeVisible();
      });

      test('clicar em × remove o slot adicionado', async ({ page }) => {
        await page.getByTestId('day-schedule-add-thursday').click();
        await expect(timeSelects(page, 'thursday')).toHaveCount(2);
        await page.getByTestId('day-schedule-remove-thursday-0').click();
        await expect(timeSelects(page, 'thursday')).toHaveCount(0);
      });

      test('pode adicionar múltiplos slots ao mesmo dia', async ({ page }) => {
        await page.getByTestId('day-schedule-add-friday').click();
        await page.getByTestId('day-schedule-add-friday').click();
        await page.getByTestId('day-schedule-add-friday').click();
        await expect(timeSelects(page, 'friday')).toHaveCount(6); // 3 slots × 2 selects
      });
    });

    test.describe('Integração com API (autosave)', () => {

      test('adicionar Lunes 09:00-17:00 → PUT com dayOfWeek=1', async ({ page }) => {
        const { getBody } = await capturePut(page, '/api/workers/me/availability');
        await page.getByTestId('day-schedule-add-monday').click();
        await expectSaveToast(page);

        const body = getBody();
        expect(body).not.toBeNull();
        const availability = body?.availability as Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
        const monday = availability.find((s) => s.dayOfWeek === 1);
        expect(monday).toBeDefined();
        expect(monday?.startTime).toBe('09:00');
        expect(monday?.endTime).toBe('17:00');
      });

      test('adicionar Viernes e Sábado → payload tem dayOfWeek 5 e 6', async ({ page }) => {
        const { getBody } = await capturePut(page, '/api/workers/me/availability');
        await page.getByTestId('day-schedule-add-friday').click();
        await page.getByTestId('day-schedule-add-saturday').click();
        await expectSaveToast(page);

        const availability = getBody()?.availability as Array<{ dayOfWeek: number }>;
        expect(availability.some((s) => s.dayOfWeek === 5)).toBe(true);
        expect(availability.some((s) => s.dayOfWeek === 6)).toBe(true);
      });

      test('API retorna 500 → toast de erro', async ({ page }) => {
        await capturePut(page, '/api/workers/me/availability', 500);
        await page.getByTestId('day-schedule-add-monday').click();
        await expect(page.getByTestId('toast-error')).toBeVisible({ timeout: 6_000 });
      });

      test('disponibilidade pré-existente é carregada via getProgress', async ({ page }) => {
        await page.route('**/api/workers/me', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                success: true,
                data: {
                  availability: [
                    { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
                    { dayOfWeek: 3, startTime: '14:00', endTime: '20:00' },
                  ],
                },
              }),
            });
          } else {
            await route.continue();
          }
        });

        await page.goto('/worker/profile');
        await page.getByRole('button', { name: 'Disponibilidad' }).click();
        await page.waitForTimeout(1_000);

        await expect(timeSelects(page, 'monday')).toHaveCount(2, { timeout: 3_000 });
        await expect(timeSelects(page, 'wednesday')).toHaveCount(2);
      });
    });
  });

  // ══════════════════════════════════════════════════════════
  // ABA 4 — DOCUMENTOS
  // ══════════════════════════════════════════════════════════

  test.describe('Aba 4 — Documentos', () => {

    test.beforeEach(async ({ page }) => {
      await page.route('**/api/workers/me/documents', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ success: true, data: [] }),
          });
        } else {
          await route.continue();
        }
      });
      await page.getByRole('button', { name: 'Documentos' }).click();
      await page.waitForTimeout(500);
    });

    test.describe('Cards de documentos em espanhol', () => {

      test('exibe card de currículo (CV)', async ({ page }) => {
        await expect(page.getByText(/currículum/i)).toBeVisible();
      });

      test('exibe card de documento de identidade (DNI)', async ({ page }) => {
        await expect(page.getByText(/DNI/i).first()).toBeVisible();
      });

      test('exibe card de antecedentes penais', async ({ page }) => {
        await expect(page.getByText(/antecedentes penales/i)).toBeVisible();
      });
    });

    test.describe('Input de arquivo — restrição a PDF', () => {

      test('inputs de upload aceitam apenas PDF (accept contém "pdf")', async ({ page }) => {
        const fileInputs = page.locator('input[type="file"]');
        const count = await fileInputs.count();
        for (let i = 0; i < count; i++) {
          const accept = await fileInputs.nth(i).getAttribute('accept');
          expect(accept?.toLowerCase()).toContain('pdf');
        }
        await expect(page.locator('body')).not.toBeEmpty();
      });
    });

    test.describe('Estado de erro da API de documentos', () => {

      test('GET /documents 500 → exibe mensagem de erro', async ({ page }) => {
        await page.route('**/api/workers/me/documents', async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({
              status: 500, contentType: 'application/json',
              body: JSON.stringify({ success: false, error: 'Failed to load documents' }),
            });
          } else {
            await route.continue();
          }
        });
        await page.getByRole('button', { name: 'Información General' }).click();
        await page.waitForTimeout(100);
        await page.getByRole('button', { name: 'Documentos' }).click();
        await page.waitForTimeout(1_000);

        await expect(
          page.locator('p[class*="text-red"], div[class*="text-red"], div[class*="bg-red"]').first(),
        ).toBeVisible({ timeout: 5_000 });
      });
    });
  });

  // ══════════════════════════════════════════════════════════
  // FLUXO PONTA A PONTA — persistência real (escreve em PROD!)
  // Só roda com E2E_REAL_API=1 — o dev server (5173) aponta para
  // produção, então este bloco grava dados reais do worker.
  // ══════════════════════════════════════════════════════════

  test.describe('Fluxo E2E ponta a ponta — persistência real', () => {
    test.skip(!process.env.E2E_REAL_API, 'Define E2E_REAL_API=1 para rodar (grava em produção).');

    test.beforeEach(async ({ page }) => {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.goto('/worker/profile');
      await page.waitForSelector('nav[aria-label="Tabs"]', { timeout: 10_000 });
      await page.waitForTimeout(1_000);
    });

    test('autosave de Información General persiste após reload', async ({ page }) => {
      const uniqueLicense = `Técnico E2E ${Date.now()}`;

      await fillGeneralInfoForm(page);
      await page.locator('#professionalLicense').fill(uniqueLicense);
      await page.locator('#fullName').click();
      await page.locator('#fullName').blur();
      await expectSaveToast(page);

      await page.goto('/worker/profile');
      await page.waitForSelector('nav[aria-label="Tabs"]', { timeout: 10_000 });
      await page.waitForTimeout(2_000);

      await expect(page.locator('#professionalLicense')).toHaveValue(uniqueLicense, { timeout: 5_000 });
      await expect(page.locator('#lastName')).toHaveValue('Marquez');
    });
  });
});
