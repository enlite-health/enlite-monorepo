/**
 * kanban-card-promover-elegivel.e2e.ts
 *
 * O card ELEGIBLE e o botão "Promover" (D300) — clique → HTTP → frase na tela.
 *
 * Este arquivo existe porque a feature nasceu SEM e2e, e a ausência escondeu um
 * defeito grave: o 409 do backend saía sem `code`/`reason`, e toda recusa caía no
 * `defaultValue` da tela. A recrutadora que clicasse em alguém com opt-out lia
 * "Não foi possível promover. Tente de novo." — a frase que manda ela REPETIR
 * exatamente o que não deve ser feito. Os dois lados tinham teste unitário; nenhum
 * pegou, porque cada um testava contra a própria suposição do contrato.
 *
 * É por isso que os casos abaixo assertam o TEXTO que aparece no card, e não o
 * status HTTP: o status já tinha teste, a frase é que não chegava.
 *
 * Auth interceptada (`loginAsStaffOffline`): sem emulador e sem canal real, para
 * caber no `playwright.mocked.config.ts` e no CI.
 */

import { test, expect, Page, type Route } from '@playwright/test';
import { loginAsStaffOffline } from './helpers/kanban-notes-e2e-helper';

const VAGA = 'promov01-0001-0001-0001-000000000001';
const CARD = 'ba-elegivel-1';

const VACANCY = {
  id: VAGA,
  caseNumber: 900,
  vacancyNumber: 1,
  title: 'Caso 900',
  status: 'ACTIVE',
  patientId: null,
  patientFirstName: null,
  patientLastName: null,
};

/** Card de tentativa bloqueada cujo estado VIVO é `eligible` (cadastro completo). */
const CARD_ELEGIVEL = {
  id: CARD,
  encuadreId: null,
  workerId: 'wk-elegivel-1',
  workerName: 'Flora Garcete',
  workerPhone: '+5491121938655',
  occupation: 'AT',
  interviewDate: null,
  interviewTime: null,
  meetLink: null,
  resultado: null,
  attended: null,
  rejectionReasonCategory: null,
  rejectionReason: null,
  matchScore: null,
  workZone: null,
  redireccionamiento: null,
  isBlocked: true,
  blockedReason: 'eligible',
  missingFields: [],
  attemptCount: 5,
  contactNotesCount: 0,
};

function funil() {
  return {
    success: true,
    data: {
      stages: {
        INVITED: [], BLOQUEADO: [CARD_ELEGIVEL], INICIADO: [], PRE_SCREENING: [],
        IN_PROGRESS: [], COMPLETED: [], CONFIRMED: [], SELECTED: [], REJECTED: [],
      },
      totalEncuadres: 1,
    },
  };
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function abrirKanban(page: Page): Promise<void> {
  await loginAsStaffOffline(page);

  await page.route(`**/api/admin/vacancies/${VAGA}`, (r: Route) =>
    r.fulfill(json({ success: true, data: VACANCY })),
  );
  await page.route(`**/api/admin/vacancies/${VAGA}/funnel`, (r: Route) =>
    r.fulfill(json(funil())),
  );

  await page.addInitScript(
    ([k]) => window.localStorage.setItem(k, 'kanban'),
    [`vacancy-funnel-view-${VAGA}`],
  );
  await page.goto(`/admin/vacancies/${VAGA}`);
  await expect(page.locator(`[data-testid="kanban-card-${CARD}"]`)).toBeVisible({ timeout: 15_000 });
}

test.describe('Card ELEGIBLE — promover a candidatura', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('mostra o rótulo verde e a ação, e NÃO mostra campos faltantes', async ({ page }) => {
    await abrirKanban(page);

    const card = page.locator(`[data-testid="kanban-card-${CARD}"]`);
    await expect(card.locator('[data-testid="blocked-badge"]')).toHaveText(/ELEGIBLE AHORA/i);
    await expect(card.locator('[data-testid="blocked-reason"]')).toHaveText(/Registro completo/i);
    await expect(card.locator('[data-testid="promote-button"]')).toBeEnabled();
    // Quem está completo não tem campo faltando — exibir a lista aqui seria a
    // mentira antiga ao contrário.
    await expect(card.locator('[data-testid="blocked-missing-fields"]')).toHaveCount(0);
  });

  test('promoção bem-sucedida recarrega o funil e o botão para de convidar clique', async ({ page }) => {
    await abrirKanban(page);

    let chamou: string | null = null;
    await page.route(`**/api/admin/vacancies/blocked-applications/${CARD}/promote`, (r: Route) => {
      chamou = r.request().url();
      return r.fulfill(json({ success: true, data: { blockedId: CARD, promoted: 1 } }));
    });

    await page.locator('[data-testid="promote-button"]').click();

    // A URL exercitada de verdade — nenhum teste unitário chega aqui, e um erro de
    // digitação no caminho passaria por tsc, unit e CI.
    await expect
      .poll(() => chamou, { timeout: 10_000 })
      .toContain(`/api/admin/vacancies/blocked-applications/${CARD}/promote`);
    await expect(page.locator('[data-testid="promote-button"]')).toBeDisabled();
    await expect(page.locator('[data-testid="promote-message"]')).toHaveCount(0);
  });

  /**
   * O caso que motivou o arquivo. Cada recusa tem uma frase própria, e a de
   * opt-out é a que não pode virar "tente de novo": a pessoa pediu para não
   * receber mensagens, e insistir é o oposto do que a operação deve fazer.
   */
  const RECUSAS: Array<{ reason: string; trecho: RegExp }> = [
    { reason: 'worker_opted_out',   trecho: /no recibir mensajes/i },
    { reason: 'vacancy_invalid',    trecho: /ya no admite candidaturas/i },
    { reason: 'wja_already_exists', trecho: /Ya existe una candidatura/i },
    { reason: 'worker_not_eligible', trecho: /dejó de estar completo/i },
    { reason: 'unique_conflict',    trecho: /al mismo tiempo/i },
  ];

  for (const { reason, trecho } of RECUSAS) {
    test(`recusa "${reason}" mostra a frase PRÓPRIA no card, nunca a genérica`, async ({ page }) => {
      await abrirKanban(page);

      await page.route(`**/api/admin/vacancies/blocked-applications/${CARD}/promote`, (r: Route) =>
        // Corpo IDÊNTICO ao que o controller devolve — inclusive `code` e `reason`,
        // que é o que o `ApiError` usa para a tela escolher a frase.
        r.fulfill(json({
          success: false, error: reason, code: reason, reason,
          data: { blockedId: CARD, reasons: { [reason]: 1 } },
        }, 409)),
      );

      await page.locator('[data-testid="promote-button"]').click();

      const msg = page.locator('[data-testid="promote-message"]');
      await expect(msg).toBeVisible({ timeout: 10_000 });
      await expect(msg).toHaveText(trecho);
      await expect(msg).not.toHaveText(/Intentá de nuevo|Tente de novo/i);
      // Erro deixa clicável de novo — o estado não fica preso.
      await expect(page.locator('[data-testid="promote-button"]')).toBeEnabled();
    });
  }

  test('card que segue bloqueado de verdade NÃO ganha o botão', async ({ page }) => {
    await loginAsStaffOffline(page);

    await page.route(`**/api/admin/vacancies/${VAGA}`, (r: Route) =>
      r.fulfill(json({ success: true, data: VACANCY })),
    );
    await page.route(`**/api/admin/vacancies/${VAGA}/funnel`, (r: Route) => {
      const f = funil();
      f.data.stages.BLOQUEADO = [{
        ...CARD_ELEGIVEL,
        blockedReason: 'registration_incomplete',
        missingFields: ['years_experience', 'preferred_types'],
      }];
      return r.fulfill(json(f));
    });

    await page.addInitScript(
      ([k]) => window.localStorage.setItem(k, 'kanban'),
      [`vacancy-funnel-view-${VAGA}`],
    );
    await page.goto(`/admin/vacancies/${VAGA}`);

    const card = page.locator(`[data-testid="kanban-card-${CARD}"]`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('[data-testid="promote-button"]')).toHaveCount(0);
    // E mostra QUAIS campos faltam — o conserto que originou tudo isto.
    const tags = card.locator('[data-testid="blocked-missing-fields"]');
    await expect(tags).toContainText('Años de experiencia');
    await expect(tags).toContainText('Tipos de servicio preferidos');
  });
});
