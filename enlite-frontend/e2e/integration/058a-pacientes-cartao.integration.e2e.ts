/**
 * 058a-pacientes-cartao.integration.e2e.ts @integration — spec 058 Parte A, T133: cartão "Pacientes" da obra social (§L, somente leitura).
 *
 * E2E DE TELA, SEM MOCK de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo, clique de humano. O cenário
 * (paciente com serviço, contrato, vínculo vigente e um vínculo ENCERRADO) é montado pela API real e por SQL de paciente (molde do spec 048).
 *
 *  FELIZ         — o paciente com vínculo VIGENTE aparece (caso, contrato, vigência, "vínculos vigentes ao <hoje do país>"); o link leva à ficha.
 *  ALTERNATIVO 1 — obra social sem vínculo vigente: `items: []` na API e a mensagem de vazio na tela (também quando o único vínculo já terminou).
 *  ALTERNATIVO 2 — (ABAC) sem `insurance_provider_patients:read` o cartão diz "sem permissão" e nenhum caso aparece; o servidor devolve 403.
 *                  Só mede com o engine ligado.
 */
import { test, expect } from '@playwright/test';
import { loginAs, scalar } from '../helpers/abac-stack-helper';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  CELLS_INSURANCE_ALL, seedActor, dropActors, purgeProviders, api, apiOk, makeProvider, makeContract, asOfAR, addDays,
  type Actor, type ProviderMade, type ContractMade,
} from '../helpers/insurance-058a-helper';

test.use({ viewport: { width: 1600, height: 1100 }, video: 'on' });

test.describe('058a-pacientes-cartao — cartão Pacientes da obra social (spec 058 T133) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let ator: Actor;
  let semPacientes: Actor;
  let comPaciente: ProviderMade;
  let semVinculo: ProviderMade;
  let contrato: ContractMade;
  let paciente: { patientId: string; addressId: string; stamp: string };
  let outro: { patientId: string; addressId: string; stamp: string };
  let servicoId = '';
  let servicoEncerradoId = '';
  let casoNumero = '';

  const novoServico = (patientId: string, addressId: string): string =>
    runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${patientId}', 'CAREGIVER', 20, '${addressId}', 'e2e-058a', 'e2e-058a') RETURNING id`).split('\n')[0].trim();

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    // `ator` monta o cenário e é a pessoa do feliz: todas as células da obra social + o que o vínculo do serviço exige.
    ator = seedActor('pac', [
      ...CELLS_INSURANCE_ALL, ['patient_services', 'read'], ['patient_services', 'update'], ['patient_coverage', 'read'],
      ['patient', 'read'], ['patient_identity', 'read'], ['patient_address', 'read'], // o link do cartão abre a ficha
    ]);
    // Lê a obra social, os contratos e os empregados, mas NÃO os pacientes: é a pessoa do alternativo 2.
    semPacientes = seedActor('pac-sem-leitura', [
      ['catalog_insurance_providers', 'read'], ['insurance_contracts', 'read'], ['insurance_provider_contacts', 'read'],
    ]);
    comPaciente = await makeProvider(request, ator, 'Pacientes Com');
    semVinculo = await makeProvider(request, ator, 'Pacientes Sem');
    const hoje = await asOfAR(request, ator);
    contrato = await makeContract(request, ator, comPaciente.code, 'Pacientes', { hourlyRate: 1500, taxRatePercent: 21, validFrom: addDays(hoje, -60) });
    const contratoSem = await makeContract(request, ator, semVinculo.code, 'Pacientes Sem', { hourlyRate: 900, taxRatePercent: 0, validFrom: addDays(hoje, -60) });

    paciente = seedActivatablePatient(631000);
    outro = seedActivatablePatient(632000);
    servicoId = novoServico(paciente.patientId, paciente.addressId);
    servicoEncerradoId = novoServico(outro.patientId, outro.addressId);
    casoNumero = scalar(`SELECT case_number FROM patients WHERE id = '${paciente.patientId}'`);

    // Vínculo vigente (desde antes de hoje) da obra social "Com"; e um vínculo da "Sem" que já TERMINOU ontem.
    await apiOk(request, ator, 'POST', `/api/admin/patients/${paciente.patientId}/contracted-services/${servicoId}/contract-link`,
      { contractId: contrato.id, validFrom: addDays(hoje, -30) }, 201);
    await apiOk(request, ator, 'POST', `/api/admin/patients/${outro.patientId}/contracted-services/${servicoEncerradoId}/contract-link`,
      { contractId: contratoSem.id, validFrom: addDays(hoje, -30) }, 201);
    await apiOk(request, ator, 'POST', `/api/admin/patients/${outro.patientId}/contracted-services/${servicoEncerradoId}/contract-link/end`,
      { validTo: addDays(hoje, -1) }, 200);
    await request.dispose();
  });

  test.afterAll(() => {
    purgeProviders(); // o vínculo aponta para o serviço: sai ANTES do paciente
    for (const p of [paciente, outro]) {
      if (!p) continue;
      runSQL(`DELETE FROM patients WHERE id = '${p.patientId}'`);
      cleanupPatientDeep(p.patientId);
    }
    dropActors();
  });

  test('FELIZ: o paciente com vínculo vigente aparece (caso, contrato, vigência) e o link leva à ficha', async ({ page }) => {
    await loginAs(page, ator.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(comPaciente.code)}`);
    const linha = page.getByTestId(`patient-row-${servicoId}`);
    await expect(linha).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('patients-table')).toBeVisible();
    await expect(linha).toContainText(contrato.name);
    await expect(linha).toContainText(servicoId.slice(0, 8));
    await expect(linha).toContainText('desde el'); // vigência aberta: "desde el <data>, sin fecha de fin"
    await expect(page.getByTestId(`patient-link-${servicoId}`)).toContainText(casoNumero);
    await expect(page.getByTestId('patients-as-of')).toContainText('Vínculos vigentes al');
    // O vínculo já encerrado (outra obra social) não aparece aqui nem lá como vigente.
    await expect(page.getByTestId(`patient-row-${servicoEncerradoId}`)).toHaveCount(0);

    // O link abre a ficha DAQUELE paciente.
    await page.getByTestId(`patient-link-${servicoId}`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/patients/${paciente.patientId}$`), { timeout: 20_000 });
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await page.goBack();
    await expect(page.getByTestId(`patient-row-${servicoId}`)).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: 'test-results/058a-pacientes-cartao.png', fullPage: true });
  });

  test('ALTERNATIVO 1: obra social sem vínculo vigente -> items [] na API e a mensagem de vazio na tela (o vínculo encerrado não conta)', async ({ page, request }) => {
    const r = await apiOk<{ items: unknown[] }>(request, ator, 'GET', `/api/admin/insurance-providers/${semVinculo.code}/patients`, undefined, 200);
    expect(r.items).toEqual([]);

    await loginAs(page, ator.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(semVinculo.code)}`);
    await expect(page.getByTestId('patients-empty')).toHaveText('Ningún paciente tiene un vínculo vigente con esta obra social.', { timeout: 30_000 });
    await expect(page.getByTestId('patients-table')).toHaveCount(0);
    await expect(page.getByTestId(`patient-row-${servicoEncerradoId}`)).toHaveCount(0);
  });

  test('ALTERNATIVO 2 (ABAC): sem `insurance_provider_patients:read` o cartão diz "sem permissão", nenhum caso aparece e o servidor devolve 403', async ({ page, request }) => {
    // Controle positivo: quem tem a célula lê o vínculo do MESMO paciente.
    const comLeitura = await apiOk<{ items: Array<{ contractedServiceId: string }> }>(
      request, ator, 'GET', `/api/admin/insurance-providers/${comPaciente.code}/patients`, undefined, 200);
    expect(comLeitura.items.map((i) => i.contractedServiceId)).toContain(servicoId);

    await loginAs(page, semPacientes.user);
    await page.goto(`/admin/obras-sociales/${encodeURIComponent(comPaciente.code)}`);
    await expect(page.getByTestId('provider-general-view')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('patients-no-permission')).toHaveText('No tenés permiso para ver los pacientes de esta obra social.');
    await expect(page.getByTestId('patients-table')).toHaveCount(0);
    await expect(page.getByTestId(`patient-row-${servicoId}`)).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain(`Caso ${casoNumero}`);

    const negado = await api(request, semPacientes, 'GET', `/api/admin/insurance-providers/${comPaciente.code}/patients`);
    expect(negado.status).toBe(403);
  });
});
