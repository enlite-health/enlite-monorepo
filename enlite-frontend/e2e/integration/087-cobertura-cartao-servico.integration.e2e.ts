/**
 * 087-cobertura-cartao-servico.integration.e2e.ts @integration — spec 087: o cartão "Cobertura médica" LÊ do serviço contratado e o portão `COVERAGE` do recrutamento
 * exige o VÍNCULO VIGENTE do serviço (contrato ou Particular) — não mais a cobertura informada/verificada do paciente.
 *
 * E2E DE TELA, SEM MOCK de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (molde `058a-cascata-servico`), clique e teclado de humano
 * (select real, data digitada). Nenhum `page.route` de dado. O cenário (obras sociais, contratos com termo, pacientes, serviços e vínculos) vem da API real.
 * Roda no job do ABAC (`_frontend-integration.yml`): precisa de staff em grupo + células.
 *
 *  FELIZ         — paciente com 1 serviço vinculado à obra social A -> o cartão mostra "A" na linha "Cobertura actual" (e NENHUMA linha informada/verificada) -> o foguete
 *                  "Activar reclutamiento" está habilitado -> o clique ativa DE VERDADE (201, vaga do serviço criada no banco).
 *  ALTERNATIVO 1 — (o servidor recusa) serviço SEM vínculo, com `insurance_informed='OSDE'` semeado: o cartão diz "Sin obra social vinculada" + o aviso de gerir no serviço; o foguete
 *                  está desabilitado com o tooltip novo; forçar a rota devolve 422 `PATIENT_NOT_READY` com `COVERAGE`; o pedido de foco do checklist abre o painel de contrato do
 *                  serviço; vincular PELA TELA (obra social, contrato, vigência digitada) e o foguete habilita.
 *  ALTERNATIVO 2 — (o estado muda por fora) com a tela aberta o vínculo é ENCERRADO por API: após recarregar, o cartão cai para "Sin obra social vinculada" e o foguete desabilita;
 *                  um serviço NOVO com vínculo traz a obra social de volta e o foguete DELE habilita (vínculo encerrado é terminal: o caminho é outro serviço).
 *  EXTRAS        — 2 serviços da MESMA obra social = UMA pílula (sem repetir); ator só com `patient_coverage:read` vê "Sin permiso" (nunca "vazio"); o drawer não tem `#pcv-codes` e não lê
 *                  o catálogo de obras sociais; o PATCH de coverage com `insuranceVerifiedCodes` é 400. (N pagadores DISTINTOS no mesmo paciente é impossível no banco:
 *                  `TWO_PAYERS_OVERLAP` — o caso de 3 pílulas é medido no unitário do cartão.)
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { loginAs } from '../helpers/abac-stack-helper';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import { RECRUITMENT_FIELDS_E2E } from '../helpers/recruitment-fields-e2e';
import {
  CELLS_FICHA, CELLS_INSURANCE_ALL, seedActor, dropActors, purgeProviders, api, apiOk, makeProvider, makeContract, asOfAR, addDays,
  digitarData, escolher, type Actor, type ProviderMade, type ContractMade, type Cell,
} from '../helpers/insurance-058a-helper';

type Seed = { patientId: string; addressId: string; stamp: string };

const SIN_VINCULO = 'Sin obra social vinculada';
const TOOLTIP_FALTA_CONTRATO = 'Falta: Contrato vinculado al servicio';

test.use({ viewport: { width: 1600, height: 1200 }, video: 'on' });

test.describe('087-cobertura-cartao-servico — o cartão lê do serviço e o portão COVERAGE exige o vínculo (spec 087) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let ator: Actor;
  let soCobertura: Actor;
  let pa: ProviderMade;
  let ca: ContractMade;
  let hoje = '';
  const pacientes: Seed[] = [];

  const novoPaciente = (base: number): Seed => { const p = seedActivatablePatient(base); pacientes.push(p); return p; };

  /** Serviço "lançável" pela API REAL (os 5 campos da vaga + endereço + 1 faixa de horário); SEM vínculo — quem vincula é cada teste. */
  async function novoServico(request: APIRequestContext, p: Seed): Promise<string> {
    const s = await apiOk<{ id: string }>(request, ator, 'POST', `/api/admin/patients/${p.patientId}/contracted-services`, {
      serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId: p.addressId,
      schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], ...RECRUITMENT_FIELDS_E2E,
    }, 201);
    return s.id;
  }
  const vincular = (request: APIRequestContext, p: Seed, sid: string): Promise<unknown> =>
    apiOk(request, ator, 'POST', `/api/admin/patients/${p.patientId}/contracted-services/${sid}/contract-link`, { contractId: ca.id, validFrom: addDays(hoje, -30) }, 201);

  async function abrirServicio(page: Page, p: Seed): Promise<void> {
    await page.goto(`/admin/patients/${p.patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await expect(page.getByTestId('cobertura-medica-card')).toBeVisible({ timeout: 20_000 });
  }
  const foguete = (page: Page, sid: string) => page.getByTestId(`contracted-service-activate-recruitment-${sid}`);
  const vagasDoServico = (sid: string): number => Number(runSQL(`SELECT count(*) FROM job_postings WHERE contracted_service_id = '${sid}'`).trim());

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const celulasDoFoguete: Cell[] = [['vacancy', 'read'], ['vacancy', 'update']];
    ator = seedActor('087', [...CELLS_FICHA, ...CELLS_INSURANCE_ALL, ...celulasDoFoguete, ['patient_services', 'create']]);
    // Só cobertura: lê e edita o cartão, mas NÃO lê serviços (a linha "Cobertura actual" não tem de onde sair).
    soCobertura = seedActor('087-so-cobertura', [['patient', 'read'], ['patient_identity', 'read'], ['patient_coverage', 'read'], ['patient_coverage', 'update']]);
    pa = await makeProvider(request, ator, 'Cobertura087');
    hoje = await asOfAR(request, ator);
    ca = await makeContract(request, ator, pa.code, 'C087', { hourlyRate: 1500, taxRatePercent: 0, validFrom: addDays(hoje, -60) });
    await request.dispose();
  });

  test.afterAll(() => {
    purgeProviders(); // o vínculo aponta para o serviço: sai ANTES do paciente
    for (const p of pacientes) cleanupPatientDeep(p.patientId); // apaga as vagas, os serviços, os endereços e o paciente
    dropActors();
  });

  test('FELIZ: serviço vinculado -> o cartão mostra a obra social (sem linhas informada/verificada) -> o foguete habilita e ativa de verdade', async ({ page, request }) => {
    const p = novoPaciente(871000);
    const sid = await novoServico(request, p);
    await vincular(request, p, sid);

    await loginAs(page, ator.user);
    await abrirServicio(page, p);

    // A UMA linha do cartão: lida do serviço. A informada ('OSDE', semeada por `seedActivatablePatient`) NÃO aparece em lugar nenhum do cartão.
    await expect(page.getByTestId('coverage-current-value')).toHaveText(pa.name, { timeout: 20_000 });
    await expect(page.getByTestId('coverage-informed')).toHaveCount(0);
    await expect(page.getByTestId('coverage-verified')).toHaveCount(0);
    await expect(page.getByTestId('cobertura-medica-card')).not.toContainText('OSDE');
    await expect(page.getByTestId('coverage-manage-in-service')).toHaveCount(0);

    // O foguete habilita (o gate do FRONT leu `payer.state === 'LINKED'`) e o clique ativa de verdade (o gate do BACK concorda: 201).
    const btn = foguete(page, sid);
    await expect(btn).toBeEnabled({ timeout: 20_000 });
    expect(await btn.getAttribute('title')).toBeNull();
    expect(vagasDoServico(sid)).toBe(0);
    const ativado = page.waitForResponse((r) => r.request().method() === 'POST' && /\/activate-recruitment$/.test(r.url()));
    await btn.click();
    expect((await ativado).status()).toBe(201);
    await expect.poll(() => vagasDoServico(sid), { timeout: 20_000 }).toBe(1);
    await page.screenshot({ path: 'test-results/087-cobertura-cartao-servico-feliz.png', fullPage: true });
  });

  test('ALTERNATIVO 1 (servidor recusa): sem vínculo + insurance_informed semeado -> cartão "sin vínculo", foguete desabilitado, 422 COVERAGE, foco abre o painel, vincula pela tela e habilita', async ({ page, request }) => {
    const p = novoPaciente(872000);
    const sid = await novoServico(request, p);
    // `seedActivatablePatient` já semeia `insurance_informed = 'OSDE'` — ANTES da 087 isso sozinho destravava o portão.
    expect(runSQL(`SELECT insurance_informed FROM patients WHERE id = '${p.patientId}'`).trim()).toBe('OSDE');

    await loginAs(page, ator.user);
    await abrirServicio(page, p);
    await expect(page.getByTestId('coverage-current-value')).toHaveText(SIN_VINCULO, { timeout: 20_000 });
    await expect(page.getByTestId('coverage-manage-in-service')).toContainText('La cobertura se gestiona en el servicio contratado');
    await expect(page.getByTestId('cobertura-medica-card')).not.toContainText('OSDE');

    // O foguete está desabilitado, com o tooltip novo (o contrato vinculado do SERVIÇO, não "cobertura").
    const btn = foguete(page, sid);
    await expect(btn).toBeDisabled();
    expect(await btn.getAttribute('title')).toBe(TOOLTIP_FALTA_CONTRATO);

    // Forçar a rota: o SERVIDOR recusa pelo mesmo motivo (mesma regra, mesmo fragmento), com a informada preenchida.
    const forcado = await api<{ missing?: string[] }>(request, ator, 'POST', `/api/admin/patients/${p.patientId}/contracted-services/${sid}/activate-recruitment`, {});
    expect(forcado.status).toBe(422);
    expect(forcado.body?.code).toBe('PATIENT_NOT_READY');
    expect(forcado.body?.details?.missing).toContain('COVERAGE');
    expect(vagasDoServico(sid)).toBe(0);

    // O foco do checklist ("falta cobertura") abre o painel de contrato do SERVIÇO — não o drawer de cobertura.
    await page.getByRole('button', { name: 'Ir a completar Contrato vinculado al servicio' }).click();
    await expect(page.getByTestId(`svc-contract-panel-${sid}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('patient-coverage-edit-drawer')).toHaveCount(0);

    // Vincula PELA TELA, como uma pessoa: obra social, contrato, vigência digitada.
    await page.getByTestId('svc-contract-link-open').click();
    await expect(page.getByTestId('svc-contract-form-link')).toBeVisible();
    await escolher(page, 'svc-contract-provider', pa.name);
    await escolher(page, 'svc-contract-contract', ca.name);
    await digitarData(page, 'svc-contract-valid-from', addDays(hoje, -30));
    const vinculado = page.waitForResponse((r) => r.request().method() === 'POST' && /\/contract-link$/.test(r.url()));
    await page.getByTestId('svc-contract-save').click();
    expect((await vinculado).status()).toBe(201);
    await expect(page.getByTestId(`svc-contract-panel-${sid}`).getByTestId('svc-payer')).toHaveAttribute('data-state', 'LINKED');

    // Fecha o formulário do serviço: a ficha RELÊ (o onSaved do painel) — o cartão e o foguete concordam com o vínculo novo.
    await page.getByLabel('Cerrar').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('coverage-current-value')).toHaveText(pa.name, { timeout: 20_000 });
    await expect(foguete(page, sid)).toBeEnabled({ timeout: 20_000 });
  });

  test('ALTERNATIVO 2 (o estado muda por fora): vínculo encerrado por API -> o cartão cai e o foguete desabilita; um serviço novo vinculado traz a obra social de volta', async ({ page, request }) => {
    const p = novoPaciente(873000);
    const sid = await novoServico(request, p);
    await vincular(request, p, sid);

    await loginAs(page, ator.user);
    await abrirServicio(page, p);
    await expect(page.getByTestId('coverage-current-value')).toHaveText(pa.name, { timeout: 20_000 });
    await expect(foguete(page, sid)).toBeEnabled({ timeout: 20_000 });

    // Por fora da tela: outro operador ENCERRA o vínculo (ontem). A tela aberta ainda mostra o estado de antes até reler.
    await apiOk(request, ator, 'POST', `/api/admin/patients/${p.patientId}/contracted-services/${sid}/contract-link/end`, { validTo: addDays(hoje, -1) }, 200);
    await page.reload();
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await expect(page.getByTestId('coverage-current-value')).toHaveText(SIN_VINCULO, { timeout: 20_000 });
    await expect(foguete(page, sid)).toBeDisabled();
    expect(await foguete(page, sid).getAttribute('title')).toBe(TOOLTIP_FALTA_CONTRATO);

    // Reabre com um vínculo NOVO: vínculo encerrado é terminal (o caminho é um serviço novo), e a obra social volta ao cartão.
    const sid2 = await novoServico(request, p);
    await vincular(request, p, sid2);
    await page.reload();
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await expect(page.getByTestId('coverage-current-value')).toHaveText(pa.name, { timeout: 20_000 });
    await expect(foguete(page, sid2)).toBeEnabled({ timeout: 20_000 });
    await expect(foguete(page, sid)).toBeDisabled(); // o serviço antigo continua sem vínculo vigente
  });

  test('EXTRA: 2 serviços da MESMA obra social = UMA pílula (sem repetir); o drawer não tem `#pcv-codes` nem lê o catálogo; o PATCH com `insuranceVerifiedCodes` é 400', async ({ page, request }) => {
    const p = novoPaciente(874000);
    const s1 = await novoServico(request, p); await vincular(request, p, s1);
    const s2 = await novoServico(request, p); await vincular(request, p, s2);

    const catalogoLido: string[] = [];
    page.on('request', (r) => { if (/\/catalogs\/insurance-providers/.test(r.url())) catalogoLido.push(r.url()); });
    await loginAs(page, ator.user);
    await abrirServicio(page, p);
    await expect(page.getByTestId('coverage-current-value')).toHaveText(pa.name, { timeout: 20_000 });
    await expect(page.getByTestId('coverage-current-value').locator('span[title]')).toHaveCount(1);

    await page.getByTestId('edit-coverage-btn').click();
    await expect(page.getByTestId('patient-coverage-edit-drawer')).toBeVisible();
    await expect(page.locator('#pcv-codes')).toHaveCount(0);
    await expect(page.getByTestId('pcv-affiliate')).toBeVisible();
    expect(catalogoLido, 'o drawer não chama mais o catálogo de obras sociais').toEqual([]);

    // Credencial: digitada como uma pessoa; salva; o cartão mostra o valor que FICOU.
    await page.getByTestId('pcv-affiliate').click();
    await expect(page.getByTestId('pcv-affiliate')).toBeFocused();
    await page.keyboard.type('AF-087-0001');
    await expect(page.getByTestId('pcv-affiliate')).toHaveValue('AF-087-0001');
    const salvo = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/patients\/[^/]+\/coverage$/.test(r.url()));
    await page.getByTestId('pcv-save').click();
    expect((await salvo).status()).toBe(200);
    await expect(page.getByTestId('patient-coverage-edit-drawer')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('cobertura-medica-card')).toContainText('AF-087-0001');

    // O servidor recusa a escrita das "verificadas": 400, e nada é gravado.
    const recusado = await api(request, ator, 'PATCH', `/api/admin/patients/${p.patientId}/coverage`, { insuranceVerifiedCodes: ['OSDE'] });
    expect(recusado.status).toBe(400);
    expect(runSQL(`SELECT count(*) FROM patient_insurance_verified WHERE patient_id = '${p.patientId}'`).trim()).toBe('0');
  });

  test('EXTRA (ABAC): ator só com `patient_coverage:read` vê o cartão com "Sin permiso" na linha de cobertura — nunca "vazio"; Credencial e emergência seguem', async ({ page, request }) => {
    const p = novoPaciente(875000);
    const sid = await novoServico(request, p); await vincular(request, p, sid);

    await loginAs(page, soCobertura.user);
    await page.goto(`/admin/patients/${p.patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await expect(page.getByTestId('cobertura-medica-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('coverage-current-value')).toHaveText('Sin permiso', { timeout: 20_000 });
    await expect(page.getByTestId('coverage-emergency-contacts')).toBeVisible();
    await expect(page.getByTestId('edit-coverage-btn')).toBeVisible();
    // E o NOME da obra social não vaza para o DOM de quem não lê serviços.
    await expect(page.locator('body')).not.toContainText(pa.name);
  });
});
