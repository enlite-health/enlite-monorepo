/**
 * tactiq-vinculo-acesso.integration.e2e.ts @integration — "Mi perfil" explica a negativa de acesso do vínculo Tactiq a partir do
 * ESTADO SALVO (change `tactiq-vinculo-valida-acesso`, F3; design D7/D8).
 *
 * E2E DE TELA, sem `page.route` de dado: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL),
 * clique/teclado de humano (`loginAs`) e texto lido da tela. A negativa é semeada na TRILHA (`admission_events`, só-acréscimo) com o
 * kind/outcome/reason que o `TactiqLinkService.completeLink` grava (`tactiq_link.link_rejected` / `access_denied` /
 * `access_action:<v>`). Nenhum canal real: o OAuth do Tactiq não é tocado; "vínculo com sucesso" é o desfecho que ele grava
 * (`tactiq_link.linked` + linha em `tactiq_links`), semeado por SQL. E-mails @e2e.test, dado sintético.
 *
 *  feliz  — negativa `access_action:request_seat` na trilha: "Mi perfil" mostra a orientação de assento (sem o código), e o reload a mantém
 *           (vem do estado salvo, não da URL).
 *  alt 1  — negativa genérica COM título + `?tactiq=error&reason=…` na URL: aparece a orientação com o título como texto, SEM o banner
 *           genérico e sem ecoar nenhum código.
 *  alt 2  — negativa seguida de vínculo com sucesso (evento `linked` mais novo): a orientação some e o estado lê "Vinculado".
 *
 * ⚠️ Precisa do engine ABAC LIGADO e do `abac-stack-helper`: o título do describe carrega `admissao-049`, que já está no `--grep` do job
 * `integration-e2e-group-simulation` do `_frontend-integration.yml` (o grep casa também com o título; o `pr-gate.yml` roda com o engine OFF).
 * Eventos `tactiq_link.*` NUNCA se apagam (trigger append-only, migration 504): o e-mail com RUN_ID isola cada rodada.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT, safeSql, psql } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const PERFIL = '/admin/mi-cuenta';
const TITULO = 'Plan sin acceso a resúmenes';
/** O texto da orientação de assento vem do `es.json` REAL (F3 trocou `accessSeat` por `seatAuto|seatWait|seatAskAdmin`; sem aviso ao administrador na seed → `seatAskAdmin`). */
const SEAT_ASK_ADMIN = (JSON.parse(readFileSync(fileURLToPath(new URL('../../src/infrastructure/i18n/locales/es.json', import.meta.url)), 'utf8')) as { admin: { tactiqLink: { seatAskAdmin: string } } }).admin.tactiqLink.seatAskAdmin;

test.describe('admissao-049 — vínculo Tactiq: orientação de acesso negado a partir do estado salvo (tela) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  const mk = (nome: string) => {
    const uid = `e2e-tactiq-acesso-${nome}-${RUN_ID}`;
    return { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };
  };
  const assento = mk('assento');
  const generica = mk('generica');
  const resolvida = mk('resolvida');
  const todas = [assento, generica, resolvida];
  const grupos: Record<string, string> = {};

  const negativa = (email: string, reason: string, ref: Record<string, unknown>, quando: string) =>
    psql(`INSERT INTO admission_events (host_email, kind, outcome, reason, ref, at)
          VALUES ('${email}', 'tactiq_link.link_rejected', 'access_denied', '${reason}', '${JSON.stringify(ref)}'::jsonb, ${quando})`);

  test.beforeAll(() => {
    for (const u of todas) {
      grupos[u.uid] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `TactiqAcesso ${u.uid}`, country: 'AR' }).groupId;
      grantCell(grupos[u.uid], 'own_tactiq_link', 'read');
      grantCell(grupos[u.uid], 'own_tactiq_link', 'create');
    }
    negativa(assento.email, 'access_action:request_seat', { scope: ['own'] }, "now() - interval '1 hour'");
    negativa(generica.email, 'access_action:upgrade', { scope: ['own'], title: TITULO }, "now() - interval '1 hour'");
    // `resolvida`: negou antes e depois vinculou com acesso provado (o `linked` é o evento MAIS NOVO).
    negativa(resolvida.email, 'access_action:request_seat', { scope: ['own'] }, "now() - interval '2 hours'");
    psql(`INSERT INTO admission_events (host_email, kind, outcome, ref, at)
          VALUES ('${resolvida.email}', 'tactiq_link.linked', 'linked', '{"scope":["own","details"]}'::jsonb, now() - interval '1 hour')`);
    psql(`INSERT INTO tactiq_links (host_email, firebase_uid, status, linked_at, last_check_at, last_check_outcome)
          VALUES ('${resolvida.email}', '${resolvida.uid}', 'linked', now() - interval '1 hour', now() - interval '1 hour', 'ok')`);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM tactiq_links WHERE lower(host_email) = '${resolvida.email}'`);
    for (const u of todas) cleanupStaffAndGroup(u.uid, grupos[u.uid]);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'TactiqAcesso %${RUN_ID}'`);
  });

  test('feliz: negativa de assento na trilha → "Mi perfil" mostra a orientação (sem o código) e o reload a mantém', async ({ page }, testInfo) => {
    await loginAs(page, assento);
    await page.getByTestId('sidebar-profile-link').click();
    await expect(page).toHaveURL(new RegExp(`${PERFIL}$`));
    const caixa = page.getByTestId('tactiq-access-denial');
    await expect(caixa).toBeVisible({ timeout: 30_000 });
    await expect(caixa).toContainText(SEAT_ASK_ADMIN);
    await expect(caixa).toContainText('Ana Joulie, Javier o Marcel');
    expect((await caixa.innerText()).replace(/\s+/g, ' '), 'a orientação de assento não manda vincular').not.toMatch(/vincular/i);
    await expect(page.getByTestId('tactiq-banner-error')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('request_seat');
    await expect(page.locator('body')).not.toContainText('access_action');
    await page.screenshot({ path: testInfo.outputPath('1-acesso-assento.png') });

    await page.reload(); // URL sem query: o texto vem do estado salvo
    await expect(page.getByTestId('tactiq-access-denial')).toContainText(SEAT_ASK_ADMIN, { timeout: 30_000 });
  });

  test('alt 1: negativa genérica com título + ?tactiq=error → orientação com o título como texto, sem banner genérico nem código', async ({ page }, testInfo) => {
    await loginAs(page, generica);
    await page.goto(`${PERFIL}?tactiq=error&reason=access_denied`);
    const caixa = page.getByTestId('tactiq-access-denial');
    await expect(caixa).toContainText(`«${TITULO}»`, { timeout: 30_000 });
    await expect(caixa).toContainText('Tactiq indicó que tu cuenta no tiene acceso');
    await expect(page.getByTestId('tactiq-banner-error')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('access_denied');
    await expect(page.locator('body')).not.toContainText('access_action');
    await expect(page).toHaveURL(new RegExp(`${PERFIL}$`)); // a query foi consumida
    await page.screenshot({ path: testInfo.outputPath('2-acesso-generica.png') });
  });

  test('alt 2: negativa seguida de vínculo com sucesso → a orientação some e o estado lê "Vinculado"', async ({ page }, testInfo) => {
    await loginAs(page, resolvida);
    await page.goto(PERFIL);
    await expect(page.getByTestId('tactiq-state')).toHaveText('Vinculado', { timeout: 30_000 }); // controle positivo: a tela carregou o estado
    await expect(page.getByTestId('tactiq-access-denial')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(SEAT_ASK_ADMIN);
    await page.screenshot({ path: testInfo.outputPath('3-acesso-resolvida.png') });
  });
});
