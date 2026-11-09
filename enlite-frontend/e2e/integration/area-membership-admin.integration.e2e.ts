/**
 * area-membership-admin @integration — a seção "Vínculos de área" da `/admin/access` (acesso-do-cliente, F4, T415, direção A).
 *
 * Engine ABAC LIGADO, staff REAL em grupo (células por fixture SQL, no padrão de `abac-stack-helper`), API e banco reais.
 * Sem `page.route` de DADO: só o Auth do Firebase é forjado e o `Authorization` é trocado por `mock_*` em `/api/**` e
 * `/v1/me/areas` (`loginAs`). Busca e motivo por click + `keyboard.type`; o vínculo é lido de volta pela TELA e pelo BANCO.
 * Pessoa-alvo sintética (uid `e2e-amb-*`), sem dado pessoal nem clínico.
 *
 *  feliz        staff com `area_membership:read|write` busca a pessoa, concede learn·learner e revoga com motivo
 *  alternativo1 revogar sem motivo: o botão de confirmar fica bloqueado e NADA é gravado (contagem no banco igual)
 *  alternativo2 staff com `permission_management` e SEM `area_membership`: a seção de vínculos NÃO existe no DOM (D269) e a
 *               lista de Grupos continua visível
 *
 * ⚠️ Precisa do engine ligado (com ele OFF `cells===null` mostra tudo e o alt 2 ficaria verde sem medir nada): o token
 * `area-membership-admin` entra no `--grep` do job ABAC (`group-simulation`) do `_frontend-integration.yml`, não no do `pr-gate.yml`.
 * `iam.area_membership` é append-only (DELETE recusado por trigger): a limpeza usa `session_replication_role = replica` como dono.
 */
import { test, expect, type Page } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-c-helper';
import {
  cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, safeSql, seedStaffInGroup, type MockUser,
} from '../helpers/abac-stack-helper';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const mk = (nome: string): MockUser => ({ uid: `e2e-amb-${nome}-${RUN}`, email: `amb.${nome}.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' });
const GESTOR = mk('gestor'); // permission_management + area_membership:read|write
const SEM_CELULA = mk('semcelula'); // permission_management, SEM area_membership
const ALVO_FELIZ = `e2e-amb-alvo-feliz-${RUN}`;
const ALVO_ALT1 = `e2e-amb-alvo-alt1-${RUN}`;
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
    body: JSON.stringify({ email: `${uid}@e2e.test`, password: 'TestAdmin123!', localId: uid }),
  });
  expect(res.ok, `conta ${uid} não criada no emulador`).toBe(true);
}

const pessoaDe = (uid: string): string => runSQL(`SELECT iam.ensure_person('firebase', '${uid}')`);
const contar = (pessoa: string, so: 'todos' | 'vivos' | 'revogados'): string =>
  runSQL(
    `SELECT count(*) FROM iam.area_membership WHERE person_id = '${pessoa}'` +
      (so === 'vivos' ? ' AND revoked_at IS NULL' : so === 'revogados' ? ' AND revoked_at IS NOT NULL' : ''),
  );

async function abrirAccess(page: Page, u: MockUser): Promise<void> {
  await loginAs(page, u);
  await page.goto('/admin/access');
  await expect(page.getByTestId('access-groups-header')).toBeVisible({ timeout: 30_000 });
}

/** Busca por UID de login, como o staff faz: escolhe o modo, clica no campo, digita, clica em Buscar. */
async function buscarPorUid(page: Page, uid: string): Promise<void> {
  const secao = page.getByTestId('area-memberships-section');
  await expect(secao).toBeVisible({ timeout: 20_000 });
  await secao.getByLabel('Buscar por').selectOption({ label: 'UID de login' });
  const campo = secao.getByLabel('Valor');
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(uid);
  await expect(campo).toHaveValue(uid);
  await secao.getByRole('button', { name: 'Buscar' }).click();
}

test.describe('vínculos de área na /admin/access — conceder, revogar com motivo e guarda por célula @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeAll(async ({ request }) => {
    grupos.gestor = seedStaffInGroup({ uid: GESTOR.uid, email: GESTOR.email, groupName: `Amb gestor ${RUN}`, country: 'AR' }).groupId;
    grupos.semCelula = seedStaffInGroup({ uid: SEM_CELULA.uid, email: SEM_CELULA.email, groupName: `Amb semcelula ${RUN}`, country: 'AR' }).groupId;
    for (const g of [grupos.gestor, grupos.semCelula]) {
      grantCell(g, 'permission_management', 'read');
      grantCell(g, 'permission_management', 'write');
    }
    grantCell(grupos.gestor, 'area_membership', 'read');
    grantCell(grupos.gestor, 'area_membership', 'write');
    await pollAuthz(request, GESTOR, (b) => b?.permissions?.includes('area_membership:write') && b?.permissions?.includes('permission_management:read'));
    await pollAuthz(request, SEM_CELULA, (b) => b?.permissions?.includes('permission_management:read'));
    for (const uid of [ALVO_FELIZ, ALVO_ALT1]) {
      await contaNoEmulador(uid);
      pessoaDe(uid);
    }
  });

  test.afterAll(() => {
    const pessoas = `(SELECT person_id FROM iam.person_login WHERE uid IN ('${ALVO_FELIZ}', '${ALVO_ALT1}'))`;
    // append-only: DELETE só passa com os triggers de usuário desligados na sessão (dono do banco)
    safeSql(`SET session_replication_role = replica; DELETE FROM iam.area_membership WHERE person_id IN ${pessoas}`);
    cleanupStaffAndGroup(GESTOR.uid, grupos.gestor ?? '');
    cleanupStaffAndGroup(SEM_CELULA.uid, grupos.semCelula ?? '');
  });

  test('feliz: staff com a célula busca a pessoa, concede learn·learner e revoga com motivo — lido pela tela e pelo banco', async ({ page }) => {
    const pessoa = pessoaDe(ALVO_FELIZ);
    expect(contar(pessoa, 'todos')).toBe('0'); // controle: nasce sem vínculo
    await abrirAccess(page, GESTOR);
    await buscarPorUid(page, ALVO_FELIZ);
    const secao = page.getByTestId('area-memberships-section');
    await expect(secao.getByText('Esta persona no tiene vínculos vivos.')).toBeVisible({ timeout: 20_000 });

    // conceder learn · learner
    const form = page.getByTestId('area-membership-grant-form');
    await form.getByLabel('Área').selectOption({ label: 'Learn' });
    await form.getByLabel('Rol').selectOption({ label: 'Alumno/a' });
    await form.getByRole('button', { name: 'Conceder' }).click();
    const linha = secao.getByRole('row').filter({ hasText: 'Learn' }).filter({ hasText: 'Alumno/a' });
    await expect(linha).toHaveCount(1, { timeout: 20_000 }); // lido pela TELA
    expect(runSQL(`SELECT area || '/' || role || '/' || (revoked_at IS NULL) FROM iam.area_membership WHERE person_id = '${pessoa}'`)).toBe('learn/learner/true'); // e pelo BANCO

    // revogar com motivo
    await linha.getByRole('button', { name: 'Revocar' }).click();
    const revoga = page.getByTestId('area-membership-revoke-form');
    const motivo = revoga.getByLabel('Motivo de la revocación (obligatorio)');
    await motivo.click();
    await expect(motivo).toBeFocused();
    await page.keyboard.type(MOTIVO);
    await expect(motivo).toHaveValue(MOTIVO);
    await revoga.getByRole('button', { name: 'Confirmar revocación' }).click();
    await expect(secao.getByText('Esta persona no tiene vínculos vivos.')).toBeVisible({ timeout: 20_000 }); // tela: some dos vivos
    expect(contar(pessoa, 'vivos')).toBe('0');
    expect(runSQL(`SELECT (revoked_at IS NOT NULL) || '/' || reason FROM iam.area_membership WHERE person_id = '${pessoa}'`)).toBe(`true/${MOTIVO}`);
  });

  test('alternativo 1: revogar sem motivo — o botão fica bloqueado e nada é gravado', async ({ page }) => {
    const pessoa = pessoaDe(ALVO_ALT1);
    runSQL(`SELECT iam.grant_area_membership('${pessoa}', 'learn', 'learner', 'e2e-amb')`);
    const antes = { todos: contar(pessoa, 'todos'), vivos: contar(pessoa, 'vivos'), revogados: contar(pessoa, 'revogados') };
    expect(antes).toEqual({ todos: '1', vivos: '1', revogados: '0' });

    await abrirAccess(page, GESTOR);
    await buscarPorUid(page, ALVO_ALT1);
    const secao = page.getByTestId('area-memberships-section');
    await secao.getByRole('button', { name: 'Revocar' }).click();
    const revoga = page.getByTestId('area-membership-revoke-form');
    const confirmar = revoga.getByRole('button', { name: 'Confirmar revocación' });
    await expect(confirmar).toBeDisabled(); // vazio
    const motivo = revoga.getByLabel('Motivo de la revocación (obligatorio)');
    await motivo.click();
    await page.keyboard.type('   '); // só espaços também não vale
    await expect(confirmar).toBeDisabled();
    await confirmar.click({ force: true }); // forçar o clique não pode gravar
    await page.waitForTimeout(1_000);

    expect({ todos: contar(pessoa, 'todos'), vivos: contar(pessoa, 'vivos'), revogados: contar(pessoa, 'revogados') }).toEqual(antes);
    await expect(secao.getByRole('row').filter({ hasText: 'Alumno/a' })).toHaveCount(1); // a tela ainda mostra o vínculo vivo
  });

  test('alternativo 2: staff com permission_management e SEM area_membership — a seção NÃO existe no DOM e os Grupos seguem visíveis', async ({ page }) => {
    await abrirAccess(page, SEM_CELULA);
    await expect(page.getByTestId('access-groups-header')).toBeVisible();
    await expect(page.getByTestId('area-memberships-section')).toHaveCount(0);
    await expect(page.getByTestId('area-memberships-search')).toHaveCount(0);
    await expect(page.getByTestId('area-membership-grant-form')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Vínculos de área' })).toHaveCount(0);
  });
});
