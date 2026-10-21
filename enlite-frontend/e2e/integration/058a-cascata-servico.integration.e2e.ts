/**
 * 058a-cascata-servico.integration.e2e.ts @integration — spec 058 Parte A, T134: a cascata Obra social -> Contrato no SERVIÇO contratado da ficha.
 *
 * E2E DE TELA, SEM MOCK de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo, clique e teclado de humano
 * (select real, data digitada). O cenário (obras sociais, contratos com termo, pacientes com serviço e vínculos) vem da API real.
 *
 *  FELIZ         — serviço SEM vínculo -> "Vincular obra social y contrato" (obra social, contrato, vigência digitada) -> o cartão "vigente hoy" mostra o
 *                  pagador, o valor e o imposto (e a cobertura verificada CASA); a FICHA e a ROTA dizem o mesmo; "Cambiar, corregir o terminar…" ->
 *                  "Cambió el contrato": o select mostra o pagador já escolhido PELO NOME (travado), trocar o contrato muda valor e imposto.
 *                  + ALINHAMENTO MEDIDO (opção T1+A): rótulo 12px, o bloco de obra social ACIMA do campo "Servicio", o valor numa linha só,
 *                  campos da mesma linha com o mesmo topo.
 *  ALTERNATIVO 1 — vínculo ENCERRADO + tentar vincular de novo = `REQUIRES_NEW_SERVICE` (frase + botão "Crear un servicio nuevo" que abre o formulário,
 *                  SÓ para quem tem `patient_services:create`; 1b: sem essa célula a frase fica e o botão some).
 *  ALTERNATIVO 2 — dois operadores: o serviço foi vinculado por outro enquanto este escolhia = `USE_CORRECTION`; recarregado, "Se cargó mal" (corrigir) funciona.
 *  ALTERNATIVO 3 — serviço nunca vinculado: `NO_CONTRACT` na ficha (pagador, valor, imposto e cobertura dizem "sem contrato"), na lista e no detalhe.
 *  ALTERNATIVO 4 — (ABAC) sem `patient_coverage:read` o pagador vem `REDACTED` SEM nome (R7): frase de ocultação, cobertura `REDACTED`, sem a resposta "Cambió el contrato",
 *                  nenhum nome no DOM; sem `patient_contract_value:read` o valor é o cadeado. Só mede com o engine ligado.
 * NÃO cobre `COUNTRY_MISMATCH` / `TWO_PAYERS_OVERLAP` (provados ponta a ponta no e2e de API da T091).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { loginAs } from '../helpers/abac-stack-helper';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  CELLS_FICHA, CELLS_INSURANCE_ALL, seedActor, dropActors, purgeProviders, api, apiOk, makeProvider, makeContract, asOfAR, addDays,
  digitarData, escolher, type Actor, type ProviderMade, type ContractMade,
} from '../helpers/insurance-058a-helper';

const V1500 = /1\.?500,00/;
const V1800 = /1\.?800,00/;

type Seed = { patientId: string; addressId: string; stamp: string };
type Servico = { id: string; payer: any; payerHistory: any; price: any; tax: any; coverageMatch: any; asOf: string };

/** O que a tela MEDE (getBoundingClientRect/getComputedStyle), não o que o código diz: o desalinhamento que o Gabriel reprovou. */
async function medirAlinhamento(page: Page, sid: string): Promise<void> {
  const m = await page.evaluate((id) => {
    const q = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement;
    const top = (el: Element): number => el.getBoundingClientRect().top;
    const centro = (el: Element): number => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    const servico = q('[data-testid^="svc-code-"]');
    const prestadores = q('[data-testid^="svc-providersNeeded-"]');
    const preco = q('[data-testid="svc-price"]');
    const rotuloServico = q(`label[for="${servico.id}"]`);
    const rotuloPrestadores = q(`label[for="${prestadores.id}"]`);
    return {
      fonteRotulo: getComputedStyle(rotuloServico).fontSize,
      painelTop: top(q(`[data-testid="svc-contract-panel-${id}"]`)),
      servicoTop: top(servico),
      rotulosTop: [top(rotuloServico), top(rotuloPrestadores)],
      centrosInputs: [centro(servico), centro(prestadores)],
      precoAltura: preco.getBoundingClientRect().height,
      precoLinha: parseFloat(getComputedStyle(preco).lineHeight),
    };
  }, sid);
  expect(m.fonteRotulo, 'rótulo "Servicio" compacto').toBe('12px');
  expect(m.painelTop, 'o bloco de obra social vem ANTES do campo Servicio').toBeLessThan(m.servicoTop);
  expect(m.precoAltura, 'o valor monetário ocupa UMA linha').toBeLessThanOrEqual(m.precoLinha * 1.6);
  expect(Math.abs(m.rotulosTop[0] - m.rotulosTop[1]), 'rótulo alinha com rótulo').toBeLessThanOrEqual(1);
  expect(Math.abs(m.centrosInputs[0] - m.centrosInputs[1]), 'input alinha com input').toBeLessThanOrEqual(2);
}

test.use({ viewport: { width: 1600, height: 1200 }, video: 'on' });

test.describe('058a-cascata-servico — cascata Obra social -> Contrato no serviço contratado (spec 058 T134) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let ator: Actor;
  let semCobertura: Actor;
  let comCriar: Actor;
  let pa: ProviderMade;
  let pb: ProviderMade;
  let ca1: ContractMade;
  let ca2: ContractMade;
  let cb1: ContractMade;
  let hoje = '';
  const pacientes: Seed[] = [];
  let p1: Seed; let s1 = ''; let s4 = '';
  let p2: Seed; let s2 = '';
  let p3: Seed; let s3 = '';
  let p5: Seed; let s5 = '';

  const novoPaciente = (base: number): Seed => { const p = seedActivatablePatient(base); pacientes.push(p); return p; };
  const novoServico = (p: Seed): string =>
    runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${p.patientId}', 'CAREGIVER', 20, '${p.addressId}', 'e2e-058a', 'e2e-058a') RETURNING id`).split('\n')[0].trim();
  const vincular = (request: APIRequestContext, p: Seed, sid: string, contractId: string, validFrom: string) =>
    apiOk(request, ator, 'POST', `/api/admin/patients/${p.patientId}/contracted-services/${sid}/contract-link`, { contractId, validFrom }, 201);

  /** A ficha (GET do paciente) e a rota do serviço (GET da lista) dizem a MESMA coisa do serviço. */
  async function fichaIgualRota(request: APIRequestContext, quem: Actor, p: Seed, sid: string): Promise<Servico> {
    const rota = await apiOk<{ services: Servico[] }>(request, quem, 'GET', `/api/admin/patients/${p.patientId}/contracted-services`, undefined, 200);
    const ficha = await apiOk<{ contractedServices: Servico[] }>(request, quem, 'GET', `/api/admin/patients/${p.patientId}`, undefined, 200);
    const pick = (s: Servico) => ({ payer: s.payer, payerHistory: s.payerHistory, price: s.price, tax: s.tax, coverageMatch: s.coverageMatch, asOf: s.asOf });
    const daRota = rota.services.find((s) => s.id === sid)!;
    const daFicha = ficha.contractedServices.find((s) => s.id === sid)!;
    expect(daRota, 'o serviço está na rota').toBeTruthy();
    expect(daFicha, 'o serviço está na ficha').toBeTruthy();
    expect(pick(daFicha)).toEqual(pick(daRota));
    return daRota;
  }

  async function abrirPainel(page: Page, p: Seed, sid: string): Promise<void> {
    await page.goto(`/admin/patients/${p.patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await page.getByTestId(`contracted-service-edit-${sid}`).click();
    await expect(page.getByTestId(`svc-contract-panel-${sid}`)).toBeVisible({ timeout: 20_000 });
  }

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    ator = seedActor('casc', [...CELLS_FICHA, ...CELLS_INSURANCE_ALL]);
    // Mesma ficha, MENOS cobertura e valor: a pessoa do alternativo 4.
    const semCob = CELLS_FICHA.filter(([r]) => r !== 'patient_coverage');
    semCobertura = seedActor('casc-sem-cobertura', [...semCob, ['insurance_contracts', 'read'], ['catalog_insurance_providers', 'read']]);
    // Quem também CRIA serviço (`patient_services:create`): só ele vê "Crear un servicio nuevo" (a saída do REQUIRES_NEW_SERVICE).
    comCriar = seedActor('casc-cria', [...CELLS_FICHA, ...CELLS_INSURANCE_ALL, ['patient_services', 'create']]);
    pa = await makeProvider(request, ator, 'Cascata A');
    pb = await makeProvider(request, ator, 'Cascata B');
    hoje = await asOfAR(request, ator);
    const desde = addDays(hoje, -60);
    ca1 = await makeContract(request, ator, pa.code, 'CA1', { hourlyRate: 1500, taxRatePercent: 0, validFrom: desde });
    ca2 = await makeContract(request, ator, pa.code, 'CA2', { hourlyRate: 1800, taxRatePercent: 21, validFrom: desde });
    cb1 = await makeContract(request, ator, pb.code, 'CB1', { hourlyRate: 1000, taxRatePercent: 10.5, validFrom: desde });

    p1 = novoPaciente(641000); s1 = novoServico(p1); s4 = novoServico(p1);
    p2 = novoPaciente(642000); s2 = novoServico(p2);
    p3 = novoPaciente(643000); s3 = novoServico(p3);
    p5 = novoPaciente(645000); s5 = novoServico(p5);
    // O paciente 1 tem a cobertura verificada = a obra social A: o vínculo a ela CASA.
    runSQL(`INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source, provider_code) VALUES ('${p1.patientId}', 1, '${pa.name}', 'admin_manual', '${pa.code}')`);
    // Alt 1: o serviço 2 já teve vínculo e ele TERMINOU (ontem).
    await vincular(request, p2, s2, ca1.id, addDays(hoje, -30));
    await apiOk(request, ator, 'POST', `/api/admin/patients/${p2.patientId}/contracted-services/${s2}/contract-link/end`, { validTo: addDays(hoje, -1) }, 200);
    // Alt 4: o serviço 5 está vinculado (a pessoa sem cobertura NÃO pode ver o nome).
    await vincular(request, p5, s5, ca1.id, addDays(hoje, -30));
    await request.dispose();
  });

  test.afterAll(() => {
    purgeProviders(); // o vínculo aponta para o serviço: sai ANTES do paciente
    for (const p of pacientes) {
      runSQL(`DELETE FROM patients WHERE id = '${p.patientId}'`);
      cleanupPatientDeep(p.patientId);
    }
    dropActors();
  });

  test('FELIZ: vincula pela cascata (obra social, contrato, vigência digitada); ficha = rota; o select mostra o pagador já escolhido pelo nome; trocar o contrato muda valor e imposto', async ({ page, request }) => {
    await loginAs(page, ator.user);
    await abrirPainel(page, p1, s1);
    await expect(page.getByTestId('svc-payer')).toHaveAttribute('data-state', 'NO_CONTRACT');

    await page.getByTestId('svc-contract-link-open').click();
    await expect(page.getByTestId('svc-contract-form-link')).toBeVisible();
    await expect(page.getByTestId('svc-contract-valid-from')).toHaveValue(hoje); // o início sugerido é o "hoje" da RESPOSTA
    await escolher(page, 'svc-contract-provider', pa.name);
    await escolher(page, 'svc-contract-contract', ca1.name);
    await expect(page.getByTestId('svc-contract-preview-price')).toContainText(V1500);
    await expect(page.getByTestId('svc-contract-preview-tax')).toContainText('Exento (0 %)');
    await digitarData(page, 'svc-contract-valid-from', addDays(hoje, -30)); // início digitado por uma pessoa
    const vinculado = page.waitForResponse((r) => r.request().method() === 'POST' && /\/contract-link$/.test(r.url()));
    await page.getByTestId('svc-contract-save').click();
    expect((await vinculado).status()).toBe(201);

    const painel = page.getByTestId(`svc-contract-panel-${s1}`);
    await expect(painel.getByTestId('svc-payer')).toHaveAttribute('data-state', 'LINKED');
    await expect(painel.getByTestId('svc-payer-provider')).toHaveText(pa.name);
    await expect(painel.getByTestId('svc-payer-contract')).toHaveText(ca1.name);
    await expect(painel.getByTestId('svc-payer-kind')).toHaveText(/Obra Social/);
    await expect(painel.getByTestId('svc-price')).toContainText(V1500);
    await expect(painel.getByTestId('svc-tax')).toHaveText('Exento (0 %)');
    await expect(painel.getByTestId('svc-coverage-match')).toHaveAttribute('data-state', 'MATCH');
    const aposVincular = await fichaIgualRota(request, ator, p1, s1);
    expect(aposVincular.payer.names).toMatchObject({ providerName: pa.name, contractName: ca1.name });

    await medirAlinhamento(page, s1);

    // "Cambió el contrato": o select da obra social mostra o pagador JÁ ESCOLHIDO, pelo nome, e fica travado (com o cadeado).
    await page.getByTestId('svc-contract-change-open').click();
    await expect(page.getByTestId('svc-contract-chooser')).toBeVisible();
    await page.getByTestId('svc-contract-switch-open').click();
    await expect(page.getByTestId('svc-contract-provider-lock')).toBeVisible();
    const selectObra = page.getByTestId('svc-contract-provider');
    await expect(selectObra).toBeDisabled();
    await expect(selectObra).toHaveValue(pa.code);
    await expect(selectObra.locator('option:checked')).toHaveText(pa.name);
    await escolher(page, 'svc-contract-contract', ca2.name);
    await expect(page.getByTestId('svc-contract-preview-price')).toContainText(V1800);
    await expect(page.getByTestId('svc-contract-preview-tax')).toContainText('21 %');
    const trocado = page.waitForResponse((r) => r.request().method() === 'POST' && /\/contract-link\/supersede$/.test(r.url()));
    await page.getByTestId('svc-contract-save').click();
    expect((await trocado).status()).toBe(200);

    await expect(painel.getByTestId('svc-payer-contract')).toHaveText(ca2.name);
    await expect(painel.getByTestId('svc-price')).toContainText(V1800);
    await expect(painel.getByTestId('svc-tax')).toHaveText('21 %');
    const aposTroca = await fichaIgualRota(request, ator, p1, s1);
    expect(aposTroca.payerHistory.length).toBeGreaterThan(aposVincular.payerHistory.length); // o contrato anterior ficou no histórico
    await page.screenshot({ path: 'test-results/058a-cascata-servico.png', fullPage: true });
  });

  /** Serviço 2 (vínculo encerrado): tenta vincular de novo e leva o REQUIRES_NEW_SERVICE. */
  async function provocarRequiresNewService(page: Page): Promise<void> {
    await abrirPainel(page, p2, s2);
    await expect(page.getByTestId('svc-payer')).toHaveAttribute('data-state', 'NO_CONTRACT'); // encerrado ontem: nada vigente hoje
    await page.getByTestId('svc-contract-link-open').click();
    await escolher(page, 'svc-contract-provider', pb.name);
    await escolher(page, 'svc-contract-contract', cb1.name);
    await page.getByTestId('svc-contract-save').click();
    await expect(page.getByTestId('svc-contract-error')).toHaveText('Cambiar de obra social es otra admisión: hay que crear un servicio nuevo.');
  }
  const linhasDoServico2 = (): string => runSQL(`SELECT count(*) FROM contracted_service_contract WHERE contracted_service_id = '${s2}'`).split('\n')[0].trim();

  test('ALTERNATIVO 1: vínculo encerrado + vincular de novo = REQUIRES_NEW_SERVICE; quem CRIA serviço vê o botão que abre o formulário do serviço novo', async ({ page }) => {
    await loginAs(page, comCriar.user);
    const antes = linhasDoServico2(); // o encerramento já gravou a linha marcada + a reinserida fechada
    await abrirPainel(page, p2, s2);
    await expect(page.getByTestId('svc-contract-new-service')).toBeVisible(); // há histórico e a célula `create`: o caminho é outra admissão
    await provocarRequiresNewService(page);
    await expect(page.getByTestId('svc-contract-error-new-service')).toBeVisible();
    expect(linhasDoServico2()).toBe(antes); // nada novo gravado
    await page.getByTestId('svc-contract-error-new-service').click();
    await expect(page.getByTestId('contracted-service-new')).toBeVisible({ timeout: 15_000 });
  });

  test('ALTERNATIVO 1b (ABAC): sem `patient_services:create` a frase do REQUIRES_NEW_SERVICE e do estado terminado ficam, mas NÃO o botão "Crear un servicio nuevo"', async ({ page }) => {
    await loginAs(page, ator.user); // `ator` tem `patient_services:update` (vincular) e NÃO tem `create`
    await abrirPainel(page, p2, s2);
    await expect(page.getByTestId('svc-payer')).toContainText('Sin cobertura vigente'); // a frase do estado terminado continua
    await expect(page.getByTestId('svc-contract-new-service')).toHaveCount(0);
    await expect(page.getByTestId('svc-contract-link-open')).toBeVisible(); // vincular segue (é `update`)
    await provocarRequiresNewService(page);
    await expect(page.getByTestId('svc-contract-error-new-service')).toHaveCount(0); // a frase fica, o botão não
  });

  test('ALTERNATIVO 2: outro operador vinculou enquanto este escolhia = USE_CORRECTION; recarregado, "Se cargó mal" (corregir) troca o contrato', async ({ page, request }) => {
    await loginAs(page, ator.user);
    await abrirPainel(page, p3, s3);
    await page.getByTestId('svc-contract-link-open').click();
    await escolher(page, 'svc-contract-provider', pa.name);
    await escolher(page, 'svc-contract-contract', ca1.name);
    // Outro operador vincula o MESMO serviço (ao contrato A2) antes do Guardar desta tela.
    await vincular(request, p3, s3, ca2.id, addDays(hoje, -30));
    await page.getByTestId('svc-contract-save').click();
    await expect(page.getByTestId('svc-contract-error')).toHaveText(
      'Este servicio ya tiene un contrato vigente y ningún período anterior. Para cambiarlo, corregí el vínculo o creá un servicio nuevo.');

    // Recarregado, o serviço aparece vinculado ao contrato do outro operador; a correção (mesma data de início) o troca.
    await abrirPainel(page, p3, s3);
    await expect(page.getByTestId('svc-payer-contract')).toHaveText(ca2.name);
    await page.getByTestId('svc-contract-change-open').click();
    await page.getByTestId('svc-contract-correct-open').click();
    await escolher(page, 'svc-contract-provider', pa.name); // na CORREÇÃO a obra social destrava
    await escolher(page, 'svc-contract-contract', ca1.name);
    await digitarData(page, 'svc-contract-valid-from', addDays(hoje, -30));
    const corrigido = page.waitForResponse((r) => r.request().method() === 'POST' && /\/contract-link\/supersede$/.test(r.url()));
    await page.getByTestId('svc-contract-save').click();
    expect((await corrigido).status()).toBe(200);
    await expect(page.getByTestId('svc-payer-contract')).toHaveText(ca1.name);
    await expect(page.getByTestId('svc-price')).toContainText(V1500);
  });

  test('ALTERNATIVO 3: serviço nunca vinculado = NO_CONTRACT na ficha (pagador, valor, imposto e cobertura dizem "sem contrato"), na lista e no detalhe', async ({ page, request }) => {
    const s = await fichaIgualRota(request, ator, p1, s4);
    expect(s.payer.state).toBe('NO_CONTRACT');
    expect(s.price.state).toBe('NO_CONTRACT');
    expect(s.coverageMatch.state).toBe('NO_PAYER');

    await loginAs(page, ator.user);
    await abrirPainel(page, p1, s4);
    await expect(page.getByTestId('svc-payer')).toHaveAttribute('data-state', 'NO_CONTRACT');
    await expect(page.getByTestId('svc-payer')).toContainText('Este servicio todavía no tiene obra social ni contrato');
    await expect(page.getByTestId('svc-payer')).toContainText('Hasta vincularlo no hay valor ni impuesto para este servicio.');
    await expect(page.getByTestId('svc-price')).toHaveCount(0); // sem vínculo não há valor nem imposto para mostrar
    await expect(page.getByTestId('svc-tax')).toHaveCount(0);
    await expect(page.getByTestId('svc-contract-link-open')).toHaveText('Vincular obra social y contrato');
    await expect(page.getByTestId('svc-contract-change-open')).toHaveCount(0);
    await expect(page.getByTestId('svc-contract-new-service')).toHaveCount(0); // sem histórico: o caminho é vincular, não outro serviço

    // O detalhe (somente leitura) diz o mesmo.
    await page.getByTestId('patient-contracted-services-edit-drawer').getByLabel('Cerrar').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toHaveCount(0);
    await page.getByTestId(`contracted-service-row-${s4}`).click();
    await expect(page.getByTestId('contracted-service-detail-drawer')).toBeVisible();
    await expect(page.getByTestId('svc-detail-contract')).toContainText('Sin contrato vinculado');
    await expect(page.getByTestId('svc-detail-value')).toContainText('Sin contrato vinculado');
    await expect(page.getByTestId('svc-detail-coverage-match')).toHaveAttribute('data-state', 'NO_PAYER');
  });

  test('ALTERNATIVO 4 (ABAC): sem `patient_coverage:read` o pagador vem REDACTED sem nome (R7), a cobertura REDACTED, sem a resposta "Cambió el contrato"; sem valor o cadeado', async ({ page, request }) => {
    // Controle positivo: quem tem a cobertura lê os NOMES do MESMO serviço.
    const comNomes = await fichaIgualRota(request, ator, p5, s5);
    expect(comNomes.payer.names).toMatchObject({ providerName: pa.name, contractName: ca1.name });
    // A projeção para quem não tem a célula: sem nome nenhum e cobertura REDACTED (a ficha e a rota concordam).
    const oculto = await fichaIgualRota(request, semCobertura, p5, s5);
    expect(oculto.payer.state).toBe('LINKED');
    expect(oculto.payer.names).toBeNull();
    expect(oculto.coverageMatch).toEqual({ state: 'REDACTED' });
    expect(JSON.stringify(oculto)).not.toContain(pa.name);
    expect((await api(request, semCobertura, 'GET', `/api/admin/patients/${p5.patientId}/contracted-services`)).status).toBe(200);

    await loginAs(page, semCobertura.user);
    await abrirPainel(page, p5, s5);
    await expect(page.getByTestId('svc-payer')).toHaveAttribute('data-state', 'LINKED');
    await expect(page.getByTestId('svc-payer')).toContainText('Obra social no visible con tu permiso');
    await expect(page.getByTestId('svc-coverage-match')).toHaveAttribute('data-state', 'REDACTED');
    await expect(page.getByTestId('svc-coverage-match')).toHaveText('No visible con tu permiso (cobertura).');
    await expect(page.getByTestId('svc-price')).toContainText('🔒 Sin permiso para ver el valor');
    await page.getByTestId('svc-contract-change-open').click();
    await expect(page.getByTestId('svc-contract-switch-open')).toHaveCount(0); // sem o nome da obra social não há contrato a trocar
    await expect(page.getByTestId('svc-contract-correct-open')).toBeVisible();
    const corpo = await page.locator('body').innerText();
    expect(corpo).not.toContain(pa.name);
    expect(corpo).not.toContain(ca1.name);
  });
});
