/**
 * area-membership-admin @integration — a ABA "Vínculos de área" da `/admin/access` (change aba-vinculos-de-area, T3; antes: a seção
 * "Vínculos de área" do acesso-do-cliente F4/T415).
 *
 * Engine ABAC LIGADO, staff REAL em grupo (células por fixture SQL, no padrão de `abac-stack-helper`), API e banco reais.
 * Sem `page.route` de DADO: só o Auth do Firebase é forjado e o `Authorization` é trocado por `mock_*` em `/api/**` e
 * `/v1/me/areas` (`loginAs`). Busca e motivo por click + `keyboard.type` (nunca `fill`); o vínculo é lido de volta pela
 * TELA (chip na linha, painel lateral) e pelo BANCO (`iam.area_membership`).
 * Pessoas-alvo sintéticas: PRESTADORES semeados (`workers.auth_uid` = uid do login, e-mail `@ejemplo.com`) — só assim entram na
 * lista (população = staff ∪ prestador ∪ quem já tem vínculo). Sem dado pessoal nem clínico.
 *
 *  feliz        staff com `area_membership:read|write` busca a pessoa por e-mail, abre "Gestionar", concede learn·learner no painel,
 *               vê o chip na linha e revoga com motivo; banco confere concessão e revogação
 *  alternativo1 revogar sem motivo: o botão de confirmar fica bloqueado e NADA é gravado (contagem no banco igual)
 *  alternativo2 só `area_membership:read`: entra na página, vê só a aba Vínculos, sem "Gestionar" e com o aviso de só leitura;
 *               `permission_management` SEM `area_membership`: a aba Vínculos NÃO existe no DOM (D269), Grupos visível, e a URL
 *               da aba redireciona para Grupos
 *
 * ⚠️ Precisa do engine ligado (com ele OFF `cells===null` mostra tudo e o alt 2 ficaria verde sem medir nada): o token
 * `area-membership-admin` entra no `--grep` do job ABAC (`group-simulation`) do `_frontend-integration.yml`, não no do `pr-gate.yml`.
 * `iam.area_membership` é append-only (DELETE recusado por trigger): a limpeza usa `session_replication_role = replica` como dono.
 * Screenshots: baseline em `area-membership-admin.integration.e2e.ts-snapshots/`; o CI roda com `--ignore-snapshots` (não compara).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, safeSql, scalar, seedStaffInGroup, type MockUser,
} from '../helpers/abac-stack-helper';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const mk = (nome: string): MockUser => ({ uid: `e2e-amb-${nome}-${RUN}`, email: `amb.${nome}.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' });
const GESTOR = mk('gestor'); // permission_management + area_membership:read|write
const LEITOR = mk('leitor'); // SÓ area_membership:read
const SEM_CELULA = mk('semcelula'); // permission_management, SEM area_membership
const ALVO_FELIZ = `e2e-amb-alvo-feliz-${RUN}`;
const ALVO_ALT1 = `e2e-amb-alvo-alt1-${RUN}`;
const emailDe = (uid: string): string => `${uid}@ejemplo.com`;
const MOTIVO = 'Motivo de teste e2e';
const grupos: Record<string, string> = {};

/**
 * Conta REAL no emulador, no projeto que a API consulta: conceder/revogar recalcula o claim `areas` em cada login vivo da pessoa
 * (`admin.auth().getUser`); sem a conta a API recusa com 422. Mesmo molde de `unified-login.integration.e2e.ts`.
 */
async function contaNoEmulador(uid: string): Promise<void> {
  const emulator = process.env.E2E_FIREBASE_EMULATOR ?? 'http://127.0.0.1:9099';
  const projeto = process.env.E2E_API_FIREBASE_PROJECT ?? 'enlite-e2e-test';
  const res = await fetch(`${emulator}/identitytoolkit.googleapis.com/v1/projects/${projeto}/accounts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ email: emailDe(uid), password: 'TestAdmin123!', localId: uid }),
  });
  expect(res.ok, `conta ${uid} não criada no emulador`).toBe(true);
}

const pessoaDe = (uid: string): string => scalar(`SELECT iam.ensure_person('firebase', '${uid}')`);
const contar = (pessoa: string, so: 'todos' | 'vivos' | 'revogados'): string =>
  scalar(
    `SELECT count(*) FROM iam.area_membership WHERE person_id = '${pessoa}'` +
      (so === 'vivos' ? ' AND revoked_at IS NULL' : so === 'revogados' ? ' AND revoked_at IS NOT NULL' : ''),
  );
const estado = (pessoa: string) => ({ todos: contar(pessoa, 'todos'), vivos: contar(pessoa, 'vivos'), revogados: contar(pessoa, 'revogados') });

async function abrirAba(page: Page, u: MockUser): Promise<void> {
  await loginAs(page, u);
  await page.goto('/admin/access');
  await expect(page.getByTestId('access-groups-header')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('access-tab-area-memberships').click();
  await expect(page).toHaveURL(/\/admin\/access\/area-memberships$/);
  await expect(page.getByTestId('area-memberships-section')).toBeVisible({ timeout: 20_000 });
}

/** Busca como o staff faz: clica no campo, digita o e-mail inteiro (modo e-mail, sem mínimo de caracteres) e espera a linha. */
async function buscar(page: Page, email: string) {
  const campo = page.getByTestId('area-people-search');
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(email);
  await expect(campo).toHaveValue(email);
  const linha = page.getByTestId('area-person-row').filter({ hasText: email });
  await expect(linha).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId('area-person-row')).toHaveCount(1); // a busca isolou a pessoa
  return linha;
}

/** Máscara do que varia por execução (nome/e-mail levam o RUN). */
const dadosVariaveis = (page: Page) => [page.locator('[data-testid="area-person-row"] td:nth-child(-n+2)')];

test.describe('aba Vínculos de área da /admin/access — conceder, revogar com motivo e guarda por célula @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeAll(async ({ request }) => {
    grupos.gestor = seedStaffInGroup({ uid: GESTOR.uid, email: GESTOR.email, groupName: `Amb gestor ${RUN}`, country: 'AR' }).groupId;
    grupos.leitor = seedStaffInGroup({ uid: LEITOR.uid, email: LEITOR.email, groupName: `Amb leitor ${RUN}`, country: 'AR' }).groupId;
    grupos.semCelula = seedStaffInGroup({ uid: SEM_CELULA.uid, email: SEM_CELULA.email, groupName: `Amb semcelula ${RUN}`, country: 'AR' }).groupId;
    for (const g of [grupos.gestor, grupos.semCelula]) {
      grantCell(g, 'permission_management', 'read');
      grantCell(g, 'permission_management', 'write');
    }
    grantCell(grupos.gestor, 'area_membership', 'read');
    grantCell(grupos.gestor, 'area_membership', 'write');
    grantCell(grupos.leitor, 'area_membership', 'read');
    await pollAuthz(request, GESTOR, (b) => b?.permissions?.includes('area_membership:write') && b?.permissions?.includes('permission_management:read'));
    await pollAuthz(request, LEITOR, (b) => b?.permissions?.includes('area_membership:read'));
    await pollAuthz(request, SEM_CELULA, (b) => b?.permissions?.includes('permission_management:read'));
    for (const uid of [ALVO_FELIZ, ALVO_ALT1]) {
      await contaNoEmulador(uid);
      pessoaDe(uid);
      scalar(`INSERT INTO workers (auth_uid, email, country) VALUES ('${uid}', '${emailDe(uid)}', 'AR') RETURNING id`);
    }
  });

  test.afterAll(() => {
    const pessoas = `(SELECT person_id FROM iam.person_login WHERE uid IN ('${ALVO_FELIZ}', '${ALVO_ALT1}'))`;
    // append-only: DELETE só passa com os triggers de usuário desligados na sessão (dono do banco)
    safeSql(`SET session_replication_role = replica; DELETE FROM iam.area_membership WHERE person_id IN ${pessoas}`);
    safeSql(`DELETE FROM workers WHERE auth_uid IN ('${ALVO_FELIZ}', '${ALVO_ALT1}')`);
    cleanupStaffAndGroup(GESTOR.uid, grupos.gestor ?? '');
    cleanupStaffAndGroup(LEITOR.uid, grupos.leitor ?? '');
    cleanupStaffAndGroup(SEM_CELULA.uid, grupos.semCelula ?? '');
  });

  test('feliz: staff com a célula busca a pessoa, concede learn·learner no painel e revoga com motivo — lido pela tela e pelo banco', async ({ page }) => {
    const pessoa = pessoaDe(ALVO_FELIZ);
    expect(contar(pessoa, 'todos')).toBe('0'); // controle: nasce sem vínculo
    await abrirAba(page, GESTOR);
    const linha = await buscar(page, emailDe(ALVO_FELIZ));
    await expect(linha.getByTestId('area-person-kind')).toHaveAttribute('data-kind', 'worker');
    await expect(linha.getByTestId('area-membership-chip')).toHaveCount(0);
    await expect(page.getByTestId('people-card')).toHaveScreenshot('area-membership-admin-lista.png', {
      mask: dadosVariaveis(page), animations: 'disabled', maxDiffPixelRatio: 0.02,
    });

    // painel lateral "Gestionar"
    await linha.getByTestId('area-person-manage').click();
    const painel = page.getByTestId('area-person-drawer');
    await expect(painel).toBeVisible();
    await expect(painel.getByTestId('area-drawer-none')).toBeVisible();
    await expect(painel).toHaveScreenshot('area-membership-admin-painel.png', {
      mask: [painel.locator('> div').first()], animations: 'disabled', maxDiffPixelRatio: 0.02,
    });

    // conceder learn · learner
    const form = painel.getByTestId('area-drawer-grant-form');
    await form.getByLabel('Área').click();
    await page.getByRole('option', { name: 'Learn' }).click();
    await form.getByLabel('Rol').click();
    await page.getByRole('option', { name: 'Alumno/a' }).click();
    await form.getByTestId('area-grant-submit').click();
    await expect(painel.getByTestId('area-drawer-membership')).toHaveCount(1, { timeout: 20_000 }); // painel (TELA)
    await expect(linha.getByTestId('area-membership-chip')).toHaveCount(1, { timeout: 20_000 }); // chip na linha da lista (TELA)
    await expect(linha.getByTestId('area-membership-chip')).toContainText('Alumno/a');
    expect(scalar(`SELECT area || '/' || role || '/' || (revoked_at IS NULL) FROM iam.area_membership WHERE person_id = '${pessoa}'`)).toBe('learn/learner/true'); // BANCO

    // revogar com motivo
    await painel.getByTestId('area-drawer-revoke').click();
    const revoga = painel.getByTestId('area-drawer-revoke-form');
    const motivo = revoga.getByTestId('area-revoke-reason');
    await motivo.click();
    await expect(motivo).toBeFocused();
    await page.keyboard.type(MOTIVO);
    await expect(motivo).toHaveValue(MOTIVO);
    await revoga.getByTestId('area-revoke-confirm').click();
    await expect(painel.getByTestId('area-drawer-none')).toBeVisible({ timeout: 20_000 }); // some dos vivos (TELA)
    await expect(linha.getByTestId('area-membership-chip')).toHaveCount(0, { timeout: 20_000 });
    expect(contar(pessoa, 'vivos')).toBe('0');
    expect(scalar(`SELECT (revoked_at IS NOT NULL) || '/' || reason FROM iam.area_membership WHERE person_id = '${pessoa}'`)).toBe(`true/${MOTIVO}`);
  });

  test('alternativo 1: revogar sem motivo — o botão fica bloqueado e nada é gravado', async ({ page }) => {
    const pessoa = pessoaDe(ALVO_ALT1);
    scalar(`SELECT iam.grant_area_membership('${pessoa}', 'learn', 'learner', 'e2e-amb')`);
    const antes = estado(pessoa);
    expect(antes).toEqual({ todos: '1', vivos: '1', revogados: '0' });

    await abrirAba(page, GESTOR);
    const linha = await buscar(page, emailDe(ALVO_ALT1));
    await expect(linha.getByTestId('area-membership-chip')).toHaveCount(1); // a lista mostra o vínculo vivo
    await linha.getByTestId('area-person-manage').click();
    const painel = page.getByTestId('area-person-drawer');
    await painel.getByTestId('area-drawer-revoke').click();
    const revoga = painel.getByTestId('area-drawer-revoke-form');
    const confirmar = revoga.getByTestId('area-revoke-confirm');
    await expect(confirmar).toBeDisabled(); // vazio
    const motivo = revoga.getByTestId('area-revoke-reason');
    await motivo.click();
    await page.keyboard.type('   '); // só espaços também não vale
    await expect(confirmar).toBeDisabled();
    await confirmar.click({ force: true }); // forçar o clique não pode gravar
    await page.waitForTimeout(1_000);

    expect(estado(pessoa)).toEqual(antes);
    await expect(painel.getByTestId('area-drawer-membership')).toHaveCount(1); // a tela ainda mostra o vínculo vivo
  });

  test('alternativo 2a: só `area_membership:read` — entra na página, vê só a aba Vínculos, sem "Gestionar" e com o aviso de só leitura', async ({ page }) => {
    await loginAs(page, LEITOR);
    await page.goto('/admin/access'); // sem permission_management: a moldura leva para a aba que o ator pode ver
    await expect(page).toHaveURL(/\/admin\/access\/area-memberships$/, { timeout: 30_000 });
    await expect(page.getByTestId('area-memberships-section')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('access-tab-area-memberships')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Grupos', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('read-only-notice')).toBeVisible();
    // vê a lista (ao menos os staff semeados) e os vínculos nos chips, mas nenhuma ação
    const linha = await buscar(page, emailDe(ALVO_ALT1));
    await expect(linha.getByTestId('area-membership-chip')).toHaveCount(1);
    await expect(page.getByTestId('area-person-manage')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Gestionar/ })).toHaveCount(0);
    await expect(page.getByTestId('area-person-drawer')).toHaveCount(0);
  });

  test('alternativo 2b: `permission_management` e SEM `area_membership` — a aba Vínculos NÃO existe no DOM e os Grupos seguem visíveis', async ({ page }) => {
    await loginAs(page, SEM_CELULA);
    await page.goto('/admin/access');
    await expect(page.getByTestId('access-groups-header')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Grupos', exact: true })).toBeVisible();
    await expect(page.getByTestId('access-tab-area-memberships')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Vínculos de área' })).toHaveCount(0);
    // a URL da aba não é porta: redireciona para Grupos
    await page.goto('/admin/access/area-memberships');
    await expect(page).toHaveURL(/\/admin\/access\/?$/, { timeout: 20_000 });
    await expect(page.getByTestId('area-memberships-section')).toHaveCount(0);
    await expect(page.getByTestId('area-people-search')).toHaveCount(0);
  });
});
