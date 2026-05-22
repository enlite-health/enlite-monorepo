/**
 * patient-clickup-sync-visual.integration.e2e.ts @integration
 *
 * Visual E2E — cadeia completa ponta a ponta:
 *   Payload ClickUp → POST /api/webhooks/clickup/patient (HMAC-SHA256)
 *     → ClickUpPatientWebhookController (NODE_ENV=test: usa _injectedTask, pula fetchTask)
 *       → SyncPatientFromClickUpTaskUseCase (síncrono)
 *         → PatientService.upsertFromClickUp
 *           → patients + patient_health_insurance + patient_addresses (Postgres real)
 *             → GET /admin/patients/:id
 *               → Screenshots: PatientIdentityCard, CoberturaMedicaCard, LocalizacoesCard
 *
 * Decisões sobre dropdowns:
 *   O ClickUpFieldResolver é inicializado com maps vazios (NODE_ENV=test + token fake
 *   → HTTP 401 → fallback para resolver vazio). Campos como sexo, tipo de documento e
 *   dependência resolvem para null — aceito e documentado aqui. Apenas campos texto e
 *   location são verificados: nome, cobertura (providerName/memberId), endereço.
 *
 * Decisão arquitetural — fill-only (Spec 3):
 *   PatientHealthInsuranceRepository usa COALESCE: se provider_name já existe, um
 *   segundo sync com valor diferente NÃO sobrescreve. Spec 3 prova essa garantia.
 *
 * Pré-condições (ver CLAUDE.md):
 *   docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres api
 *   cd enlite-frontend && pnpm dev
 */

import { test, expect } from '@playwright/test';
import {
  buildPatientWebhookPayload,
  postClickUpPatientWebhook,
  CLICKUP_WEBHOOK_SECRET,
  type PatientWebhookFields,
} from '../helpers/clickupWebhookHelper';
import {
  getPatientHealthInsurance,
  getPatientAddressRows,
  cleanupTestPatientFull,
} from '../helpers/db-patient-clickup-helper';
import {
  loginAsAdmin,
  triggerWebhookAndWait,
  makeTaskId,
} from './patient-clickup-sync-visual.helpers';

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:8080';

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('ClickUp sync → patient detail visual @integration', () => {
  test.setTimeout(120_000);

  let patientId: string = '';

  test.afterEach(() => {
    if (patientId) {
      cleanupTestPatientFull(patientId);
      patientId = '';
    }
  });

  // ── Spec 1: sync inicial cria paciente e renderiza os 3 cards ──────────────

  test('Spec 1: sync inicial cria paciente e renderiza dados nos 3 cards', async ({ page, request }) => {
    const taskId = makeTaskId();
    const fields: PatientWebhookFields = {
      clickupTaskId: taskId,
      firstName:     'Ana María',
      lastName:      'García',
      phone:         '+541112345678',
      providerName:  'OSDE',
      memberId:      'OS-987654',
      address: {
        formatted_address: 'Av. Corrientes 1234, Buenos Aires, Argentina',
        lat: -34.6037,
        lng: -58.3816,
      },
      province:     { formatted_address: 'Buenos Aires' },
      neighborhood: 'Microcentro',
      caseNumber:   '9999',
      statusLabel:  'activo',
    };

    // 1. Dispara webhook e aguarda patient_id no DB
    patientId = await triggerWebhookAndWait(request, fields);

    // 2. Valida health insurance no DB
    const insurance = getPatientHealthInsurance(patientId);
    expect(insurance?.provider_name, 'provider_name deve ser OSDE').toBe('OSDE');
    expect(insurance?.member_id,     'member_id deve ser OS-987654').toBe('OS-987654');
    expect(insurance?.source,        'source deve ser clickup').toBe('clickup');

    // 3. Valida endereço primário no DB
    const addresses = getPatientAddressRows(patientId);
    expect(addresses.length, 'Deve existir ao menos 1 endereço').toBeGreaterThan(0);
    expect(addresses[0].address_formatted, 'Endereço deve conter "Corrientes"').toContain('Corrientes');

    // 4. Navega para tela de detalhe e abre tab "Servicio Contratado"
    // (CoberturaMedicaCard e LocalizacoesCard ficam nessa tab, não na tab padrão)
    await loginAsAdmin(page);
    await page.goto(`/admin/patients/${patientId}`);

    // Aguarda patient-identity-card (sempre visível, independente de tab)
    await page.waitForSelector('[data-testid="patient-identity-card"]', { timeout: 15_000 });

    // Clica na tab "Servicio Contratado" para revelar CoberturaMedicaCard e LocalizacoesCard
    await page.getByRole('button', { name: /Servicio Contratado/i }).click();

    await page.waitForSelector('[data-testid="cobertura-medica-card"]', { timeout: 10_000 });
    await page.waitForSelector('[data-testid="localizacoes-card"]',      { timeout: 10_000 });

    const coberturaCard    = page.getByTestId('cobertura-medica-card');
    const localizacoesCard = page.getByTestId('localizacoes-card');
    const identityCard     = page.getByTestId('patient-identity-card');

    // 5. Assertions textuais (mensagens claras antes dos screenshots)
    await expect(coberturaCard,    'Cobertura deve mostrar OSDE').toContainText('OSDE');
    await expect(coberturaCard,    'Cobertura deve mostrar afiliado').toContainText('OS-987654');
    await expect(localizacoesCard, 'Localizações deve mostrar endereço').toContainText('Corrientes');
    await expect(identityCard,     'Identity deve mostrar nome').toContainText('Ana');

    // 6. Screenshots visuais — baselines gerados na primeira execução
    await expect(identityCard).toHaveScreenshot(
      'clickup-sync-identity-card.png',
      { maxDiffPixelRatio: 0.05 },
    );
    await expect(coberturaCard).toHaveScreenshot(
      'clickup-sync-cobertura-medica.png',
      { maxDiffPixelRatio: 0.05 },
    );
    await expect(localizacoesCard).toHaveScreenshot(
      'clickup-sync-localizacoes.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });

  // ── Spec 2: re-sync com nome alterado atualiza tela ──────────────────────────

  test('Spec 2: re-sync com nome alterado atualiza tela', async ({ page, request }) => {
    const taskId = makeTaskId();
    const baseFields: PatientWebhookFields = {
      clickupTaskId: taskId,
      firstName:     'Ana María',
      lastName:      'García',
      providerName:  'OMINT',
      memberId:      'OM-111222',
      caseNumber:    '8888',
      statusLabel:   'activo',
    };

    // 1. Sync inicial
    patientId = await triggerWebhookAndWait(request, baseFields);

    // 2. Re-sync com firstName alterado (mesmo clickup_task_id → UPDATED)
    const updatedFields: PatientWebhookFields = {
      ...baseFields,
      firstName: 'Ana Maria de la Cruz',
    };
    const updatedPayload = buildPatientWebhookPayload(updatedFields, 'taskUpdated');
    const { status } = await postClickUpPatientWebhook(request, updatedPayload, CLICKUP_WEBHOOK_SECRET);
    expect(status, 'Re-sync deve retornar 200').toBe(200);

    // Breve espera para o upsert UPDATED propagar
    await new Promise((r) => setTimeout(r, 800));

    // 3. Navega e verifica nome atualizado na tela
    await loginAsAdmin(page);
    await page.goto(`/admin/patients/${patientId}`);
    await page.waitForSelector('[data-testid="patient-identity-card"]', { timeout: 15_000 });

    const identityCard = page.getByTestId('patient-identity-card');
    await expect(identityCard, 'Identity deve mostrar nome atualizado').toContainText('Ana Maria de la Cruz');

    // 4. Screenshot 4
    await expect(identityCard).toHaveScreenshot(
      'clickup-sync-identity-card-updated.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });

  // ── Spec 3: re-sync não sobrescreve cobertura (fill-only) ───────────────────

  test('Spec 3: re-sync não sobrescreve cobertura já preenchida (fill-only)', async ({ page, request }) => {
    /**
     * Invariante arquitetural: PatientHealthInsuranceRepository usa COALESCE.
     * Se provider_name já existe, segundo sync com valor diferente NÃO sobrescreve.
     */
    const taskId = makeTaskId();
    const firstFields: PatientWebhookFields = {
      clickupTaskId: taskId,
      firstName:     'Valentina',
      lastName:      'Rosas',
      providerName:  'OSDE',
      memberId:      'OS-FILL-001',
      caseNumber:    '7777',
      statusLabel:   'activo',
    };

    // 1. Sync inicial com OSDE
    patientId = await triggerWebhookAndWait(request, firstFields);

    const firstInsurance = getPatientHealthInsurance(patientId);
    expect(firstInsurance?.provider_name, 'provider_name inicial deve ser OSDE').toBe('OSDE');

    // 2. Re-sync com providerName='Galeno'
    const secondFields: PatientWebhookFields = { ...firstFields, providerName: 'Galeno' };
    const secondPayload = buildPatientWebhookPayload(secondFields, 'taskUpdated');
    await postClickUpPatientWebhook(request, secondPayload, CLICKUP_WEBHOOK_SECRET);
    await new Promise((r) => setTimeout(r, 800));

    // 3. Valida fill-only no DB: deve continuar OSDE
    const afterInsurance = getPatientHealthInsurance(patientId);
    expect(
      afterInsurance?.provider_name,
      'provider_name deve continuar OSDE (fill-only)',
    ).toBe('OSDE');

    // 4. Navega, abre tab "Servicio Contratado" e prova que a tela mostra OSDE
    await loginAsAdmin(page);
    await page.goto(`/admin/patients/${patientId}`);
    await page.waitForSelector('[data-testid="patient-identity-card"]', { timeout: 15_000 });
    await page.getByRole('button', { name: /Servicio Contratado/i }).click();
    await page.waitForSelector('[data-testid="cobertura-medica-card"]', { timeout: 10_000 });

    const coberturaCard = page.getByTestId('cobertura-medica-card');
    await expect(coberturaCard, 'Tela deve mostrar OSDE (fill-only preservado)').toContainText('OSDE');

    // 5. Screenshot — prova arquitetural de fill-only
    await expect(coberturaCard).toHaveScreenshot(
      'clickup-sync-fillonly-cobertura-preserved.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });
});

// ── Backend health checks ─────────────────────────────────────────────────────

test.describe('Backend + rota ClickUp webhook @integration', () => {
  test.setTimeout(10_000);

  test('backend responde /health', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/health`);
    expect(res.ok()).toBe(true);
  });

  test('rota ClickUp webhook está montada (401 sem X-Signature, não 404)', async ({ request }) => {
    // 404 = rota não montada (CLICKUP_WEBHOOK_SECRET ausente)
    // 401 = rota montada, HMAC ausente — confirma que o route está registrado
    const res = await request.post(`${BACKEND_URL}/api/webhooks/clickup/patient`, {
      headers: { 'Content-Type': 'application/json' },
      data:    { event: 'taskCreated', webhook_id: 'probe', task_id: 'probe' },
    });
    expect(res.status(), 'Rota deve estar montada (401, não 404)').not.toBe(404);
    expect(res.status()).toBe(401);
  });
});
