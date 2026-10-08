/**
 * enderecos-faturamento-044.integration.e2e.ts @integration — spec 044 (D475): "Dirección de facturación" é
 * campo PRÓPRIO do paciente, preenchido pela busca do Google Places; "Copiar dirección principal"; e remover
 * Localización só quando nenhuma vaga/serviço aponta.
 *
 * Stack REAL (API + Postgres + emulador Firebase, sem mock de API). O Google é o FAKE de gestos
 * (`google-places-fake-gestos.ts`), com `address_components` INCLUINDO `administrative_area_level_1`
 * (o default do fake não tem). Régua humana (memória `e2e-humano-nao-e-fill`): `click()` + `keyboard.type()`,
 * valor lido da TELA (`inputValue()`/texto), nunca `fill`. Endereços de ficção.
 *
 *  feliz — drawer "Editar información general": digitar e escolher no Places → salvar → o card mostra; reabrir →
 *          "Copiar dirección principal" → os campos viram o Principal (não o addresses[0]) → salvar → o card mostra.
 *          0 ida ao Google (predições/detalhes/geocodes do fake) em todo o fluxo da cópia.
 *  alt 1 — excluir um local livre: lixeira → diálogo do design system → some da lista; o Principal (com outro
 *          ativo) tem a lixeira desabilitada com o motivo; a auditoria do banco tem 1 linha SEM o texto.
 *  alt 2 — local com vaga FECHADA: lixeira desabilitada com o motivo no `title`; forçando a rota
 *          (`page.request.delete`) → 409 ADDRESS_IN_USE e a linha continua.
 *
 * Rodar: stack do CI + emulador (API com `docker-compose.firebase.yml`) e Vite com VITE_FIREBASE_AUTH_EMULATOR;
 * E2E_PG_CONTAINER aponta para o Postgres do projeto docker, se não for o `enlite-postgres`.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient } from '../helpers/db-test-helper';
import { runSQL, cleanupPatientDeep } from '../helpers/patient-detail-a-helper';
import { loginComoHumano } from '../helpers/login-humano';
import {
  instalarFakeDeGestos,
  contarChamadasAoGoogle,
  type PlaceFalso,
} from '../helpers/google-places-fake-gestos';

const API_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';
const STAFF_EMAIL = `e2e.enderecos-044.${Date.now()}@enlite.health`;

/** O que o "Google" devolve ao escolher: texto + cidade (locality) + província (administrative_area_level_1). */
const PLACE_FATURAMENTO: PlaceFalso = {
  formatted_address: 'Calle Facturacion 044, Ciudad Ficticia, Provincia Ficticia, Argentina',
  lat: -34.6,
  lng: -58.4,
  addressComponents: [
    { long_name: 'Calle Facturacion', short_name: 'Calle Facturacion', types: ['route'] },
    { long_name: '044', short_name: '044', types: ['street_number'] },
    { long_name: 'Ciudad Ficticia', short_name: 'CF', types: ['locality', 'political'] },
    { long_name: 'Provincia Ficticia', short_name: 'PF', types: ['administrative_area_level_1', 'political'] },
    { long_name: 'Argentina', short_name: 'AR', types: ['country', 'political'] },
  ],
};

const PRIMEIRO_TEXTO = 'Calle Primera 1, Ciudad Uno, Provincia Uno';
const PRINCIPAL_TEXTO = 'Calle Principal 2, Ciudad Principal, Provincia Principal';
const LIVRE_TEXTO = 'Calle Livre 3, Ciudad Tres, Provincia Tres';
const COM_VAGA_TEXTO = 'Calle Con Vacante 4, Ciudad Cuatro, Provincia Cuatro';

interface Seed { patientId: string; ids: Record<string, string> }

/** Paciente com endereços semeados direto no schema novo. `principal` é o único `is_default`. */
function seedPaciente(sobrenome: string, enderecos: Array<{ chave: string; texto: string; principal?: boolean; city?: string; state?: string }>): Seed {
  const { patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'End044', lastName: `${sobrenome}${Date.now()}`, withAddress: false });
  const ids: Record<string, string> = {};
  enderecos.forEach((e, i) => {
    ids[e.chave] = runSQL(
      `INSERT INTO patient_addresses (patient_id, address_type, address_formatted, neighborhood, city, state, is_default, display_order, country) ` +
      `VALUES ('${patientId}', 'casa_madre', '${e.texto}', 'Barrio 044', ${e.city ? `'${e.city}'` : 'NULL'}, ${e.state ? `'${e.state}'` : 'NULL'}, ${e.principal ? 'true' : 'false'}, ${i + 1}, 'AR') RETURNING id`,
    ).split('\n')[0];
  });
  return { patientId, ids };
}

const lerBilling = (patientId: string): string =>
  runSQL(`SELECT COALESCE(billing_address_formatted,'<NULL>') || '|' || COALESCE(billing_city,'<NULL>') || '|' || COALESCE(billing_province,'<NULL>') FROM patients WHERE id = '${patientId}'`);
const enderecoExiste = (addressId: string): boolean => runSQL(`SELECT count(*) FROM patient_addresses WHERE id = '${addressId}'`) === '1';

/** Abre o drawer "Editar información general" pelo botão do card. */
async function abrirDrawerGeral(page: Page): Promise<void> {
  await page.getByTestId('edit-general-btn').click();
  await expect(page.getByTestId('patient-general-edit-drawer')).toBeVisible();
}

/** Escolhe no autocomplete pelo GESTO real: clicar, digitar, seta + Enter. */
async function escolherNoPlaces(page: Page, texto: string): Promise<void> {
  const campo = page.getByTestId('pge-billing');
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto, { delay: 40 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

async function salvarDrawerGeral(page: Page): Promise<void> {
  const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/general$/.test(r.url()));
  await page.getByTestId('pge-save').click();
  expect((await patch).status()).toBe(200);
  await expect(page.getByTestId('patient-general-edit-drawer')).toHaveCount(0, { timeout: 15_000 });
}

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('Endereço de faturamento + remover Localización (spec 044) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  const pacientes: string[] = [];
  test.afterAll(() => {
    pacientes.forEach(cleanupPatientDeep);
    try { runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`); } catch { /* limpeza não esconde o resultado */ }
  });

  test('feliz — escolher no Places e salvar; depois "Copiar dirección principal" copia o PRINCIPAL e salva', async ({ page }) => {
    await instalarFakeDeGestos(page, PLACE_FATURAMENTO);
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Enderecos 044');
    // O 1º por display_order NÃO é o Principal: a cópia tem de pegar o Principal (A3).
    const { patientId } = seedPaciente('Feliz', [
      { chave: 'primeiro', texto: PRIMEIRO_TEXTO, city: 'Ciudad Uno', state: 'Provincia Uno' },
      { chave: 'principal', texto: PRINCIPAL_TEXTO, principal: true, city: 'Ciudad Principal', state: 'Provincia Principal' },
    ]);
    pacientes.push(patientId);

    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 20_000 });
    // Sem faturamento: o campo APARECE com "No definido" (e não mostra o addresses[0] nem o Principal).
    await expect(page.getByTestId('patient-address')).toContainText('No definido');
    await expect(page.getByTestId('patient-identity-card')).not.toContainText(PRIMEIRO_TEXTO);

    // 1) Escolher no Places → salvar → o card mostra.
    await abrirDrawerGeral(page);
    await escolherNoPlaces(page, 'Calle Facturacion 044');
    await expect(page.getByTestId('pge-billing')).toHaveValue(PLACE_FATURAMENTO.formatted_address, { timeout: 10_000 });
    await salvarDrawerGeral(page);
    await expect(page.getByTestId('patient-address')).toContainText(PLACE_FATURAMENTO.formatted_address, { timeout: 15_000 });
    // Cidade e província vieram dos address_components (locality / administrative_area_level_1), sem lat/lng.
    expect(lerBilling(patientId)).toBe(`${PLACE_FATURAMENTO.formatted_address}|Ciudad Ficticia|Provincia Ficticia`);

    // 2) Reabrir → "Copiar dirección principal" → os campos viram o Principal → salvar → o card mostra.
    const antes = await contarChamadasAoGoogle(page);
    await abrirDrawerGeral(page);
    await expect(page.getByTestId('pge-billing')).toHaveValue(PLACE_FATURAMENTO.formatted_address);
    await page.getByTestId('pge-billing-copy-primary').click();
    await expect(page.getByTestId('pge-billing')).toHaveValue(PRINCIPAL_TEXTO);
    expect(await page.getByTestId('pge-billing').inputValue()).not.toBe(PRIMEIRO_TEXTO);
    await salvarDrawerGeral(page);
    await expect(page.getByTestId('patient-address')).toContainText(PRINCIPAL_TEXTO, { timeout: 15_000 });
    expect(lerBilling(patientId)).toBe(`${PRINCIPAL_TEXTO}|Ciudad Principal|Provincia Principal`);

    // 0 ida ao Google na cópia (a escolha do passo 1 já tinha gasto o que o fake conta).
    const depois = await contarChamadasAoGoogle(page);
    expect(depois, 'copiar o Principal não chama predições, detalhes nem geocoding').toEqual(antes);
    expect(depois.predictions).toBe(0);
    expect(depois.geocodes).toBe(0);
  });

  test('alt 1 — excluir um local livre: lixeira → diálogo do design system → some da lista; Principal com outro ativo não exclui', async ({ page }) => {
    await instalarFakeDeGestos(page, PLACE_FATURAMENTO);
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Enderecos 044');
    const { patientId, ids } = seedPaciente('Alt1', [
      { chave: 'principal', texto: PRINCIPAL_TEXTO, principal: true },
      { chave: 'livre', texto: LIVRE_TEXTO },
    ]);
    pacientes.push(patientId);

    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click();
    const card = page.getByTestId('localizacoes-card');
    await expect(card).toContainText('Calle Livre 3', { timeout: 20_000 });

    // O Principal, com outro endereço ativo: desabilitada, com o motivo.
    const lixeiraPrincipal = page.getByTestId(`delete-address-${ids.principal}`);
    await expect(lixeiraPrincipal).toBeDisabled();
    await expect(lixeiraPrincipal).toHaveAttribute('title', 'Marcá otra dirección como principal primero');

    // O livre: habilitada → diálogo → confirmar.
    const lixeira = page.getByTestId(`delete-address-${ids.livre}`);
    await expect(lixeira).toBeEnabled();
    await lixeira.click();
    const dialogo = page.getByTestId('delete-address-confirm');
    await expect(dialogo).toBeVisible();
    await expect(dialogo).toContainText('¿Eliminar esta localización?');
    expect(enderecoExiste(ids.livre), 'só abrir o diálogo não apaga nada').toBe(true);
    const del = page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/addresses/${ids.livre}`));
    await page.getByTestId('delete-address-confirm-btn').click();
    expect((await del).status()).toBe(204);

    await expect(dialogo).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId(`delete-address-${ids.livre}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(card).not.toContainText('Calle Livre 3');
    await expect(card).toContainText('Calle Principal 2');
    expect(enderecoExiste(ids.livre)).toBe(false);
    expect(enderecoExiste(ids.principal)).toBe(true);

    // Auditoria: exatamente 1 linha, com ator, e NENHUM texto de endereço.
    const linhas = runSQL(`SELECT count(*) FROM patient_address_audit_log WHERE patient_id = '${patientId}'`);
    expect(linhas).toBe('1');
    const changes = runSQL(`SELECT changes::text FROM patient_address_audit_log WHERE patient_id = '${patientId}'`);
    expect(changes).toContain(ids.livre);
    expect(changes).not.toContain('Calle Livre');
    expect(changes).not.toContain('address_formatted');
  });

  test('alt 2 — local com vaga FECHADA: lixeira desabilitada com o motivo; forçando a rota → 409 e a linha continua', async ({ page }) => {
    await instalarFakeDeGestos(page, PLACE_FATURAMENTO);
    await loginComoHumano(page, STAFF_EMAIL, 'E2E Enderecos 044');
    const { patientId, ids } = seedPaciente('Alt2', [
      { chave: 'principal', texto: PRINCIPAL_TEXTO, principal: true },
      { chave: 'comVaga', texto: COM_VAGA_TEXTO },
    ]);
    pacientes.push(patientId);
    runSQL(`INSERT INTO job_postings (title, patient_id, patient_address_id, is_draft, status) VALUES ('e2e 044 vaga fechada', '${patientId}', '${ids.comVaga}', false, 'CLOSED')`);

    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click();
    await expect(page.getByTestId('localizacoes-card')).toContainText('Calle Con Vacante 4', { timeout: 20_000 });

    const lixeira = page.getByTestId(`delete-address-${ids.comVaga}`);
    await expect(lixeira).toBeDisabled();
    await expect(lixeira).toHaveAttribute('title', 'Tiene 1 vacantes / 0 servicios asociados');

    // Forçando a rota com o token real do operador logado: o servidor também recusa.
    const token = await page.evaluate(() => {
      const chave = Object.keys(localStorage).find((k) => k.startsWith('firebase:authUser:'));
      return chave ? (JSON.parse(localStorage.getItem(chave) as string).stsTokenManager.accessToken as string) : '';
    });
    expect(token.length).toBeGreaterThan(20);
    const res = await page.request.delete(`${API_URL}/api/admin/patients/${patientId}/addresses/${ids.comVaga}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: 'ADDRESS_IN_USE', details: { vacancies: 1, services: 0 } });
    expect(enderecoExiste(ids.comVaga)).toBe(true);
    expect(runSQL(`SELECT count(*) FROM patient_address_audit_log WHERE patient_id = '${patientId}'`)).toBe('0');
  });
});
