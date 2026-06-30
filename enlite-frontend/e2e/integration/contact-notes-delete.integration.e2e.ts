/**
 * contact-notes-delete.integration.e2e.ts @integration
 *
 * Visual + funcional, com DADOS REAIS (backend Docker + Postgres real), das
 * regras de exclusão de notas de contato:
 *
 *   1. Toda nota mostra o NOME do operador autor + o texto, visível pra qualquer
 *      operador que abra o modal.
 *   2. Só o AUTOR vê o botão de excluir, e só dentro de 2h da criação.
 *   3. Excluir a própria nota recente funciona end-to-end (DELETE real → some).
 *
 * Cenário semeado (3 notas na mesma WJA, ordem DESC por created_at):
 *   - Nota A: autor = operador logado, 5 min  → tem lixeira (own + <2h)
 *   - Nota B: autor = OUTRO operador,   10 min → sem lixeira (não é dono)
 *   - Nota C: autor = operador logado, 200 min → sem lixeira (>2h, permanente)
 *
 * Auth: mocka só o Firebase Identity Toolkit + /api/admin/auth/profile; todo o
 * resto de /api vai pro backend real (token trocado pelo mock_<base64>). Não
 * requer o Firebase Emulator.
 *
 * Pré-condições (ver enlite-frontend/CLAUDE.md → "Testes de integração"):
 *   - docker compose up postgres api  (worker-functions)
 *   - pnpm dev                        (enlite-frontend)
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertTestPatient,
  insertBaseVacancy,
  insertTestWorker,
  cleanupTestWorker,
  cleanupVacancies,
  cleanupTestPatient,
} from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import {
  insertContactNote,
  cleanupContactNotes,
} from '../helpers/contact-notes-test-helper';

// ── Identidade do operador logado ────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-contact-notes-op',
  email: 'op.contact-notes@e2e.test',
  role: 'admin',
};
const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN_USER), 'utf-8').toString('base64');
const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN_USER.uid,
      uid: MOCK_ADMIN_USER.uid,
      email: MOCK_ADMIN_USER.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

const OTHER_OP_UID = 'e2e-contact-notes-other-op';
const OPERATOR_NAME = 'Operadora Test';
const OTHER_OPERATOR_NAME = 'Carla Méndez';

// ── Auth interceptors (Firebase mockado, /api real) ──────────────────────────

async function installAuthInterceptors(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: MOCK_ADMIN_USER.uid,
          email: MOCK_ADMIN_USER.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh-token',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [
          { localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true },
        ],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
        id_token: FAKE_ID_TOKEN,
      }),
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    // Perfil mockado pra evitar lookup do operador no banco.
    if (url.includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: MOCK_ADMIN_USER.uid,
            email: MOCK_ADMIN_USER.email,
            role: 'superadmin',
            firstName: 'Op',
            lastName: 'ContactNotes',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    // Todo o resto vai pro backend REAL, trocando o token Firebase pelo mock.
    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installAuthInterceptors(page);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'es');
  });
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Fixtures (dados reais no banco) ───────────────────────────────────────────

let patientId: string;
let vacancyId: string;
let workerId: string;
let wjaId: string;

test.describe('Contact notes — delete rules (author + 2h) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    const patient = insertTestPatient({ withAddress: true, firstName: 'Caso', lastName: 'Notas' });
    patientId = patient.patientId;
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: patient.addressId as string,
      caseNumber: 97766,
      status: 'SEARCHING',
    });
    workerId = insertTestWorker({ status: 'REGISTERED', firstName: 'Juan', lastName: 'Pérez' });
    wjaId = insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'INVITED', source: 'manual' });

    // 3 notas com autoria/idade controladas.
    insertContactNote({
      wjaId,
      noteText: 'A — Llamé y confirmó disponibilidad para la entrevista.',
      createdByAdminId: MOCK_ADMIN_USER.uid,
      createdByAdminName: OPERATOR_NAME,
      createdByAdminEmail: MOCK_ADMIN_USER.email,
      ageMinutes: 5,
    });
    insertContactNote({
      wjaId,
      noteText: 'B — Nota de otra operadora, no debería ser borrable por mí.',
      createdByAdminId: OTHER_OP_UID,
      createdByAdminName: OTHER_OPERATOR_NAME,
      createdByAdminEmail: 'carla@e2e.test',
      ageMinutes: 10,
    });
    insertContactNote({
      wjaId,
      noteText: 'C — Nota mía pero vieja (más de 2h), ya es permanente.',
      createdByAdminId: MOCK_ADMIN_USER.uid,
      createdByAdminName: OPERATOR_NAME,
      createdByAdminEmail: MOCK_ADMIN_USER.email,
      ageMinutes: 200,
    });
  });

  test.afterAll(() => {
    cleanupContactNotes(wjaId);
    cleanupWJAAndEncuadre(workerId, vacancyId);
    cleanupTestWorker(workerId);
    cleanupVacancies([vacancyId]);
    cleanupTestPatient(patientId);
  });

  test('shows author name, restricts delete to own recent note, and deletes it', async ({
    page,
  }) => {
    await loginAsAdmin(page);

    await page.goto(`/admin/vacancies/${vacancyId}`);

    // Abre o modal de notas pela coluna (agora a primeira, à esquerda).
    const notesButton = page.locator('[data-testid="funnel-notes-button"]').first();
    await expect(notesButton).toBeVisible({ timeout: 20_000 });
    await notesButton.click();

    // As 3 notas carregam (texto + nome do autor).
    await expect(page.getByText('A — Llamé y confirmó', { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('B — Nota de otra operadora', { exact: false })).toBeVisible();
    await expect(page.getByText('C — Nota mía pero vieja', { exact: false })).toBeVisible();
    // Nome do autor aparece (snapshot real do banco).
    await expect(page.getByText(OPERATOR_NAME).first()).toBeVisible();
    await expect(page.getByText(OTHER_OPERATOR_NAME)).toBeVisible();

    // Só UMA nota (a própria + recente) tem botão de excluir.
    await expect(page.locator('[data-testid="contact-note-delete"]')).toHaveCount(1);

    // (1) Visual: modal com as 3 notas, lixeira só na nota A.
    const modal = page.locator('[data-testid="contact-note-item"]').first().locator('..');
    await expect(modal).toHaveScreenshot('contact-notes-modal-delete-affordance.png', {
      maxDiffPixelRatio: 0.05,
    });

    // (2) Pede confirmação na nota A.
    await page.locator('[data-testid="contact-note-delete"]').click();
    await expect(page.locator('[data-testid="contact-note-delete-confirm"]')).toBeVisible();
    await expect(modal).toHaveScreenshot('contact-notes-modal-delete-confirm.png', {
      maxDiffPixelRatio: 0.05,
    });

    // (3) Confirma → DELETE real → a nota A some, sobram 2 (sem lixeira).
    await page.locator('[data-testid="contact-note-delete-confirm"]').click();
    await expect(page.getByText('A — Llamé y confirmó', { exact: false })).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.locator('[data-testid="contact-note-item"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="contact-note-delete"]')).toHaveCount(0);

    await expect(modal).toHaveScreenshot('contact-notes-modal-after-delete.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
