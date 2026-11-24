/**
 * worker-completude-vitrine.integration.e2e.ts @integration
 *
 * O bug do Javi, na tela: a prestadora via "cadastro completo" e levava
 * "registro incompleto" ao se postular.
 *
 * Causa (D302): "cadastro completo" estava definido em SETE lugares, e a cópia
 * do frontend (`isStep1Complete`) omitia `phone` e `title_certificate`, que o
 * portão de REGISTERED exige. Medido em produção: 23 prestadoras nesse estado,
 * 18 delas envolvendo `title_certificate`.
 *
 * Este é o teste que NENHUMA camada sozinha faz. 5.785 unitários passaram
 * verdes com o defeito de pé, porque nenhuma cópia estava errada SOZINHA — o
 * erro só existia ENTRE elas. Aqui a pilha inteira roda: Postgres real com a
 * função `fn_worker_missing_fields`, a API real que a serve, e a tela real
 * decidindo o que a prestadora vê.
 *
 * O sinal observado (096: vagas na home só com cadastro completo) é o bloco genérico `complete-profile-notice` no lugar da lista
 * (`WorkerHome`, fonte `missingFields` de /me). Antes do conserto ele NÃO aparecia para quem faltava `title_certificate` — a
 * pessoa via a vitrine, era mandada ao WhatsApp e o portão a recusava depois. O banner antigo `complete-registration-banner`
 * (`JobsEmbeddedSection`) ficou inalcançável na home: nunca deve aparecer.
 *
 * Run: pnpm test:e2e:integration  (stack docker + `pnpm dev` — ver CLAUDE.md)
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

const BLOCK = '[data-testid="complete-profile-notice"]';
const OLD_BANNER = '[data-testid="complete-registration-banner"]';

test.describe('@integration Vitrine × portão — a tela não pode liberar quem o portão recusa', () => {
  test.setTimeout(120_000);
  const workers: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  async function entrar(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
    await page.goto('/');
    // Espera a home montar. O texto do card de progresso MUDA conforme a
    // completude (some no 100%), então esperar por ele enviesaria o controle —
    // a saudação está nos dois estados.
    await page.getByText(/página principal/i).first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    // E espera a decisão de completude chegar: sem isto, o controle poderia
    // medir a tela ANTES de o `missingFields` responder, quando o fail-closed
    // ainda mostra o aviso — e passaria por acidente.
    await page.waitForLoadState('networkidle');
  }

  // ── O caso do incidente: 18 das 23 travadas envolviam este campo ───────────
  test('sem título/certificado a home BLOQUEIA a vitrine e avisa que falta completar — não libera', async ({ page }) => {
    const w = insertEligibilityWorker({ titleCertificate: false });
    await entrar(page, w);

    // Antes do conserto: `isStep1Complete` devolvia true (a lista do frontend
    // não olhava `title_certificate`) e o aviso NÃO aparecia.
    await expect(page.locator(BLOCK)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#jobs-section')).toHaveCount(0);
    await expect(page.locator(OLD_BANNER)).toHaveCount(0);

    // Régua de pronto do enlite-frontend/CLAUDE.md: validação visual.
    await expect(page.locator(BLOCK)).toHaveScreenshot('vitrine-bloco-sem-titulo.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('sem telefone a home bloqueia a vitrine — o outro campo que a lista antiga ignorava', async ({ page }) => {
    // 129 cadastros ficaram com `workers.phone` nulo enquanto a tela dizia que
    // estava tudo certo.
    const w = insertEligibilityWorker({ phone: false });
    await entrar(page, w);

    await expect(page.locator(BLOCK)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#jobs-section')).toHaveCount(0);
  });

  // ── CONTROLE — sem ele, os dois acima passariam com a tela avisando SEMPRE,
  //    que é o defeito oposto e igualmente ruim (barrar quem pode postular).
  test('CONTROLE — cadastro completo vê a vitrine e NÃO recebe o bloqueio', async ({ page }) => {
    const w = insertEligibilityWorker();
    await entrar(page, w);

    // Âncora POSITIVA antes da ausência: sem ela o controle ficaria verde com a tela morta, que é o oposto de um controle.
    //
    // A âncora é a SEÇÃO (`#jobs-section`, que só existe no return final), não
    // um card de vaga: o CI não semeia vaga nenhuma, e um feed vazio é estado
    // legítimo. Ancorar no botão "Postularse" deixaria o controle vermelho por
    // ausência de dado, não por defeito — foi o blocker 1 da 3ª rodada do gate.
    await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 30_000 });

    await expect(page.locator(BLOCK)).toHaveCount(0);
    await expect(page.locator(OLD_BANNER)).toHaveCount(0);
  });

  // ── A outra metade da causa (R1): o telefone que não persistia ─────────────
  test('telefone digitado no perfil PERSISTE — não volta a sumir no reload', async ({ page }) => {
    // O laço das 129: o campo era mandado só quando "sujo", o backend fazia
    // COALESCE, o cliente gravava no store o que ELE mandou, e o store
    // (localStorage) preferia o local ao vazio do servidor. O número ficava na
    // tela para sempre e nunca chegava ao banco.
    const w = insertEligibilityWorker({ phone: false });
    await entrar(page, w);

    await page.goto('/worker/profile?tab=general');
    const campo = page.locator('#phone input').first();
    await campo.waitFor({ state: 'visible', timeout: 30_000 });

    const numero = `11${String(Date.now()).slice(-8)}`;
    await campo.click();
    await campo.type(numero, { delay: 30 });          // digitação real, não fill()
    await page.locator('#fullName').click();          // blur dispara o autosave
    await page.waitForTimeout(2000);

    // A prova NÃO é o campo continuar preenchido — era exatamente isso que o
    // defeito fazia. A prova é sobreviver ao reload, que relê do servidor.
    await page.reload();
    await campo.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(campo).toHaveValue(new RegExp(numero.slice(-6)));
  });
});
