/**
 * profile-completion-card.e2e.ts
 *
 * Testes E2E visuais para o ProfileCompletionCard.
 * Verifica que TODOS os itens estão presentes e visíveis na tela,
 * tanto no desktop (1280×800) quanto no mobile (390×844).
 *
 * API mockada via page.route() — não requer Docker stack.
 * Usa o storageState de autenticação gerado pelo auth.setup.ts.
 *
 * Cenário: worker sem profissão definida (tratado como CUIDADOR).
 * Docs obrigatórios para CUIDADOR: identity_document, identity_document_back, criminal_record.
 * Seção documentos: (0/3) — NÃO inclui AFIP nem seguro de responsabilidade civil.
 */

import { test, expect, Page } from '@playwright/test';

// Worker auth — gerado pelo auth.setup.ts (REST no Firebase Emulator)
test.use({ storageState: 'e2e/.auth/profile-worker.json' });

// ── Labels exatos conforme es.json ──────────────────────────────────────────

const CARD_TITLE         = 'Complete su Perfil Profesional';
const SECTION_REGISTRO   = 'Registro Básico';
const SECTION_DOCUMENTOS = 'Documentos Profesionales';

// Worker sem profissão = CUIDADOR → 3 docs obrigatórios.
// Labels via t('documentTypes.<slug>') conforme es.json.
const DOC_STEP_LABELS = [
  'DNI - Frente',
  'DNI - Dorso',
  'Antecedentes penales',
] as const;

const BTN_COMPLETAR = 'Completar Registro';

// ── Mocks de API ─────────────────────────────────────────────────────────────

/** Worker com perfil vazio e sem profissão — cai no caminho CUIDADOR */
const EMPTY_WORKER_MOCK = {
  id: 'test-worker-id',
  authUid: 'test-uid',
  email: 'test@enlite-test.com',
  currentStep: 1,
  status: 'pending',
  registrationCompleted: false,
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  // profession não definida → classifyProfession → CUIDADOR
};

/** Documentos vazios — todos os campos null */
const EMPTY_DOCUMENTS_MOCK = {
  id: 'test-docs-id',
  workerId: 'test-worker-id',
  resumeCvUrl: null,
  identityDocumentUrl: null,
  identityDocumentBackUrl: null,
  criminalRecordUrl: null,
  professionalRegistrationUrl: null,
  liabilityInsuranceUrl: null,
  monotributoCertificateUrl: null,
  atCertificateUrl: null,
  aptoPsicofisicoUrl: null,
  analiticoUniversitarioUrl: null,
  cartaRecomendacionUrl: null,
  documentsStatus: 'pending',
  submittedAt: null,
  updatedAt: new Date().toISOString(),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function mockApis(page: Page): Promise<void> {
  // Mock GET /api/workers/me — retorna worker com perfil vazio (sem profissão)
  await page.route('**/api/workers/me', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: EMPTY_WORKER_MOCK }),
    });
  });

  // Mock GET /api/workers/me/documents — retorna sem documentos
  await page.route('**/api/workers/me/documents', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: EMPTY_DOCUMENTS_MOCK }),
    });
  });
}

async function navigateToHome(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

async function assertCardVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('profile-completion-card')).toBeVisible();
}

async function assertTitleAndPercentage(page: Page): Promise<void> {
  await expect(page.getByTestId('profile-completion-title')).toContainText(CARD_TITLE);
  await expect(page.getByTestId('overall-percentage')).toContainText('0%');
}

async function assertSectionsVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('section-registration')).toBeVisible();
  await expect(page.getByText(SECTION_REGISTRO)).toBeVisible();

  await expect(page.getByTestId('section-documents')).toBeVisible();
  await expect(page.getByText(SECTION_DOCUMENTOS)).toBeVisible();
}

async function assertDocumentStepsVisible(page: Page): Promise<void> {
  for (const label of DOC_STEP_LABELS) {
    await expect(page.getByText(label)).toBeVisible();
  }
}

async function assertActionButton(page: Page): Promise<void> {
  await expect(page.getByText(BTN_COMPLETAR)).toBeVisible();
}

async function assertAllItemsVisible(page: Page): Promise<void> {
  await assertCardVisible(page);
  await assertTitleAndPercentage(page);
  await assertSectionsVisible(page);
  await assertDocumentStepsVisible(page);
  await assertActionButton(page);
}

// ── Testes ───────────────────────────────────────────────────────────────────

test.describe('ProfileCompletionCard — presença visual', () => {
  test.describe('desktop (1280×800)', () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await mockApis(page);
      await navigateToHome(page);
    });

    test('card principal está visível', async ({ page }) => {
      await assertCardVisible(page);
    });

    test('título e percentual geral estão visíveis', async ({ page }) => {
      await assertTitleAndPercentage(page);
    });

    test('seção Registro Básico (0/3) está visível', async ({ page }) => {
      await expect(page.getByTestId('section-registration')).toBeVisible();
      await expect(page.getByText(SECTION_REGISTRO)).toBeVisible();
      await expect(page.getByText('(0/3)')).toBeVisible();
    });

    // CUIDADOR sem profissão → 3 docs obrigatórios (identity_document, identity_document_back, criminal_record)
    test('seção Documentos Profesionales (0/3) está visível — CUIDADOR sem profissão', async ({ page }) => {
      await expect(page.getByTestId('section-documents')).toBeVisible();
      await expect(page.getByText(SECTION_DOCUMENTOS)).toBeVisible();
      // (0/3) ocorre duas vezes na tela (Registro Básico e Documentos)
      await expect(page.getByText('(0/3)').first()).toBeVisible();
    });

    test('steps de Registro Básico estão visíveis', async ({ page }) => {
      await expect(page.getByText('Información General')).toBeVisible();
      await expect(page.getByText('Dirección de Atención')).toBeVisible();
      await expect(page.getByText('Disponibilidad')).toBeVisible();
    });

    // CUIDADOR: identity_document, identity_document_back, criminal_record
    // NÃO incluir AFIP (professional_registration) nem seguro (liability_insurance)
    test('steps de Documentos Profesionales CUIDADOR estão visíveis', async ({ page }) => {
      await expect(page.getByText('DNI - Frente')).toBeVisible();
      await expect(page.getByText('DNI - Dorso')).toBeVisible();
      await expect(page.getByText('Antecedentes penales')).toBeVisible();
    });

    test('botão Completar Registro está visível', async ({ page }) => {
      await assertActionButton(page);
    });

    test('todos os itens visíveis — snapshot completo', async ({ page }) => {
      await assertAllItemsVisible(page);
    });
  });

  test.describe('mobile (390×844)', () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await mockApis(page);
      await navigateToHome(page);
    });

    test('card principal está visível', async ({ page }) => {
      await assertCardVisible(page);
    });

    test('título e percentual geral estão visíveis', async ({ page }) => {
      await assertTitleAndPercentage(page);
    });

    test('seção Registro Básico (0/3) está visível', async ({ page }) => {
      await expect(page.getByTestId('section-registration')).toBeVisible();
      await expect(page.getByText(SECTION_REGISTRO)).toBeVisible();
      await expect(page.getByText('(0/3)')).toBeVisible();
    });

    // CUIDADOR sem profissão → 3 docs obrigatórios
    test('seção Documentos Profesionales (0/3) está visível — CUIDADOR sem profissão', async ({ page }) => {
      await expect(page.getByTestId('section-documents')).toBeVisible();
      await expect(page.getByText(SECTION_DOCUMENTOS)).toBeVisible();
      await expect(page.getByText('(0/3)').first()).toBeVisible();
    });

    test('steps de Registro Básico estão visíveis', async ({ page }) => {
      await expect(page.getByText('Información General')).toBeVisible();
      await expect(page.getByText('Dirección de Atención')).toBeVisible();
      await expect(page.getByText('Disponibilidad')).toBeVisible();
    });

    // CUIDADOR: identity_document, identity_document_back, criminal_record — sem AFIP/seguro
    test('steps de Documentos Profesionales CUIDADOR estão visíveis — scroll se necessário', async ({ page }) => {
      await expect(page.getByText('DNI - Frente')).toBeVisible();
      await expect(page.getByText('DNI - Dorso')).toBeVisible();
      await expect(page.getByText('Antecedentes penales')).toBeVisible();
    });

    test('botão Completar Registro está visível', async ({ page }) => {
      await assertActionButton(page);
    });

    test('todos os itens visíveis — snapshot completo', async ({ page }) => {
      await assertAllItemsVisible(page);
    });
  });
});
