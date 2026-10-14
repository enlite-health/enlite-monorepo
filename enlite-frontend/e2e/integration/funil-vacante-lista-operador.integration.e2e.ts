/**
 * funil-vacante-lista-operador.integration.e2e.ts @integration
 *
 * 054b (itens 5, 8 e prova do item 1): a Lista do funil usada como um OPERADOR — stack real
 * (Vite + API + Postgres), sem `page.route`, sem mock de API. Click + `page.keyboard.type`
 * (nunca fill) no que se prova; valores lidos da TELA; esperas com expect/toPass.
 *
 * O nome do arquivo começa com `funil-vacante`, que o `--grep` do pr-gate já casa
 * (`.github/workflows/pr-gate.yml:194` → `...|funil-vacante|lista-vacantes|...`), então roda no CI.
 *
 *   funil-lista-operador-busca-e-registro      — a) abrir (Kanban) e clicar "Lista"; b) busca por nome sem
 *                                                acento e em outra caixa; c) busca por trecho de telefone com
 *                                                espaço/hífen; d) seletor Registro (Completo/Incompleto)
 *                                                combinado com a busca; e) sem resultado → funnel-empty-filtered
 *                                                e NÃO o vazio da vaga.
 *   funil-lista-operador-nota-do-kanban-na-lista — f) nota criada digitando no Kanban ("Comentarios") aparece
 *                                                no badge e no modal da Lista (item 1).
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  insertTestWorker,
  cleanupTestWorker,
} from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginAs, type MockUser } from '../helpers/abac-stack-helper';
import { gotoVacancyDetail, switchToLista } from '../helpers/compativeis-e2e-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-funil-lista-operador',
  email: 'staff.funil.lista.operador@e2e.test',
  role: 'admin',
  country: 'AR',
};

// Nomes COM acento; telefones distintos e sem trecho em comum com o que o teste digita no outro.
const ANGELA = { firstName: 'Ángela', lastName: 'Gómez', phone: '+5491155501111', status: 'REGISTERED' as const };
const BERNARDO = { firstName: 'Bernardo', lastName: 'Pérez', phone: '+5491166602222', status: 'INCOMPLETE_REGISTER' as const };

let patientId = '';
let vacancyId = '';
let angelaWorkerId = '';
let bernardoWorkerId = '';
let angelaWjaId = '';

/** Nomes das linhas visíveis na Lista, lidos da tela (link do prestador de cada linha). */
async function visibleNames(page: Page): Promise<string[]> {
  const links = page.getByTestId('vacancy-funnel-view').getByTestId('funnel-worker-link');
  return (await links.allInnerTexts()).map((n) => n.trim()).sort();
}

/**
 * Container do ContactNotesModal (ContactNotesModal.tsx:57-58: overlay `fixed inset-0`, sem role/testid),
 * achado pelo título h3 "Notas de contacto" (:68) → ancestral `fixed`. Evita casar com o painel de
 * notificações (aria-label "Cerrar notificaciones") e com qualquer outro botão da página.
 */
function notesModal(page: Page) {
  return page
    .getByRole('heading', { name: 'Notas de contacto' })
    .locator('xpath=ancestor::div[contains(@class,"fixed")][1]');
}

async function clearSearchAndType(page: Page, text: string): Promise<void> {
  const search = page.getByTestId('funnel-filter-search');
  await search.click();
  await expect(search).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  if (text) await page.keyboard.type(text);
  await expect(search).toHaveValue(text);
}

test.describe('funil da vacante — Lista como operador @integration', () => {
  test.use({ viewport: { width: 1366, height: 900 }, locale: 'es-AR' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Funil Lista Operador');
    const patient = insertTestPatient({ withAddress: true, firstName: 'FunilListaOp', lastName: `L-${Date.now()}` });
    patientId = patient.patientId;
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: patient.addressId!,
      caseNumber: 970_000 + Math.floor(Math.random() * 9_000),
      status: 'SEARCHING',
      isDraft: false,
    });
    angelaWorkerId = insertTestWorker(ANGELA);
    bernardoWorkerId = insertTestWorker(BERNARDO);
    angelaWjaId = insertWJA({ workerId: angelaWorkerId, jobPostingId: vacancyId, funnelStage: 'INVITED', source: 'manual' });
    // Bernardo é INCOMPLETE_REGISTER: o gatilho enforce_worker_registered_for_application recusa WJA, então
    // ele entra pelo caminho real — tentativa BLOQUEADA (worker_blocked_applications), que a Lista mostra em
    // Iniciados com Registro Incompleto (mesmo seed do P22 em funil-vacante.integration.e2e.ts).
    runSQL(
      `INSERT INTO worker_blocked_applications ` +
        `(worker_id, job_posting_id, blocked_reason, missing_fields, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel) ` +
        `VALUES ('${bernardoWorkerId}', '${vacancyId}', 'registration_incomplete', '[]', 'registration_incomplete', '[]', 'site')`,
    );
  });

  test.afterAll(() => {
    for (const workerId of [angelaWorkerId, bernardoWorkerId]) {
      try {
        runSQL(`DELETE FROM worker_blocked_applications WHERE worker_id = '${workerId}'`);
        cleanupWJAAndEncuadre(workerId, vacancyId);
        cleanupTestWorker(workerId);
      } catch (err) {
        console.error('[cleanup] worker falhou (seguindo)', err);
      }
    }
    try { cleanupTestPatient(patientId); } catch (err) { console.error('[cleanup] patient falhou', err); }
    try { cleanupMockStaff(MOCK_STAFF); } catch (err) { console.error('[cleanup] staff falhou', err); }
  });

  test('funil-lista-operador-busca-e-registro', async ({ page }) => {
    await loginAs(page, MOCK_STAFF);

    // a) abre no Kanban e clica "Lista".
    await gotoVacancyDetail(page, vacancyId);
    await switchToLista(page, vacancyId);
    await expect.poll(() => visibleNames(page), { message: 'as duas linhas na Lista' }).toEqual(
      ['Bernardo Pérez', 'Ángela Gómez'].sort(),
    );

    // b) nome SEM acento e em caixa diferente.
    await clearSearchAndType(page, 'GOMEZ');
    await expect.poll(() => visibleNames(page)).toEqual(['Ángela Gómez']);
    await clearSearchAndType(page, 'bernardo perez');
    await expect.poll(() => visibleNames(page)).toEqual(['Bernardo Pérez']);

    // c) trecho de dígitos do telefone com espaço/hífen (…1555 0111 → só a Ángela).
    await clearSearchAndType(page, '1555-0111');
    await expect.poll(() => visibleNames(page)).toEqual(['Ángela Gómez']);
    await clearSearchAndType(page, '6660 22');
    await expect.poll(() => visibleNames(page)).toEqual(['Bernardo Pérez']);

    // d) seletor Registro (select nativo: selectOption por rótulo é o gesto do usuário); combinado com a busca.
    await clearSearchAndType(page, '');
    const registration = page.getByTestId('funnel-filter-registration');
    await registration.selectOption({ label: 'Completo' });
    await expect.poll(() => visibleNames(page)).toEqual(['Ángela Gómez']);
    await registration.selectOption({ label: 'Incompleto' });
    await expect.poll(() => visibleNames(page)).toEqual(['Bernardo Pérez']);
    await clearSearchAndType(page, 'gomez'); // Incompleto + busca da Completa → nada
    await expect(page.getByTestId('funnel-empty-filtered')).toBeVisible();
    await registration.selectOption({ label: 'Completo' }); // Completo + busca da Completa → ela
    await expect.poll(() => visibleNames(page)).toEqual(['Ángela Gómez']);

    // e) busca sem resultado → vazio FILTRADO; o vazio da vaga NÃO aparece (a vaga tem candidatos).
    await registration.selectOption({ label: 'Todos' });
    await clearSearchAndType(page, 'zzzzqq');
    await expect(page.getByTestId('funnel-empty-filtered')).toBeVisible();
    await expect(page.getByText('Sin candidatos en esta vacante')).toHaveCount(0);
  });

  test('funil-lista-operador-nota-do-kanban-na-lista', async ({ page }) => {
    const noteText = `Nota 054b ${Date.now()} llamé y confirmó`;
    await loginAs(page, MOCK_STAFF);
    await gotoVacancyDetail(page, vacancyId); // Kanban

    // Kanban: "Comentarios" do card da Ángela → digita a nota → registra → fecha.
    const card = page.getByTestId(`kanban-card-${angelaWjaId}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByTestId('notes-button').click();
    const modal = notesModal(page);
    await expect(modal).toBeVisible();
    const textarea = modal.getByPlaceholder('Escribí una nota sobre este candidato…');
    await textarea.click();
    await expect(textarea).toBeFocused();
    await page.keyboard.type(noteText);
    await expect(textarea).toHaveValue(noteText);
    const [post] = await Promise.all([
      page.waitForResponse((r) => /contact-notes/.test(r.url()) && r.request().method() === 'POST'),
      modal.getByRole('button', { name: 'Registrar', exact: true }).click(),
    ]);
    expect(post.ok(), 'POST contact-notes falhou').toBe(true);
    await expect(modal.getByText(noteText)).toBeVisible();
    await modal.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect(modal).toHaveCount(0);

    // Lista: badge da linha da Ángela mostra 1 e o modal do funnel-notes-button mostra o texto.
    await switchToLista(page, vacancyId);
    const row = page.getByTestId('vacancy-funnel-view').locator('[data-testid^="funnel-row-"]').filter({ hasText: 'Ángela' });
    await expect(async () => {
      await expect(row.getByTestId('notes-count-badge')).toHaveText('1');
    }).toPass({ timeout: 25_000 }); // cobre o polling de 10 s da Lista
    await row.getByTestId('funnel-notes-button').click();
    await expect(notesModal(page).getByText(noteText)).toBeVisible({ timeout: 15_000 });
  });
});
