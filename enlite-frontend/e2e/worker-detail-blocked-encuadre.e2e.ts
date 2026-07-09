/**
 * worker-detail-blocked-encuadre.e2e.ts  (projeto chromium-admin)
 *
 * Feature 86ajeu7vw — "Ajustes para Acompanhamento de Postulantes por Prestador".
 *
 * AC: a aba de Encuadres no perfil do prestador precisa INCLUIR casos em que ele
 * está BLOQUEADO, e mostrar a coluna com o ESTÁGIO (coluna do Kanban) em cada caso.
 *
 * Caso da "Júlia": clicou em postular na vaga 800, foi BLOQUEADO (docs incompletos)
 * e por isso NÃO aparecia na aba de Encuadres — a recrutadora não conseguia ver.
 * Agora a linha bloqueada aparece na tabela com o badge "Bloqueados" na coluna
 * "Estado", ao lado dos encuadres normais.
 *
 * Login: Firebase Auth REAL (enlite-prd) via UI — mesma conta do auth.setup.
 * Backend mockado via page.route (padrão chromium-admin): nenhuma chamada real.
 *
 * Screenshot obrigatório via toHaveScreenshot() — requisito hard de CLAUDE.md.
 * Prova: linha bloqueada (caso 800) + coluna de estágio JUNTAS na aba de Encuadres.
 */

import { test, expect, type Route } from '@playwright/test';
import { E2E_EMAIL, loginAsAdmin, mockAdminBaseRoutes, ok } from './helpers/kanban-notes-e2e-helper';

const WORKER_ID = 'bbbb2222-3333-4444-5555-666677778888';

/** Encuadre normal (WJA promovido) — worker foi SELECIONADO na vaga 442. */
const selectedEncuadre = {
  id: 'enc-selected-1',
  jobPostingId: 'jp-442',
  caseNumber: 442,
  vacancyNumber: 1,
  patientName: 'Juan Pérez',
  kanbanStage: 'SELECTED',
  vacancyStatus: 'ACTIVE',
  resultado: 'SELECCIONADO',
  interviewDate: '2026-03-10',
  interviewTime: '10:00',
  recruiterName: 'María',
  coordinatorName: 'Carlos',
  rejectionReason: null,
  rejectionReasonCategory: null,
  attended: true,
  isBlocked: false,
  blockedReason: null,
  missingFields: [] as string[],
  attemptCount: null,
  createdAt: '2026-03-10T10:00:00Z',
};

/** Tentativa BLOQUEADA (caso Júlia) — nunca virou WJA, gate barrou por docs incompletos. */
const blockedEncuadre = {
  id: 'blk-800',
  jobPostingId: 'jp-800',
  caseNumber: 800,
  vacancyNumber: 2,
  patientName: 'Julia Gómez',
  kanbanStage: 'BLOQUEADO',
  vacancyStatus: 'BUSQUEDA',
  resultado: null,
  interviewDate: null,
  interviewTime: null,
  recruiterName: null,
  coordinatorName: null,
  rejectionReason: null,
  rejectionReasonCategory: null,
  attended: null,
  isBlocked: true,
  blockedReason: 'registration_incomplete',
  missingFields: ['criminal_record', 'phone'],
  attemptCount: 2,
  createdAt: '2026-06-01T09:00:00Z',
};

/** WorkerDetail mínimo porém válido para renderizar a página sem crash. */
const workerDetail = {
  id: WORKER_ID,
  email: 'lucia.at@example.com',
  phone: '+5491133445566',
  whatsappPhone: '+5491133445566',
  country: 'Argentina',
  timezone: 'America/Argentina/Buenos_Aires',
  status: 'REGISTERED',
  overallStatus: null,
  availabilityStatus: null,
  dataSources: ['candidatos'],
  platform: 'talentum',
  createdAt: '2026-01-10T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  firstName: 'Lucía',
  lastName: 'Fernández',
  sex: 'Mujer',
  gender: null,
  birthDate: '1990-05-05',
  documentType: 'DNI',
  documentNumber: '30111222',
  profilePhotoUrl: null,
  profession: 'AT',
  occupation: 'AT',
  knowledgeLevel: null,
  titleCertificate: null,
  experienceTypes: [] as string[],
  yearsExperience: null,
  preferredTypes: [] as string[],
  preferredAgeRange: [] as string[],
  languages: ['es'],
  sexualOrientation: null,
  race: null,
  religion: null,
  weightKg: null,
  heightCm: null,
  hobbies: [] as string[],
  diagnosticPreferences: [] as string[],
  linkedinUrl: null,
  isMatchable: true,
  isActive: true,
  isTest: false,
  documents: null,
  serviceAreas: [] as unknown[],
  location: null,
  // A ordem espelha o backend (createdAt desc): bloqueado (jun) antes do SELECTED (mar).
  encuadres: [blockedEncuadre, selectedEncuadre],
  availability: [] as unknown[],
  tags: [] as unknown[],
};

test.describe('Worker detail — aba de Encuadres inclui casos BLOQUEADOS (auth real)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 1024 } });

  test('mostra a linha bloqueada (caso 800) e a coluna de estágio na aba de Encuadres', async ({ page }) => {
    await mockAdminBaseRoutes(page);

    // Rota específica do worker registrada DEPOIS do catch-all → vence.
    await page.route(`**/api/admin/workers/${WORKER_ID}`, (route: Route) =>
      route.fulfill(ok(workerDetail)),
    );

    // Documentos adicionais são buscados no mount (aba Documentos é a default) — sem
    // esse mock o catch-all devolve null e AdditionalDocumentsSection quebra em `.length`.
    await page.route(`**/api/admin/workers/${WORKER_ID}/additional-documents`, (route: Route) =>
      route.fulfill(ok([])),
    );

    // Catálogo de tags carregado no mount (WorkerTagsArea) — catch-all null quebra em `.filter`.
    await page.route('**/api/admin/worker-tags', (route: Route) => route.fulfill(ok([])));

    await loginAsAdmin(page);
    await page.goto(`/admin/workers/${WORKER_ID}`);

    // Abre a aba "Encuadre".
    const encuadresTab = page.getByRole('button', { name: 'Encuadre', exact: true });
    await expect(encuadresTab).toBeVisible({ timeout: 20_000 });
    await encuadresTab.click();

    const table = page.getByRole('table');
    await expect(table).toBeVisible({ timeout: 10_000 });

    // Coluna de estágio ("Estado") presente no cabeçalho.
    await expect(page.getByRole('columnheader', { name: 'Estado' })).toBeVisible();

    // Caso bloqueado (Júlia — caso 800) aparece com badge "Bloqueados" + contagem.
    await expect(table.getByText('800')).toBeVisible();
    await expect(table.getByText('Julia Gómez')).toBeVisible();
    await expect(table.getByText('Bloqueados')).toBeVisible();
    await expect(table.getByText(/2 intento/)).toBeVisible();

    // Encuadre normal continua listado (não substituído).
    await expect(table.getByText('442')).toBeVisible();
    await expect(table.getByText('Seleccionados')).toBeVisible();

    // Screenshot obrigatório: linha bloqueada + coluna de estágio na mesma tabela.
    await expect(table).toHaveScreenshot('worker-detail-encuadres-with-blocked.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
