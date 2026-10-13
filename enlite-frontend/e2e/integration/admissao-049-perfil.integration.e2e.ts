/**
 * admissao-049-perfil.integration.e2e.ts @integration — página Perfil (`/admin/mi-cuenta`), spec 049 (vínculo Tactiq) + tela nova.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL),
 * clique/teclado de humano (`loginAs`, `click`, `keyboard`, valor lido da tela). Só o login usa o dublê de sempre (JWT fake no
 * Identity Toolkit + `mock_*` na API). Nenhum canal real; dados sintéticos (e-mails @e2e.test).
 *
 *  feliz  — do menu lateral (clique no avatar+nome do rodapé) abre o Perfil: seções na ordem Identidad · Tactiq · Idioma ·
 *           Mis accesos, vínculo e extensão do Chrome vindos da API real, grupo do ator em "Mis accesos"; clica "Português"
 *           e a tela troca de idioma e a escolha SOBREVIVE ao reload (localStorage). Conta de e-mail/senha: sem a linha do Google.
 *  alt 1  — a rota antiga `/admin/mi-cuenta/tactiq?tactiq=error` redireciona para o Perfil PRESERVANDO a query: o banner de erro
 *           do retorno do OAuth aparece e a URL é limpa (F5 não repete).
 *  alt 2  — staff SEM `own_tactiq_link:read`: o Perfil abre, o cartão Tactiq NÃO existe no DOM (nem chamada ao vínculo) e a
 *           página segue simétrica (Identidad + Idioma | Mis accesos).
 *
 * ⚠️ Precisa do engine ABAC LIGADO (alt 2 mede AUSÊNCIA por falta de célula) — o nome carrega `admissao-049`, que já está no `--grep` do
 * job `integration-e2e-group-simulation` do `_frontend-integration.yml` (e NÃO no `pr-gate.yml`, que roda com o engine OFF).
 *
 * `toHaveScreenshot`: as baselines (`*-snapshots/*-darwin.png`) só se geram com o stack de pé (`--update-snapshots`, local, darwin);
 * o CI roda com `--ignore-snapshots`. Campos que mudam por rodada (nome/e-mail com RUN_ID, datas) vão MASCARADOS.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT, safeSql, psql } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const PERFIL = '/admin/mi-cuenta';
const PERFIL_ANTIGO = '/admin/mi-cuenta/tactiq';

test.describe('admissao-049 — página Perfil: seções, idioma, rota antiga e célula (tela nova) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  const mk = (nome: string) => {
    const uid = `e2e-049-perfil-${nome}-${RUN_ID}`;
    return { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };
  };
  const completa = mk('completa'); // own_tactiq_link:read + create, com vínculo `linked` semeado
  const semTactiq = mk('sem-tactiq'); // nenhuma célula own_tactiq_link
  const todas = [completa, semTactiq];
  const grupos: Record<string, string> = {};

  test.beforeAll(() => {
    for (const u of todas) {
      grupos[u.uid] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `Adm049 Perfil ${u.uid}`, country: 'AR' }).groupId;
    }
    grantCell(grupos[completa.uid], 'own_tactiq_link', 'read');
    grantCell(grupos[completa.uid], 'own_tactiq_link', 'create');
    psql(`INSERT INTO tactiq_links (host_email, firebase_uid, status, linked_at, last_check_at, last_check_outcome)
          VALUES ('${completa.email}', '${completa.uid}', 'linked', now() - interval '3 days', now() - interval '2 hours', 'ok')`);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM tactiq_links WHERE lower(host_email) = '${completa.email}'`);
    for (const u of todas) cleanupStaffAndGroup(u.uid, grupos[u.uid]);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm049 Perfil %${RUN_ID}'`);
  });

  /** O que muda por rodada (nome/e-mail com RUN_ID, datas): fica fora da comparação de pixels. */
  const mascaras = (page: Page) => [
    page.getByTestId('profile-identity'),
    page.getByTestId('tactiq-linked-at'),
    page.getByTestId('tactiq-last-check-at'),
    page.getByTestId('sidebar-profile-link'),
    page.getByTestId('profile-groups'),
  ];

  test('feliz: do rodapé da sidebar abre o Perfil, mostra as seções e o idioma escolhido sobrevive ao reload', async ({ page }, testInfo) => {
    await loginAs(page, completa); // termina em /admin/dashboard
    // A porta de entrada de verdade: avatar + nome no rodapé (um link, com o ícone de sair FORA dele).
    const entrada = page.getByTestId('sidebar-profile-link');
    await expect(entrada).toHaveAttribute('aria-label', /^Mi perfil — /);
    await expect(entrada.getByTestId('sidebar-profile-label')).toHaveText('Mi perfil');
    await entrada.click();
    await expect(page).toHaveURL(new RegExp(`${PERFIL}$`));

    await expect(page.getByTestId('my-profile-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('my-profile-page').getByRole('heading', { level: 2 })).toHaveText(['Identidad', 'Tactiq', 'Idioma', 'Mis accesos']);
    // Vínculo e extensão vêm do GET real. A extensão sem relatório (ou a API ainda sem o campo) lê "Sin información".
    await expect(page.getByTestId('tactiq-state')).toHaveText('Vinculado');
    await expect(page.getByTestId('tactiq-linked-at')).not.toHaveText('—');
    await expect(page.getByTestId('tactiq-extension-state')).toBeVisible();
    // O grupo do ator (semeado por SQL) aparece em "Mis accesos"; a lista crua de células nunca.
    await expect(page.getByTestId('profile-groups')).toContainText(`Adm049 Perfil ${completa.uid}`);
    await expect(page.getByTestId('profile-country-AR')).toHaveText('Argentina');
    await expect(page.locator('body')).not.toContainText('own_tactiq_link:read');
    // Conta de e-mail/senha: nome e foto NÃO vêm do Google, então a linha não existe.
    await expect(page.getByTestId('profile-google-note')).toHaveCount(0);
    await expect(page.getByTestId('profile-logout')).toBeVisible();

    await expect(page).toHaveScreenshot('perfil-feliz.png', { mask: mascaras(page), maxDiffPixelRatio: 0.002 });
    await page.screenshot({ path: testInfo.outputPath('1-perfil-feliz.png') });

    // Idioma: clique de humano; a tela troca na hora e a escolha fica no navegador.
    await page.getByTestId('language-pt-BR').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Meu perfil');
    await expect(page.getByTestId('language-pt-BR')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.localStorage.getItem('i18nextLng'))).toBe('pt-BR');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Meu perfil');
    await page.getByTestId('language-es').click(); // devolve ao padrão (o navegador é novo a cada teste, mas o describe é serial)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mi perfil');
  });

  test('alt 1: a rota antiga /admin/mi-cuenta/tactiq redireciona ao Perfil preservando ?tactiq= (banner do retorno do OAuth, URL limpa)', async ({ page }, testInfo) => {
    await loginAs(page, completa);
    await page.goto(`${PERFIL_ANTIGO}?tactiq=error&reason=exchange_failed`);
    await expect(page.getByTestId('tactiq-banner-error')).toHaveText('No pudimos completar la vinculación con Tactiq. Probá de nuevo.');
    await expect(page.getByTestId('tactiq-banner-linked')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${PERFIL}$`)); // chegou ao Perfil e a query foi consumida (F5 não repete o erro)
    await expect(page.locator('body')).not.toContainText('exchange_failed'); // o motivo cru nunca aparece
    await page.screenshot({ path: testInfo.outputPath('2-perfil-alt1-retorno-erro.png') });
    await expect(page).toHaveScreenshot('perfil-retorno-erro.png', { mask: mascaras(page), maxDiffPixelRatio: 0.002 });
    await page.reload();
    await expect(page.getByTestId('tactiq-state')).toBeVisible();
    await expect(page.getByTestId('tactiq-banner-error')).toHaveCount(0);
  });

  test('alt 2: sem own_tactiq_link:read o Perfil abre sem o cartão Tactiq e continua simétrico (Identidad + Idioma | Mis accesos)', async ({ page }, testInfo) => {
    await loginAs(page, semTactiq);
    await page.goto(PERFIL);
    await expect(page.getByTestId('my-profile-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('my-profile-page').getByRole('heading', { level: 2 })).toHaveText(['Identidad', 'Idioma', 'Mis accesos']); // controle positivo: a página abriu
    await expect(page.getByTestId('tactiq-link-page')).toHaveCount(0);
    await expect(page.getByTestId('tactiq-link-button')).toHaveCount(0);
    // Simetria: as duas colunas da linha 3 têm a mesma largura e a mesma altura (a grade as estica).
    const idioma = await page.getByTestId('profile-language').boundingBox();
    const accesos = await page.getByTestId('profile-access').boundingBox();
    expect(Math.abs((idioma?.width ?? 0) - (accesos?.width ?? -1))).toBeLessThanOrEqual(1);
    expect(Math.abs((idioma?.height ?? 0) - (accesos?.height ?? -1))).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('3-perfil-alt2-sem-tactiq.png') });
    await expect(page).toHaveScreenshot('perfil-sem-tactiq.png', { mask: mascaras(page), maxDiffPixelRatio: 0.002 });
  });
});
