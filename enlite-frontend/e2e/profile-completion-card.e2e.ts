/**
 * profile-completion-card.e2e.ts
 *
 * Testes E2E visuais para a lista de tarefas da home (`PendingTasksCard`).
 * Verifica que TODOS os itens estão presentes e visíveis na tela,
 * tanto no desktop (1280×800) quanto no mobile (390×844).
 *
 * Fase 2 de postulacao-documento-pendente (DD1/DD2): `ProfileCompletionCard`
 * (barra de progresso + 1 CTA pro primeiro pendente) saiu da home e virou
 * `PendingTasksCard` (uma linha nomeada por pendência, `missingFields` do
 * servidor). O mock de `GET /api/workers/me` agora leva `missingFields`
 * pronto — a Fase 1 já garante que cada `doc_*` vem específico, então este
 * teste não recalcula nada, só finge a resposta do servidor.
 *
 * API mockada via page.route() — não requer Docker stack.
 * Usa o storageState de autenticação gerado pelo auth.setup.ts.
 *
 * Cenário (BLOCKER 1e do gate 11/09 — fixture "realista"): worker sem NADA
 * preenchido, com VÁRIOS tokens crus na MESMA aba (general leva 3: phone,
 * first_name, profession — todos colapsam em 1 linha só, provando que a
 * fixture não é "1 token = 1 linha" por acaso) e profissão ausente (NULL) —
 * que pela paridade com o portão SQL (`workerDocumentPolicy.requiredDocTypesFor`,
 * NULL tratado como AT) exige os 4 documentos, não só os 2 de Cuidador.
 */

import { test, expect, Page } from '@playwright/test';

// Worker auth — gerado pelo auth.setup.ts (REST no Firebase Emulator)
test.use({ storageState: 'e2e/.auth/profile-worker.json' });

// ── Labels exatos conforme es.json ──────────────────────────────────────────

const CARD_TITLE = 'Te faltan 7 pasos para postularte';
const PROGRESS_TEXT = 'Ya completaste 0 de 7';
const REGISTRATION_ROW_LABELS = ['Información General', 'Dirección de Atención', 'Disponibilidad'] as const;
const DOC_ROW_LABELS = [
  'Documento de identidad',
  'Antecedentes penales',
  'Currículum vitae',
  'Certificado de Acompañante Terapéutico',
] as const;
const BTN_COMPLETAR = 'Completar';
const BTN_SUBIR = 'Subir ahora';

// ── Mocks de API ─────────────────────────────────────────────────────────────

/**
 * Worker com cadastro TOTALMENTE vazio — VÁRIOS tokens crus por aba de
 * registro (3 em general, 1 em address, 1 em availability — todos colapsam
 * em 3 linhas, uma por aba) e os 4 documentos obrigatórios (profession
 * ausente → NULL → paridade com o portão SQL trata como AT, F5/DD2).
 * `missingFields` é exatamente o que `GET /api/workers/me` devolveria
 * (Fase 1): sem token agregado `worker_documents`, cada `doc_*` já vem
 * específico.
 */
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
  // profession não definida (NULL) → política do frontend trata como AT (paridade com o portão) → 4 docs, não 2
  missingFields: [
    'phone',
    'first_name',
    'profession',
    'worker_service_areas',
    'worker_availability',
    'doc_identity_document',
    'doc_criminal_record',
    'doc_resume_cv',
    'doc_at_certificate',
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function mockApis(page: Page): Promise<void> {
  // Mock GET /api/workers/me — retorna worker com cadastro vazio + missingFields do servidor
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
}

async function navigateToHome(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

async function assertCardVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('pending-tasks-card')).toBeVisible();
}

async function assertTitleAndProgress(page: Page): Promise<void> {
  await expect(page.getByText(CARD_TITLE)).toBeVisible();
  await expect(page.getByTestId('pending-tasks-progress')).toContainText(PROGRESS_TEXT);
}

async function assertRegistrationRowsVisible(page: Page): Promise<void> {
  for (const label of REGISTRATION_ROW_LABELS) {
    await expect(page.getByText(label)).toBeVisible();
  }
}

async function assertDocumentRowsVisible(page: Page): Promise<void> {
  for (const label of DOC_ROW_LABELS) {
    await expect(page.getByText(label)).toBeVisible();
  }
}

async function assertActionButtons(page: Page): Promise<void> {
  // 3 linhas de registro com "Completar", 4 de documento com "Subir ahora".
  await expect(page.getByRole('button', { name: BTN_COMPLETAR }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: BTN_SUBIR }).first()).toBeVisible();
}

async function assertAllItemsVisible(page: Page): Promise<void> {
  await assertCardVisible(page);
  await assertTitleAndProgress(page);
  await assertRegistrationRowsVisible(page);
  await assertDocumentRowsVisible(page);
  await assertActionButtons(page);
}

// ── Testes ───────────────────────────────────────────────────────────────────

test.describe('PendingTasksCard — presença visual (Fase 2, DD2)', () => {
  test.describe('desktop (1280×800)', () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await mockApis(page);
      await navigateToHome(page);
    });

    test('card principal está visível', async ({ page }) => {
      await assertCardVisible(page);
    });

    test('título ("Te faltan 7 pasos") e progresso ("Ya completaste 0 de 7") estão visíveis', async ({ page }) => {
      await assertTitleAndProgress(page);
    });

    test('as 3 linhas de registro estão visíveis (uma por aba: general/address/availability)', async ({ page }) => {
      await assertRegistrationRowsVisible(page);
    });

    // Profissão ausente (NULL) → paridade com o portão SQL trata como AT
    // (workerDocumentPolicy.requiredDocTypesFor): DNI + antecedentes + CV +
    // certificado AT — os 4, não só os 2 de Cuidador.
    test('as 4 linhas de documento estão visíveis — profissão NULL tratada como AT (paridade com o portão)', async ({ page }) => {
      await assertDocumentRowsVisible(page);
    });

    test('botões "Completar" (registro) e "Subir ahora" (documento) estão visíveis', async ({ page }) => {
      await assertActionButtons(page);
    });

    test('sem linha de recolhidos — nada foi completado ainda', async ({ page }) => {
      await expect(page.getByTestId('pending-tasks-completed')).toHaveCount(0);
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

    test('título e progresso estão visíveis', async ({ page }) => {
      await assertTitleAndProgress(page);
    });

    test('as 3 linhas de registro estão visíveis', async ({ page }) => {
      await assertRegistrationRowsVisible(page);
    });

    test('as 4 linhas de documento estão visíveis — profissão NULL tratada como AT (paridade com o portão)', async ({ page }) => {
      await assertDocumentRowsVisible(page);
    });

    test('botões de ação estão visíveis — scroll se necessário', async ({ page }) => {
      await assertActionButtons(page);
    });

    test('todos os itens visíveis — snapshot completo', async ({ page }) => {
      await assertAllItemsVisible(page);
    });
  });
});
