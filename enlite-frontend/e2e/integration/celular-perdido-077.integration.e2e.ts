/**
 * celular-perdido-077.integration.e2e.ts @integration — "Celular perdido" na ficha da cuidadora (spec 077, D795).
 *
 * Stack REAL (API + Postgres), engine ABAC LIGADO com `admin.workers` enforced e o catálogo sincronizado
 * (`PERMISSION_CATALOG_SYNC_ENABLED`: sem ele `worker_device:revoke` não existe em `iam.permissions` e o
 * `grantCell` falha alto). É o ambiente do job `integration-e2e-group-simulation` (override
 * `docker-compose.group-simulation.yml`). Nenhum `page.route` de DADO: só o swap do Authorization (`installAuthInterceptors`).
 *
 * A célula é concedida a um GRUPO DE TESTE criado aqui e apagado no `afterAll` — é cenário de teste no banco do
 * stack, não a decisão de quem recebe a célula (essa é dos C-levels; nenhuma migration a concede).
 *
 *   T-F3c-DB-13 sem a célula → o botão não existe na ficha, e a API recusa a leitura do status (403).
 *   T-F3c-DB-13 clique → confirmação → pedido → linha de status lida do servidor; a conta NÃO é desativada.
 *   T-F3c-DB-14 com `wiped_at` gravado (o que o `POST /v1/device/wiped` do app grava) → "La app informó que borró".
 *
 * Push: o aparelho semeado não tem token FCM → `pushSent=false` → o retorno do clique é "No se pudo avisar al teléfono".
 * Sessões: `revokeRefreshTokens` contra um uid inexistente falha e é só logado (o aparelho fica revogado mesmo assim).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  ABAC_API_URL, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, psql, safeSql, scalar, seedStaffInGroup, tokenFor, type MockUser,
} from '../helpers/abac-stack-helper';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const mk = (nome: string): MockUser => ({ uid: `e2e-cp077-${nome}-${RUN}`, email: `cp077.${nome}.${RUN}@e2e.test`, role: 'recruiter', country: 'AR' });
const COM = mk('com');
const SEM = mk('sem');
const NOME = `E2E Celular ${RUN}`;
const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64');
const grupos: Record<string, string> = {};
let workerId = '';

async function abrirFicha(page: Page): Promise<void> {
  await page.goto(`/admin/workers/${workerId}`);
  await expect(page.getByTestId('worker-contact-card')).toBeVisible({ timeout: 30_000 });
}

test.describe('Celular perdido 077 — botão só com a célula, pedido e status lidos do servidor @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  test.beforeAll(async ({ request }) => {
    workerId = scalar(`INSERT INTO workers (auth_uid, email, status, country, first_name_encrypted, last_name_encrypted)
        VALUES ('e2e-cp077-w-${RUN}', 'cp077.w.${RUN}@e2e.test', 'REGISTERED', 'AR', '${b64(NOME)}', '${b64('QA')}') RETURNING id`);
    psql(`INSERT INTO worker_devices (worker_id, installation_id, public_key) VALUES ('${workerId}', gen_random_uuid(), 'pk-e2e-${RUN}')`);
    for (const [chave, u] of [['com', COM], ['sem', SEM]] as Array<[string, MockUser]>) {
      grupos[chave] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `CP077 ${chave} ${RUN}`, country: 'AR' }).groupId;
      grantCell(grupos[chave], 'worker', 'read');
      grantCell(grupos[chave], 'worker_contact', 'read');
    }
    grantCell(grupos.com, 'worker_device', 'revoke');
    // O contrato de acesso tem cache no backend: espera a célula chegar ANTES de abrir a tela.
    await pollAuthz(request, COM, (b) => b?.permissions?.includes('worker_device:revoke'));
    await pollAuthz(request, SEM, (b) => Array.isArray(b?.permissions) && b.permissions.includes('worker:read'));
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM workers WHERE id = '${workerId}'`); // worker_devices cai em cascata
    for (const [chave, u] of [['com', COM], ['sem', SEM]] as Array<[string, MockUser]>) cleanupStaffAndGroup(u.uid, grupos[chave] ?? '');
  });

  test('T-F3c-DB-13 sem a célula worker_device:revoke o botão não aparece e a API recusa o status (403)', async ({ page }) => {
    await loginAs(page, SEM);
    await abrirFicha(page);
    await expect(page.getByTestId('worker-lost-device-card')).toHaveCount(0);
    await expect(page.getByTestId('worker-lost-device-button')).toHaveCount(0);

    const status = await fetch(`${ABAC_API_URL}/api/admin/workers/${workerId}/device/status`, { headers: { Authorization: `Bearer ${tokenFor(SEM)}` } });
    expect(status.status).toBe(403);
    const controle = await fetch(`${ABAC_API_URL}/api/admin/workers/${workerId}/device/status`, { headers: { Authorization: `Bearer ${tokenFor(COM)}` } });
    expect(controle.status).toBe(200); // controle positivo: a MESMA rota abre para quem tem a célula
  });

  test('T-F3c-DB-13 clique → confirmação → pedido → linha de status do servidor, e a conta continua ativa', async ({ page }) => {
    const statusAntes = scalar(`SELECT status FROM workers WHERE id = '${workerId}'`);
    await loginAs(page, COM);
    await abrirFicha(page);

    const botao = page.getByTestId('worker-lost-device-button');
    await expect(botao).toBeVisible();
    await botao.click();
    await expect(page.getByTestId('lost-device-confirm')).toBeVisible();
    expect(scalar(`SELECT count(*) FROM worker_devices WHERE worker_id = '${workerId}' AND status = 'revogado'`)).toBe('0'); // abrir não pede
    await page.getByTestId('lost-device-confirm-button').click();

    await expect(page.getByTestId('lost-device-feedback')).toHaveText('No se pudo avisar al teléfono; se borrará cuando se conecte.', { timeout: 20_000 });
    await expect(page.getByTestId('lost-device-requested')).toContainText(`por E2E ${COM.uid}`);
    await expect(page.getByTestId('lost-device-pending')).toContainText('no significa que no se haya borrado');
    await expect(botao).toHaveCount(0); // sem aparelho ativo, nada mais a revogar
    await expect(page.getByTestId('worker-lost-device-card')).toHaveScreenshot('cp077-pedido-pendente.png', { mask: [page.getByTestId('lost-device-requested')] });

    expect(scalar(`SELECT revoked_by || '|' || revoked_reason FROM worker_devices WHERE worker_id = '${workerId}'`)).toBe(`${COM.uid}|operador`);
    expect(scalar(`SELECT status FROM workers WHERE id = '${workerId}'`)).toBe(statusAntes); // G-9: não desativa a conta
  });

  test('T-F3c-DB-14 com wiped_at gravado pelo app, a ficha mostra "La app informó que borró" e some o pendente', async ({ page }) => {
    // O que o `POST /v1/workers/:id/device/wiped` (rota de serviço, OIDC) grava — aqui direto no banco do stack.
    psql(`UPDATE worker_devices SET wiped_at = NOW() WHERE worker_id = '${workerId}' AND revoked_reason = 'operador'`);
    await loginAs(page, COM);
    await abrirFicha(page);
    await expect(page.getByTestId('lost-device-wiped')).toContainText('La app informó que borró los datos el', { timeout: 20_000 });
    await expect(page.getByTestId('lost-device-pending')).toHaveCount(0);
    await expect(page.getByTestId('lost-device-feedback')).toHaveCount(0); // o retorno do clique não é reconstruído
    await expect(page.getByTestId('worker-lost-device-card')).toHaveScreenshot('cp077-app-informou.png', { mask: [page.getByTestId('lost-device-status')] });
  });
});
