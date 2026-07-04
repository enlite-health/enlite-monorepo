/**
 * kanban-card-notes-button.e2e.ts  (projeto chromium-admin)
 *
 * Task "Colocar o Link de Mensagens no Card do Kanban" (ClickUp 86ajbhmvu).
 *
 * VALIDAÇÃO VISUAL com AUTH FIREBASE REAL: o card do Kanban ganhou um botão
 * "Comentarios" que reaproveita 100% a feature de Contact Notes já existente na
 * listagem/funil (ContactNotesModal + useContactNotes) — comentário/nota do
 * operador sobre o candidato, escopado ao par candidato×vaga (WJA). NÃO é
 * envio de WhatsApp.
 *
 * O card do Kanban já carrega o wja.id no prop `id`, então clicar abre o MESMO
 * modal usado na tabela, apontando pra:
 *   GET/POST /api/admin/vacancies/:id/applications/:wjaId/contact-notes
 *
 * Login: Firebase Auth REAL (enlite-prd) via UI — mesma conta do auth.setup.
 * Backend mockado via page.route (padrão do projeto chromium-admin): nenhuma
 * chamada real ao backend.
 *
 * Screenshot obrigatório via toHaveScreenshot() — requisito hard de CLAUDE.md.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const E2E_EMAIL =
  process.env.E2E_ADMIN_EMAIL ?? process.env.E2E_TEST_EMAIL ?? 'gabriel.g.stein@gmail.com';
const E2E_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? process.env.E2E_TEST_PASSWORD ?? 'Teste@123';

const VACANCY_ID = 'aaaa1111-2222-3333-4444-555566667777';
const WJA_ID = 'wja-notes-btn-1';
const WORKER_ID = 'worker-notes-btn-1';
const WORKER_NAME = 'Marcia Costa';
const WORKER_PHONE = '+5491158631297';

// ── Mock data ────────────────────────────────────────────────────────────────

function emptyStages() {
  return {
    INVITED: [], BLOQUEADO: [], INICIADO: [], PRE_SCREENING: [],
    IN_PROGRESS: [], COMPLETED: [], CONFIRMED: [], SELECTED: [], REJECTED: [],
  } as Record<string, unknown[]>;
}

const funnelCard = {
  id: WJA_ID,
  encuadreId: 'enc-notes-btn-1',
  workerId: WORKER_ID,
  workerName: WORKER_NAME,
  workerPhone: WORKER_PHONE,
  occupation: 'AT',
  interviewDate: null,
  interviewTime: null,
  meetLink: null,
  interviewResponse: null,
  resultado: null,
  attended: null,
  rejectionReasonCategory: null,
  rejectionReason: null,
  matchScore: 8.7,
  talentumStatus: 'QUALIFIED',
  workZone: 'Palermo',
  redireccionamiento: null,
  acquisitionChannel: null,
  internalStage: 'QUALIFIED',
  // 2 comentários pré-existentes → badge de contagem no card
  contactNotesCount: 2,
};

const mockVacancy = {
  id: VACANCY_ID,
  case_number: 55501,
  vacancy_number: 1,
  title: 'Caso 55501 — Vacante Comentarios',
  status: 'SEARCHING',
  country: 'Argentina',
  providers_needed: 1,
  worker_profile_sought: 'AT',
  schedule: null,
  schedule_days_hours: null,
  patient_id: 'patient-55501',
  patient_first_name: 'Paciente',
  patient_last_name: 'Comentarios',
  patient_zone: 'Palermo',
  patient_city: 'CABA',
  patient_neighborhood: 'Palermo',
  insurance_verified: true,
  required_professions: ['AT'],
  required_sex: 'F',
  pathology_types: 'TEA',
  encuadres: [],
  publications: [],
  meet_link_1: null,
  meet_datetime_1: null,
  meet_link_2: null,
  meet_datetime_2: null,
  meet_link_3: null,
  meet_datetime_3: null,
};

interface ContactNote {
  id: string;
  workerJobApplicationId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName: string | null;
  createdByAdminEmail: string | null;
  createdAt: string;
  canDelete: boolean;
}

function ok(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: body }),
  };
}

/**
 * Login Firebase REAL + mock de TODO o backend admin, incluindo o endpoint de
 * contact-notes com estado (POST anexa; GET devolve a lista — igual o backend).
 */
/** Histórico pré-existente de notas — de operadores diferentes, em datas diferentes. */
const seedNotes: ContactNote[] = [
  {
    id: 'note-seed-1',
    workerJobApplicationId: WJA_ID,
    noteText: 'Primer contacto: no atendió el llamado, dejé mensaje de voz.',
    createdByAdminId: 'admin-sofia',
    createdByAdminName: 'Sofía Ramírez',
    createdByAdminEmail: 'sofia@enlite.health',
    createdAt: '2026-07-01T14:20:00.000Z',
    canDelete: false,
  },
  {
    id: 'note-seed-2',
    workerJobApplicationId: WJA_ID,
    noteText: 'Devolvió el llamado, pidió más info sobre la zona y el horario.',
    createdByAdminId: 'admin-diego',
    createdByAdminName: 'Diego Fernández',
    createdByAdminEmail: 'diego@enlite.health',
    createdAt: '2026-07-02T10:05:00.000Z',
    canDelete: false,
  },
];

async function loginAndMockBackend(page: Page): Promise<{ notes: ContactNote[] }> {
  const store = { notes: [...seedNotes] as ContactNote[] };

  // Catch-all admin PRIMEIRO — rotas específicas abaixo têm precedência
  // (Playwright: última rota registrada vence). Evita 401/crash.
  await page.route('**/api/admin/**', (route: Route) => route.fulfill(ok(null)));

  // Perfil admin (mockado — não dependemos do uid estar linkado no banco).
  await page.route('**/api/admin/auth/profile', (route: Route) =>
    route.fulfill(ok({
      id: 'e2e-admin',
      email: E2E_EMAIL,
      role: 'superadmin',
      firstName: 'Admin',
      lastName: 'E2E',
      isActive: true,
      mustChangePassword: false,
    })),
  );

  await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, (route: Route) =>
    route.fulfill(ok(mockVacancy)),
  );

  // Funil (Kanban) — 1 card cujo id === WJA_ID → o modal de comentários abre pra ele.
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/funnel`, (route: Route) => {
    const stages = emptyStages();
    stages.COMPLETED = [funnelCard];
    return route.fulfill(ok({ stages, totalEncuadres: 1 }));
  });

  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/funnel-table**`, (route: Route) =>
    route.fulfill(ok({ rows: [], counts: {}, total: 0 })),
  );

  // Contact notes — stateful. GET devolve a lista; POST anexa uma nota e devolve.
  await page.route(
    `**/api/admin/vacancies/${VACANCY_ID}/applications/${WJA_ID}/contact-notes`,
    (route: Route) => {
      const method = route.request().method();
      if (method === 'POST') {
        const body = route.request().postDataJSON() as { noteText: string };
        const note: ContactNote = {
          id: `note-${store.notes.length + 1}`,
          workerJobApplicationId: WJA_ID,
          noteText: body.noteText,
          createdByAdminId: 'e2e-admin',
          createdByAdminName: 'Admin E2E',
          createdByAdminEmail: E2E_EMAIL,
          createdAt: '2026-07-04T12:00:00.000Z',
          canDelete: true,
        };
        store.notes.push(note);
        return route.fulfill(ok(note));
      }
      return route.fulfill(ok(store.notes));
    },
  );

  // Login REAL no Firebase (sem interceptar identitytoolkit).
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(E2E_EMAIL);
  await page.locator('input[type="password"]').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 25_000 });

  return store;
}

// ── Suite ────────────────────────────────────────────────────────────────────

test.describe('Kanban card — botão Comentarios (contact notes, auth real)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  // Pasta de docs onde salvamos a sequência do fluxo (além dos snapshots de regressão).
  const SHOTS = '../docs/features/kanban-contact-notes/screenshots';

  test('card mostra "Comentarios" e o clique abre o modal de notas; registrar persiste a nota', async ({ page }) => {
    await loginAndMockBackend(page);

    // Força a aba Encuadres a abrir em view=kanban.
    await page.addInitScript(
      ([key]) => window.localStorage.setItem(key, 'kanban'),
      [`vacancy-funnel-view-${VACANCY_ID}`],
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 20_000 });

    // Card com o botão de comentários
    const card = page.locator(`[data-testid="kanban-card-${WJA_ID}"][data-stage]`).first();
    await expect(card, 'Card do worker deve estar visível no Kanban').toBeVisible({ timeout: 15_000 });

    const notesButton = card.locator('[data-testid="notes-button"]');
    await expect(notesButton, 'Card deve exibir o botão Comentarios').toBeVisible();
    await expect(notesButton).toHaveText(/Comentarios/i);

    // Badge de contagem: card tem 2 comentários cadastrados
    const countBadge = card.locator('[data-testid="notes-count-badge"]');
    await expect(countBadge, 'Card deve exibir o badge com a contagem de comentários').toBeVisible();
    await expect(countBadge).toHaveText('2');

    // [DOC 1] Kanban com o card + botão Comentarios no contexto da tela
    await page.screenshot({ path: `${SHOTS}/01-kanban-card-comentarios.png` });
    // [DOC 2] Card em close-up
    await card.screenshot({ path: `${SHOTS}/02-card-closeup.png` });

    // Screenshot de regressão do card (snapshot)
    await expect(card).toHaveScreenshot('kanban-card-with-notes-button.png', {
      maxDiffPixelRatio: 0.05,
    });

    // Clicar → modal de comentários (mesmo da listagem) abre
    await notesButton.click();

    const modal = page.getByRole('textbox');
    await expect(modal, 'Textarea de comentário deve aparecer').toBeVisible({ timeout: 10_000 });

    // O histórico pré-existente (de outros operadores) já aparece na lista
    await expect(page.getByText('Sofía Ramírez')).toBeVisible();
    await expect(page.getByText('Diego Fernández')).toBeVisible();

    // [DOC 3] Modal aberto mostrando o histórico de comentários (autor + data)
    await page.screenshot({ path: `${SHOTS}/03-modal-historico.png` });

    // Escrever a nota
    const noteText = 'Contactado por WhatsApp, confirma interés en la vacante.';
    await modal.fill(noteText);

    // [DOC 4] Nota digitada, antes de registrar
    await page.screenshot({ path: `${SHOTS}/04-nota-digitada.png` });

    await page.getByRole('button', { name: /Registrar/i }).click();

    // A nota registrada aparece na lista do modal (POST → refetch GET)
    await expect(page.getByText(noteText)).toBeVisible({ timeout: 10_000 });

    // [DOC 5] Nota registrada na lista
    await page.screenshot({ path: `${SHOTS}/05-nota-registrada.png` });

    // Screenshot de regressão do modal com a nota (snapshot)
    const dialog = page.locator('.fixed.inset-0.z-50').first();
    await expect(dialog).toHaveScreenshot('kanban-contact-notes-modal.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
