/**
 * kanban-card-blocked-notes-button.e2e.ts  (projeto chromium-admin)
 *
 * Feature: "coluna BLOQUEADO do Kanban com a mesma UX dos demais cards".
 *
 * O card BLOQUEADO (candidato barrado pelo gate de postulação) hoje só
 * mostrava os motivos de bloqueio. Passa a ganhar, MANTENDO os motivos:
 *   1. Link pro perfil do worker (quando workerId presente).
 *   2. Telefone (workerPhone).
 *   3. Botão de Comentarios — MESMO histórico do candidato naquela vaga em
 *      TODAS as colunas (chaveado por workerId, não por wja.id) — não zera
 *      na promoção BLOQUEADO → INICIADO:
 *        GET/POST /api/admin/vacancies/:id/workers/:workerId/contact-notes
 *
 * Login: Firebase Auth REAL (enlite-prd) via UI — mesma conta do auth.setup.
 * Backend mockado via page.route (padrão do projeto chromium-admin): nenhuma
 * chamada real ao backend.
 *
 * Screenshot obrigatório via toHaveScreenshot() — requisito hard de CLAUDE.md.
 * Prova nome/link + telefone + botão de comentário + motivos de bloqueio
 * JUNTOS no mesmo card.
 */

import { test, expect, type Route } from '@playwright/test';
import {
  E2E_EMAIL,
  VACANCY_ID,
  emptyStages,
  loginAsAdmin,
  mockAdminBaseRoutes,
  ok,
  type ContactNote,
} from './helpers/kanban-notes-e2e-helper';

const BLOCKED_CARD_ID = 'blocked-attempt-1';
const BLOCKED_WORKER_ID = 'worker-blocked-1';
const BLOCKED_WORKER_NAME = 'Lucía Fernández';
const BLOCKED_WORKER_PHONE = '+5491133445566';

/** Card BLOQUEADO: sem encuadre (nunca foi arrastado), mas com a MESMA UX dos demais. */
const blockedFunnelCard = {
  id: BLOCKED_CARD_ID,
  encuadreId: null,
  workerId: BLOCKED_WORKER_ID,
  workerName: BLOCKED_WORKER_NAME,
  workerPhone: BLOCKED_WORKER_PHONE,
  occupation: 'AT',
  interviewDate: null,
  interviewTime: null,
  meetLink: null,
  interviewResponse: null,
  resultado: null,
  attended: null,
  rejectionReasonCategory: null,
  rejectionReason: null,
  matchScore: null,
  talentumStatus: null,
  workZone: 'Belgrano',
  redireccionamiento: null,
  acquisitionChannel: null,
  internalStage: null,
  isBlocked: true,
  blockedReason: 'registration_incomplete',
  missingFields: ['profession', 'phone'],
  attemptCount: 2,
  // 1 comentário pré-existente do candidato bloqueado — mesmo histórico worker×vaga
  contactNotesCount: 1,
};

const seedNote: ContactNote = {
  id: 'note-blocked-seed-1',
  workerJobApplicationId: BLOCKED_CARD_ID,
  noteText: 'Intentó postularse pero el registro está incompleto.',
  createdByAdminId: 'admin-sofia',
  createdByAdminName: 'Sofía Ramírez',
  createdByAdminEmail: 'sofia@enlite.health',
  createdAt: '2026-07-03T09:00:00.000Z',
  canDelete: false,
};

test.describe('Kanban card BLOQUEADO — mesma UX dos demais cards (auth real)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('mostra link de perfil, telefone e comentários, mantendo os motivos de bloqueio', async ({ page }) => {
    await mockAdminBaseRoutes(page);

    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/funnel`, (route: Route) => {
      const stages = emptyStages();
      stages.BLOQUEADO = [blockedFunnelCard];
      return route.fulfill(ok({ stages, totalEncuadres: 1 }));
    });

    // Contact notes do worker bloqueado — MESMO endpoint chaveado por workerId.
    const notesStore = { notes: [seedNote] as ContactNote[] };
    await page.route(
      `**/api/admin/vacancies/${VACANCY_ID}/workers/${BLOCKED_WORKER_ID}/contact-notes`,
      (route: Route) => {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON() as { noteText: string };
          const note: ContactNote = {
            id: `note-blocked-${notesStore.notes.length + 1}`,
            workerJobApplicationId: BLOCKED_CARD_ID,
            noteText: body.noteText,
            createdByAdminId: 'e2e-admin',
            createdByAdminName: 'Admin E2E',
            createdByAdminEmail: E2E_EMAIL,
            createdAt: '2026-07-05T12:00:00.000Z',
            canDelete: true,
          };
          notesStore.notes.push(note);
          return route.fulfill(ok(note));
        }
        return route.fulfill(ok(notesStore.notes));
      },
    );

    await loginAsAdmin(page);

    // Força a aba Encuadres a abrir em view=kanban.
    await page.addInitScript(
      ([key]) => window.localStorage.setItem(key, 'kanban'),
      [`vacancy-funnel-view-${VACANCY_ID}`],
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 20_000 });

    const card = page.locator(`[data-testid="kanban-card-${BLOCKED_CARD_ID}"][data-stage]`).first();
    await expect(card, 'Card bloqueado deve estar visível na coluna BLOQUEADO').toBeVisible({ timeout: 15_000 });

    // 1) Link de perfil — nome clicável (mesma UX dos demais cards)
    const nameLink = card.getByRole('button', { name: BLOCKED_WORKER_NAME });
    await expect(nameLink, 'Nome deve ser um link clicável pro perfil do worker').toBeVisible();

    // 2) Informações de contato — telefone
    await expect(card).toContainText('11 3344-5566');

    // 3) Motivos de bloqueio — mantidos
    await expect(card.locator('[data-testid="blocked-badge"]')).toBeVisible();
    await expect(card.locator('[data-testid="blocked-reason"]')).toBeVisible();
    await expect(card.locator('[data-testid="blocked-missing-fields"]')).toBeVisible();
    await expect(card.locator('[data-testid="blocked-attempt-count"]')).toBeVisible();

    // 4) Campo de comentários — não é mais suprimido no card bloqueado
    const notesButton = card.locator('[data-testid="notes-button"]');
    await expect(notesButton, 'Card bloqueado deve exibir o botão Comentarios').toBeVisible();
    await expect(card.locator('[data-testid="notes-count-badge"]')).toHaveText('1');

    // Screenshot obrigatório: prova nome/link + telefone + comentários + motivos JUNTOS no mesmo card.
    await expect(card).toHaveScreenshot('kanban-card-blocked-full-ux.png', {
      maxDiffPixelRatio: 0.05,
    });

    // Clicar em Comentarios abre o MESMO modal, chaveado por workerId (não wjaId)
    await notesButton.click();
    await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Sofía Ramírez')).toBeVisible();
    await expect(
      page.getByText('Intentó postularse pero el registro está incompleto.'),
    ).toBeVisible();
  });
});
