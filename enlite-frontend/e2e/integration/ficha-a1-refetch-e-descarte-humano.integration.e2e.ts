/**
 * ficha-a1-refetch-e-descarte-humano.integration.e2e.ts @integration — entrega A1 (15/09/2026)
 *
 * Prova, contra o stack REAL (API + Postgres + emulador Firebase, sem mock), os dois consertos:
 *
 *   Item 1+4 — `usePatientDetail.refetch`/`usePatientVacancies.refetch` deixaram de ligar
 *   `isLoading`: `PatientDetailPage.tsx` troca a página INTEIRA por `<DetailSkeleton/>`
 *   (`role="status" aria-label="Carregando..."`) enquanto `isLoading===true`, então salvar
 *   QUALQUER card da ficha piscava a tela inteira para skeleton por um instante. Prova: um
 *   `MutationObserver` ligado ANTES do clique em "Guardar" conta quantas vezes o skeleton aparece
 *   no DOM durante o save — a asserção é o CONTADOR, não "não vi" (instrumento morto se não
 *   detectasse nada — por isso o cenário A2 abaixo prova que o mesmo instrumento VÊ o skeleton
 *   quando ele de fato aparece, no load inicial).
 *
 *   Item 7 — `TherapeuticProjectDrawer` trocou `window.confirm` cru pelo par
 *   `useConfirmDiscardClose`/`DiscardChangesConfirm` (mesmo componente dos 8 drawers de
 *   `PatientDetail/edit/`).
 *
 * Régua humana (memória `e2e-humano-nao-e-fill`): campo de texto é `click()` + `focused` +
 * `keyboard.type()`, valor lido de `inputValue()`/da tela. Sem `fill`/`forceFill`/`page.route`.
 * Login real pelo emulador Firebase (`loginComoHumano`), banco real via `docker exec`.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedFichaA1Patient, cleanupPatientDeep, type FichaA1Seed } from '../helpers/ficha-a1-helper';
import { loginComoHumano } from '../helpers/login-humano';

const STAFF_EMAIL = `e2e.ficha-a1.${Date.now()}@enlite.health`;

/** Clica no campo como um humano, digita, e devolve o que a TELA mostra depois (sem `fill`). */
async function digitar(page: Page, testId: string, texto: string): Promise<string> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

/**
 * Liga um `MutationObserver` no `<body>` e conta cada vez que o skeleton da ficha
 * (`DetailSkeleton.tsx`, `role="status" aria-label="Carregando..."`) esteve presente no DOM
 * durante `action()`. Contagem, não booleano: sobrevive a piscadas de 1 frame que `toBeVisible()`
 * sozinho poderia perder por timing de polling.
 */
async function contarAparicoesDoSkeleton(page: Page, action: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __skeletonHits: number; __skeletonObserver: MutationObserver };
    w.__skeletonHits = 0;
    const check = () => {
      if (document.querySelector('[role="status"][aria-label="Carregando..."]')) w.__skeletonHits += 1;
    };
    const obs = new MutationObserver(check);
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    w.__skeletonObserver = obs;
    check();
  });
  await action();
  const hits = await page.evaluate(() => (window as unknown as { __skeletonHits: number }).__skeletonHits);
  await page.evaluate(() => (window as unknown as { __skeletonObserver: MutationObserver }).__skeletonObserver.disconnect());
  return hits;
}

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('Entrega A1 — refetch silencioso (item 1+4) e DiscardChangesConfirm no projeto terapêutico (item 7) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: FichaA1Seed;

  test.beforeAll(() => { seed = seedFichaA1Patient(); });
  test.afterAll(() => { cleanupPatientDeep(seed.patientId); });

  // ── Item 1+4 — usePatientDetail/usePatientVacancies: refetch NÃO liga isLoading ─────────────

  test('F1. editar "Información general" e salvar: o skeleton NUNCA aparece e o valor novo aparece no card', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Ficha A1');
    await page.goto(`/admin/patients/${seed.patientId}`);

    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 20_000 });
    const generalCard = page.getByTestId('patient-general-info-card');
    await expect(generalCard).toBeVisible();
    // Baseline: o seed gravou sexo FEMALE ("Femenino") — a troca para MALE ("Masculino") é o valor novo.
    await expect(page.getByTestId('patient-sex')).toContainText('Femenino');

    await page.getByTestId('edit-general-btn').click();
    const drawer = page.getByTestId('patient-general-edit-drawer');
    await expect(drawer).toBeVisible();
    await page.getByTestId('pge-sex').selectOption('MALE');

    const hits = await contarAparicoesDoSkeleton(page, async () => {
      // Identidade continua na tela DURANTE o save — se a página tivesse caído pro skeleton,
      // este locator sumiria no meio do `waitForResponse`.
      const identityStillThere = page.getByTestId('patient-identity-card');
      const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/general$/.test(r.url()));
      await page.getByTestId('pge-save').click();
      await expect(identityStillThere).toBeVisible();
      await saved;
      await expect(drawer).not.toBeVisible({ timeout: 10_000 });
    });

    expect(hits, 'skeleton NUNCA deve aparecer durante o refetch pós-save (item 1+4)').toBe(0);
    // O card atualiza NO LUGAR — sem troca de página, o novo valor chega pelo refetch silencioso.
    await expect(page.getByTestId('patient-sex')).toContainText('Masculino', { timeout: 10_000 });
  });

  test('A1. salvar outro card (Cobertura Médica): a mesma garantia — sem skeleton, card atualiza in-place', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Ficha A1');
    await page.goto(`/admin/patients/${seed.patientId}`);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();

    const coverageCard = page.getByTestId('cobertura-medica-card');
    await expect(coverageCard).toBeVisible({ timeout: 20_000 });
    // Baseline: seed não grava `insurance_informed` nem `health_insurance_name` — "Nombre de la
    // Cobertura" nasce vazio ("—"). Prova que o valor que aparecer depois veio do PATCH desta
    // edição, não de outra fonte (o GET prioriza `insurance_informed`, o campo do ClickUp).
    await expect(coverageCard).toContainText('—');

    await page.getByTestId('edit-coverage-btn').click();
    const drawer = page.getByTestId('patient-coverage-edit-drawer');
    await expect(drawer).toBeVisible();

    const novoNome = `Cobertura Humano ${seed.stamp}`;
    const campo = page.getByTestId('pcv-name');
    // Clique triplo seleciona a linha inteira (o `Meta+A` do macOS não é confiável no Chromium
    // headless) — depois digitar por cima substitui a seleção, como um humano faria.
    await campo.click({ clickCount: 3 });
    await expect(campo).toBeFocused();
    await page.keyboard.type(novoNome);
    await expect(campo).toHaveValue(novoNome);

    const hits = await contarAparicoesDoSkeleton(page, async () => {
      const generalCardStillThere = page.getByTestId('patient-general-info-card');
      const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/coverage$/.test(r.url()));
      await page.getByTestId('pcv-save').click();
      await expect(generalCardStillThere).toBeVisible();
      await saved;
      await expect(drawer).not.toBeVisible({ timeout: 10_000 });
    });

    expect(hits, 'skeleton NUNCA deve aparecer durante o refetch pós-save de outro card (A1)').toBe(0);
    await expect(coverageCard).toContainText(novoNome, { timeout: 10_000 });
  });

  test('A2. recarregar a página: o skeleton APARECE no load inicial — prova que o instrumento detecta skeleton de verdade', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Ficha A1');
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 20_000 });

    // O stack local é rápido demais para o `role="status"` sobreviver a um polling de
    // `toBeVisible()` pós-`reload()` (medido 15/09: `element(s) not found` — o skeleton já tinha
    // sumido antes do 1º poll). `addInitScript` liga o MESMO contador de `contarAparicoesDoSkeleton`
    // ANTES de qualquer script da página rodar, então ele não perde o 1º frame.
    await page.addInitScript(() => {
      const w = window as unknown as { __skeletonHits: number };
      w.__skeletonHits = 0;
      const check = () => {
        if (document.querySelector('[role="status"][aria-label="Carregando..."]')) w.__skeletonHits += 1;
      };
      const start = () => {
        new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        check();
      };
      if (document.documentElement) start();
      else document.addEventListener('DOMContentLoaded', start);
    });
    await page.reload();
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 20_000 });
    const hits = await page.evaluate(() => (window as unknown as { __skeletonHits: number }).__skeletonHits);
    expect(hits, 'o instrumento tem de VER o skeleton no load inicial — senão a ausência em F1/A1 não prova nada').toBeGreaterThan(0);
  });

  // ── Item 7 — TherapeuticProjectDrawer: DiscardChangesConfirm no lugar do window.confirm ────

  test('F1 (item 7). abrir o drawer, digitar, fechar pelo X: DiscardChangesConfirm aparece; confirmar descarte fecha e não salva', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Ficha A1');
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 10_000 });

    const texto = `Contexto clínico digitado por humano ${seed.stamp}`;
    expect(await digitar(page, 'tp-clinicalContext', texto)).toBe(texto);

    await page.getByTestId('therapeutic-project-close').click();
    await expect(page.getByTestId('discard-changes-confirm')).toBeVisible();

    await page.getByTestId('discard-changes-discard').click();
    await expect(page.getByTestId('discard-changes-confirm')).not.toBeVisible();
    await expect(drawer).not.toBeVisible({ timeout: 10_000 });

    // Nada foi salvo: nenhuma versão nova existe (a lista continua vazia — `tp-empty`).
    await expect(page.getByTestId('tp-empty')).toBeVisible();
  });

  test('A1 (item 7). abrir, digitar, fechar → "Seguir editando": o drawer continua aberto com o texto', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Ficha A1');
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 10_000 });

    const texto = `Não pode sumir ${seed.stamp}`;
    expect(await digitar(page, 'tp-clinicalContext', texto)).toBe(texto);

    // Gatilho diferente do F1 (que fecha pelo X): Escape. O drawer é LARGO (`max-w-6xl`) e o
    // sidebar fixo da esquerda também fica em `z-40` — não há ponto de clique no backdrop livre
    // dos dois ao mesmo tempo (medido 15/09: canto superior esquerdo cai sob o sidebar). Escape é
    // o mesmo gatilho que `TherapeuticProjectDrawer.tsx` liga a `requestClose` via listener global.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('discard-changes-confirm')).toBeVisible();

    await page.getByTestId('discard-changes-keep-editing').click();
    await expect(page.getByTestId('discard-changes-confirm')).not.toBeVisible();
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('tp-clinicalContext')).toHaveValue(texto);
  });

  test('A2 (item 7). abrir SEM digitar, fechar: fecha direto, sem confirmação', async ({ page }) => {
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Ficha A1');
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('tp-new-btn').click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('therapeutic-project-close').click();
    await expect(page.getByTestId('discard-changes-confirm')).toHaveCount(0);
    await expect(drawer).not.toBeVisible({ timeout: 10_000 });
  });
});
