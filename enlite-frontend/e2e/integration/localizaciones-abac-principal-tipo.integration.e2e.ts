/**
 * localizaciones-abac-principal-tipo.integration.e2e.ts @integration — card "Localizaciones"
 * (spec 019, D286) com o ENGINE ABAC LIGADO, contra API/Postgres reais.
 *
 * Molde: `admin-access-cells-visual.integration.e2e.ts` (auth mock + engine ligado) e
 * `e2e/helpers/abac-stack-helper.ts` (login humano, seed de staff+grupo, concessão de célula).
 * Diferença para `localizaciones-fase2-principal-tipo.integration.e2e.ts`: aquele roda com o
 * emulador do Firebase e role `admin` (engine OFF nesse stack) — este prova que a MESMA ação
 * ("Marcar como principal", o lápis, o PATCH) respeita `patient_address:write`/`:read` quando o
 * engine decide de verdade, com dois staff SEM role admin.
 *
 * Stack (projeto docker `019abac`, ver contrato da sessão): API 8189, Postgres 5975,
 * PERMISSION_ENGINE_ENABLED=true, PERMISSION_ENFORCED_ROUTES = as 12 famílias.
 *
 *   ABAC_API_URL=http://localhost:8189 ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5975/enlite_e2e \
 *   E2E_PG_CONTAINER=019abac-postgres PW_BASE_URL=http://localhost:5176 \
 *   npx playwright test localizaciones-abac-principal-tipo --project=integration
 */
import { test, expect, type Page } from '@playwright/test';
import {
  ABAC_API_URL,
  psql,
  scalar,
  safeSql,
  grantCell,
  seedStaffInGroup,
  cleanupStaffAndGroup,
  loginAs,
  tokenFor,
  type MockUser,
} from '../helpers/abac-stack-helper';
import { insertTestPatient } from '../helpers/db-test-helper';
import { instalarFakeDeGestos, CABA_CORRIENTES } from '../helpers/google-places-fake-gestos';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const COUNTRY = 'AR';

const ESCRITORA: MockUser = { uid: `e2e-abac-esc-${RUN_ID}`, email: `e2e-abac-esc-${RUN_ID}@e2e.test`, role: 'recruiter', country: COUNTRY };
const LEITORA: MockUser = { uid: `e2e-abac-lei-${RUN_ID}`, email: `e2e-abac-lei-${RUN_ID}@e2e.test`, role: 'recruiter', country: COUNTRY };

let grupoEscritoraId = '';
let grupoLeitoraId = '';
const pacientes: string[] = [];

async function abrirTabServicioContratado(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click();
}

/** Escolhe `place` no autocomplete pelo GESTO real (seta + Enter) — nunca `fill()` no place inteiro. */
async function escolherPlace(page: Page, texto: string): Promise<void> {
  const campoEndereco = page.getByTestId('pad-address');
  await campoEndereco.click();
  await campoEndereco.pressSequentially(texto, { delay: 60 });
  await campoEndereco.press('ArrowDown');
  await campoEndereco.press('Enter');
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Card Localizaciones — engine ABAC LIGADO (D286) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeAll(() => {
    const gEsc = seedStaffInGroup({ uid: ESCRITORA.uid, email: ESCRITORA.email, groupName: `E2E ABAC escritora ${RUN_ID}`, country: COUNTRY });
    grupoEscritoraId = gEsc.groupId;
    grantCell(grupoEscritoraId, 'patient', 'read');
    grantCell(grupoEscritoraId, 'patient_address', 'read');
    grantCell(grupoEscritoraId, 'patient_address', 'write');

    const gLei = seedStaffInGroup({ uid: LEITORA.uid, email: LEITORA.email, groupName: `E2E ABAC leitora ${RUN_ID}`, country: COUNTRY });
    grupoLeitoraId = gLei.groupId;
    grantCell(grupoLeitoraId, 'patient', 'read');
    grantCell(grupoLeitoraId, 'patient_address', 'read');
    // Deliberadamente SEM patient_address:write.
  });

  test.afterAll(() => {
    pacientes.forEach((id) => safeSql(`DELETE FROM patient_addresses WHERE patient_id = '${id}'`));
    pacientes.forEach((id) => safeSql(`DELETE FROM patients WHERE id = '${id}'`));
    cleanupStaffAndGroup(ESCRITORA.uid, grupoEscritoraId);
    cleanupStaffAndGroup(LEITORA.uid, grupoLeitoraId);
  });

  test('(a) staff com patient_address:write — Marcar como principal troca no banco e o tipo "Otro" persiste após reload', async ({ page }, testInfo) => {
    await instalarFakeDeGestos(page, CABA_CORRIENTES);
    await loginAs(page, ESCRITORA);
    const { patientId } = insertTestPatient({ status: 'PENDING_ADMISSION', firstName: 'AbacEsc', lastName: `Humano${Date.now()}`, withAddress: false });
    pacientes.push(patientId);

    await abrirTabServicioContratado(page, patientId);
    const card = page.getByTestId('localizacoes-card');
    await expect(card).toBeVisible({ timeout: 20_000 });

    // ── criar dois endereços (o 1º nasce principal) ──────────────────────────────────────────
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('new-address-btn').click();
      const drawer = page.getByTestId('patient-address-drawer');
      await expect(drawer).toBeVisible();
      await escolherPlace(page, 'Av. Corrientes 1234');
      await expect(page.getByTestId('pad-address')).toHaveValue(CABA_CORRIENTES.formatted_address, { timeout: 10_000 });
      const post = page.waitForResponse((r) => r.request().method() === 'POST' && /\/addresses$/.test(r.url()));
      await page.getByTestId('pad-save').click();
      expect((await post).status()).toBe(201);
      await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    }
    await expect(card).toContainText('Principal', { timeout: 20_000 });

    // ── "Marcar como principal" aparece (célula concedida) ───────────────────────────────────
    const marcarLinks = card.getByTestId(/^address-mark-primary-/);
    await expect(marcarLinks).toHaveCount(1, { timeout: 10_000 });
    const patch1 = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/addresses\//.test(r.url()));
    await marcarLinks.first().click();
    expect((await patch1).status()).toBe(200);
    await expect(card.getByTestId(/^address-primary-badge-/)).toHaveCount(1, { timeout: 10_000 });

    const contagem1 = scalar(`SELECT count(*) FROM patient_addresses WHERE patient_id = '${patientId}' AND archived_at IS NULL AND is_default = true`);
    testInfo.annotations.push({ type: 'evidência', description: `is_default ativos após trocar o principal: ${contagem1}` });
    expect(contagem1).toBe('1');

    // ── editar tipo → "Casa de la madre" → "Otro" (texto livre, tecla por tecla) ─────────────
    const editButtons = card.locator('[data-testid^="edit-address-"]');
    await editButtons.first().click();
    const drawer2 = page.getByTestId('patient-address-drawer');
    await expect(drawer2).toBeVisible();
    const tipoSelect = page.getByTestId('pad-type');
    await tipoSelect.click();
    await tipoSelect.selectOption('casa_madre');
    const patchTipo1 = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/addresses\//.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await patchTipo1).status()).toBe(200);
    await expect(drawer2).toHaveCount(0, { timeout: 15_000 });
    await expect(card).toContainText('Casa de la madre', { timeout: 20_000 });

    await editButtons.first().click();
    await expect(drawer2).toBeVisible();
    await tipoSelect.click();
    await tipoSelect.selectOption('otro');
    const campoOtro = page.getByTestId('pad-type-other');
    await campoOtro.click();
    await expect(campoOtro).toBeFocused();
    await campoOtro.pressSequentially('Casa de un tio ABAC', { delay: 40 });
    await expect(campoOtro).toHaveValue('Casa de un tio ABAC');
    const patchTipo2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/addresses\//.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await patchTipo2).status()).toBe(200);
    await expect(drawer2).toHaveCount(0, { timeout: 15_000 });
    await expect(card).toContainText('Otro', { timeout: 20_000 });

    // ── reload — o valor lido na TELA, não só no banco ───────────────────────────────────────
    await page.reload();
    await abrirTabServicioContratado(page, patientId);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Otro', { timeout: 20_000 });

    const rowsDb = psql(`SELECT address_type, address_type_other FROM patient_addresses WHERE patient_id = '${patientId}' AND archived_at IS NULL AND address_type = 'otro'`);
    testInfo.annotations.push({ type: 'evidência', description: `tipo persistido após reload: ${rowsDb}` });
    expect(rowsDb).toContain('otro');
    expect(rowsDb).toContain('Casa de un tio ABAC');
  });

  test('(b) staff SÓ com patient_address:read — sem "Marcar como principal"/lápis, e PATCH direto na API dá 403 sem tocar o banco', async ({ page, request }, testInfo) => {
    await loginAs(page, LEITORA);
    const { patientId, addressId } = insertTestPatient({ status: 'PENDING_ADMISSION', firstName: 'AbacLei', lastName: `Humano${Date.now()}`, withAddress: false });
    pacientes.push(patientId);
    // Endereço semeado direto no schema NOVO (o helper `insertTestPatient` ainda grava
    // `address_type = 'primary'`, valor que a migration 434 já não aceita).
    psql(`INSERT INTO patient_addresses (patient_id, is_default, address_type, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
          VALUES ('${patientId}', true, NULL, 'Av. Corrientes 1234, CABA, AR', 'Av. Corrientes 1234, CABA', -34.6037, -58.3816, 1, 'manual', NOW(), NOW())`);
    const enderecoId = scalar(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`);
    void addressId;

    await abrirTabServicioContratado(page, patientId);
    const card = page.getByTestId('localizacoes-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Principal', { timeout: 20_000 });

    // ── ausência com espera REAL (não contagem imediata) ─────────────────────────────────────
    await expect(card.getByTestId(/^address-mark-primary-/)).toHaveCount(0, { timeout: 10_000 });
    await expect(card.locator('[data-testid^="edit-address-"]')).toHaveCount(0, { timeout: 10_000 });
    await page.waitForTimeout(2_000); // segunda checagem, depois de dar tempo à UI de assentar
    await expect(card.getByTestId(/^address-mark-primary-/)).toHaveCount(0);
    await expect(card.locator('[data-testid^="edit-address-"]')).toHaveCount(0);

    const antesIsDefault = scalar(`SELECT is_default FROM patient_addresses WHERE id = '${enderecoId}'`);
    const res = await request.patch(`${ABAC_API_URL}/api/admin/patients/${patientId}/addresses/${enderecoId}`, {
      headers: { Authorization: `Bearer ${tokenFor(LEITORA)}`, 'Content-Type': 'application/json' },
      data: { is_default: true },
      failOnStatusCode: false,
    });
    testInfo.annotations.push({ type: 'evidência', description: `PATCH direto (staff sem write): status ${res.status()}` });
    expect(res.status()).toBe(403);
    const depoisIsDefault = scalar(`SELECT is_default FROM patient_addresses WHERE id = '${enderecoId}'`);
    testInfo.annotations.push({ type: 'evidência', description: `is_default antes=${antesIsDefault} depois=${depoisIsDefault}` });
    expect(depoisIsDefault).toBe(antesIsDefault);
  });
});
