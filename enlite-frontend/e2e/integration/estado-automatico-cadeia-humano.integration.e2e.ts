/**
 * estado-automatico-cadeia-humano.integration.e2e.ts @integration — estado-automatico-do-paciente, F4 (D807 item 1): a CADEIA do fluxo automático
 * pela TELA, numa execução só, com um humano (click + `keyboard.type`, valores lidos da tela) e o estado relido do BANCO em cada passo.
 *
 * Stack real (Vite + API docker com mock auth, engine ABAC OFF → `cells === null`, o ator é `admin` + linha em `users`) + Postgres real, SEM
 * `page.route` de dado (o login só intercepta o Identity Toolkit, como `loginAs`). O que a tela não oferece é feito pela API e DECLARADO no
 * nome do passo: só a montagem do itinerário (a aba não a marca — mesmo critério da cadeia-completa) e o semear de serviço/prestador (SQL/API).
 *
 *  1  paciente em Admisión (lido do Kanban) com 2 serviços: S1 completo (2 faixas de 4 h) e S2 INCOMPLETO (sem endereço);
 *  2  A1-tela — o foguete do S2 fica DESABILITADO e o clique de mouse não cria vaga (0 vaga, estado intacto);
 *     (o S2 é desativado por SQL depois do passo 2: com ele ativo a derivação é recusada por completude — achado na LISTA da change)
 *  3  foguete do S1 → card do Kanban em "Búsqueda" + subcard do serviço; `patients.status = SEARCHING`; trilha `recruitment_activation`;
 *  4  a lista de vagas mostra o estado do PACIENTE ("Búsqueda") ao lado do ciclo de vida da vaga ("Borrador");
 *  5  [API] montar o itinerário; alocar o prestador A na 1ª faixa PELA TELA (cobre 4 de 8 h) → "Reemplazos" (card, lista de vagas, banco, trilha `system`);
 *  6  alocar o prestador B na 2ª faixa PELA TELA (cobre 8 de 8 h) → "Activo";
 *  7  desalocar (Quitar del itinerario, pela tela) o prestador B → "Reemplazos"; e o A → "Búsqueda" (as duas pontas da derivação, de volta).
 *
 * Outbound mapeado: foguete, alocação, remoção e as leituras só fazem SELECT/INSERT/UPDATE em Postgres; nenhuma Talentum (a vaga fica em rascunho,
 * sem publicar), WhatsApp, Ana Care, Google ou Short.io no caminho; o teste registra todo host que a PÁGINA pede e exige que nenhum seja de canal
 * real (`CADEIA_FORBIDDEN_HOSTS`). Fixtures sintéticas (sobrenome " QA"), nenhum texto clínico. Screenshot por passo (anexo) + vídeo.
 *
 * Roda no job padrão (`grep:` do `pr-gate.yml`, engine OFF). O ataque por tela ao foguete incompleto (passo 2) mora aqui; os ataques de API
 * moram em `worker-functions/tests/e2e/estado-automatico-ataques.e2e.test.ts`.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import {
  mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR, postContractedServiceViaApi, clickFoguete, readPatientKanbanColumn,
} from '../helpers/lancamento-e2e-helper';
import { insertTestPatient, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertAptoWorker } from '../helpers/eligibility-worker-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
import { runSQL, cleanupPatientDeep } from '../helpers/patient-detail-a-helper';
import { readItineraryApi } from '../helpers/itinerario-e2e-helper';
import { assembleApi, allocationOptionsApi, insertServiceNoAddressSql } from '../helpers/itinerario-escrita-e2e-helper';
import { openItineraryTab, openFixedSchedule, expectHorasCubiertas } from '../helpers/itinerario-aba-e2e-helper';
import { readSubcardPair } from '../helpers/kanban-subcard-e2e-helper';
import { cleanupSubstituicao } from '../helpers/substituicao-e2e-helper';
import { CADEIA_FORBIDDEN_HOSTS } from '../helpers/cadeia-completa-e2e-helper';
import { escolherNaListaAberta, escolherNoCombo } from '../helpers/combobox';

const STAFF = mockAdminUserFor('estado-automatico-cadeia');
const STAMP = Date.now().toString().slice(-6);
const CASO = 948000 + (Date.now() % 900);
const MOTIVO_DESISTENCIA = 'El prestador desistió'; // DESISTENCIA_DO_PRESTADOR

const statusDe = (id: string): string => runSQL(`SELECT status FROM patients WHERE id = '${id}'`).trim();
const ultimaLinha = (id: string): string =>
  runSQL(`SELECT COALESCE(old_value, '<NULL>') || '|' || new_value || '|' || COALESCE(change_source, '<NULL>') FROM patient_status_history WHERE patient_id = '${id}' ORDER BY created_at DESC, id DESC LIMIT 1`).trim();
const contarTrilha = (id: string, fonte: string): number =>
  Number(runSQL(`SELECT count(*) FROM patient_status_history WHERE patient_id = '${id}' AND change_source = '${fonte}'`).trim());
const vagasDe = (id: string): number => Number(runSQL(`SELECT count(*) FROM job_postings WHERE patient_id = '${id}'`).trim());

/** Relê o banco e a trilha neste passo, imprime só ids/estados e anexa o screenshot do passo. */
async function registrar(page: Page, info: TestInfo, passo: string, patientId: string): Promise<void> {
  console.log('[estado-auto]', passo, statusDe(patientId), ultimaLinha(patientId));
  await info.attach(`passo-${passo}`, { body: await page.screenshot({ animations: 'disabled', caret: 'hide' }), contentType: 'image/png' });
}

/** O card do paciente está NESTA coluna do Kanban (lido da tela) e, quando há, o par do subcard do serviço. */
async function cardNaColuna(page: Page, patientId: string, coluna: string): Promise<void> {
  expect(await readPatientKanbanColumn(page, patientId)).toBe(coluna);
}

/** Lista de vagas estreitada pelo número do caso (gesto humano: clique + teclado): o estado do paciente e o ciclo de vida lidos da tela. */
async function vagaMostra(page: Page, vacancyId: string, estadoPaciente: string, cicloDeVida: string): Promise<void> {
  await page.goto('/admin/vacancies');
  await expect(page.getByTestId('vacancies-col-case')).toBeVisible({ timeout: 20_000 });
  const busca = page.getByPlaceholder(/^Buscar por/);
  await busca.click();
  await expect(busca).toBeFocused();
  await page.keyboard.type(String(CASO));
  const fila = page.getByTestId(`vacancy-row-${vacancyId}`);
  await expect(fila).toBeVisible({ timeout: 20_000 });
  await expect(fila.getByTestId('patient-status-pill')).toHaveText(estadoPaciente, { timeout: 15_000 });
  await expect(fila.getByTestId('vacancy-lifecycle-badge')).toHaveText(cicloDeVida);
}

/** Aba Itinerario → "Horario fijo" do serviço → editar a faixa → escolher o prestador digitando → guardar (POST da alocação = 201). */
async function alocarPelaTela(page: Page, patientId: string, serviceId: string, slotId: string, rotulo: string): Promise<void> {
  await openItineraryTab(page, patientId);
  await openFixedSchedule(page, serviceId);
  await page.getByTestId(`itinerario-slot-editar-${slotId}`).click();
  const modal = page.getByTestId('itinerario-editar-modal');
  await expect(modal).toBeVisible();
  const prestador = modal.getByTestId('itinerario-editar-prestador');
  await prestador.click();
  await escolherNaListaAberta(page, prestador, rotulo, { exato: false });
  const [post] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/slots/${slotId}/allocations`)),
    modal.getByTestId('itinerario-editar-guardar').click(),
  ]);
  expect(post.status()).toBe(201);
}

/** Aba Itinerario → editar a faixa → "Quitar del itinerario" do prestador → motivo + "Sigue como reserva" → Confirmar (POST …/end = 200). */
async function quitarPelaTela(page: Page, patientId: string, serviceId: string, slotId: string, workerId: string): Promise<void> {
  await openItineraryTab(page, patientId);
  await openFixedSchedule(page, serviceId);
  await page.getByTestId(`itinerario-slot-editar-${slotId}`).click();
  await expect(page.getByTestId('itinerario-editar-modal')).toBeVisible();
  await page.getByTestId(`itinerario-quitar-${workerId}`).click();
  await expect(page.getByTestId('itinerario-quitar-painel')).toBeVisible();
  await escolherNoCombo(page, page.getByTestId('itinerario-quitar-motivo'), MOTIVO_DESISTENCIA);
  await page.getByTestId('itinerario-quitar-destino-RESERVE').click();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && /\/itinerary\/allocations\/[^/]+\/end$/.test(r.url())),
    page.getByTestId('itinerario-quitar-confirmar').click(),
  ]);
  expect(resp.status()).toBe(200);
  await expect(page.getByTestId('itinerario-quitar-painel')).toHaveCount(0, { timeout: 10_000 });
}

test.use({ video: 'on' }); // vídeo do passo a passo (top-level: o Playwright não aceita `video` dentro de describe)

test.describe('estado-automatico-cadeia-humano: a cadeia do fluxo automático pela tela @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(420_000);
  useLancamentoStaff(STAFF, 'E2E Estado Automatico Cadeia');

  test('foguete → Búsqueda → a vaga mostra o paciente → alocar parte → Reemplazos → alocar o resto → Activo → desalocar → Búsqueda', async ({ page, request }, testInfo) => {
    const hosts: string[] = [];
    page.on('request', (r) => hosts.push(new URL(r.url()).hostname));
    const token = tokenFor(STAFF);

    const { patientId, addressId } = insertTestPatient({
      status: 'ADMISSION', firstName: 'EstadoAuto', lastName: `Cadeia${STAMP} QA`, withAddress: true,
      addressLat: -34.6, addressLng: -58.4, hasConsent: true, insuranceInformed: 'OSDE',
    });
    runSQL(`UPDATE patients SET case_number = ${CASO} WHERE id = '${patientId}'`);
    const workerIds: Array<{ workerId: string; vacancyId: string }> = [];
    try {
      if (!addressId) throw new Error('insertTestPatient sem addressId');
      const s1 = await postContractedServiceViaApi(request, token, patientId, {
        serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId,
        schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }, { dayOfWeek: 2, startTime: '08:00', durationMinutes: 240 }],
      });
      const s2 = insertServiceNoAddressSql(patientId); // incompleto: sem endereço (e sem horário)

      await loginAs(page, STAFF);

      await test.step('1 Admisión: o card do paciente está na coluna de admissão', async () => {
        const coluna = await readPatientKanbanColumn(page, patientId);
        expect(coluna).not.toBe('SEARCHING');
        expect(coluna).not.toBe('NOT_FOUND');
        expect(statusDe(patientId)).toBe('ADMISSION');
        await registrar(page, testInfo, '1-admision', patientId);
      });

      await test.step('2 A1-tela: o foguete do serviço INCOMPLETO está desabilitado e o clique não cria vaga', async () => {
        await page.goto(`/admin/patients/${patientId}`);
        await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 20_000 });
        await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
        const incompleto = page.getByTestId(`contracted-service-activate-recruitment-${s2}`);
        await expect(incompleto).toBeVisible({ timeout: 15_000 });
        await expect(incompleto).toBeDisabled();
        const caixa = await incompleto.boundingBox();
        if (!caixa) throw new Error('foguete do S2 sem caixa');
        await page.mouse.click(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2); // clique de mouse real no botão desabilitado
        await page.waitForTimeout(1_000);
        expect(vagasDe(patientId)).toBe(0);
        expect(statusDe(patientId)).toBe('ADMISSION');
        expect(contarTrilha(patientId, 'recruitment_activation')).toBe(0);
        await registrar(page, testInfo, '2-foguete-incompleto', patientId);
        // fixture (SQL): o S2 incompleto sai da cena. Medido: com ele ativo a derivação para REPLACEMENT/ACTIVE é recusada
        // (`patient_status.derivation_not_ready`, SERVICE_SCHEDULE medido sobre TODOS os serviços) e o paciente fica em Búsqueda — LISTA da change.
        runSQL(`UPDATE patient_contracted_services SET active = false, ended_at = NOW() WHERE id = '${s2}'`);
      });

      let vacancyId = '';
      await test.step('3 foguete do serviço completo → card em "Búsqueda" + subcard; trilha recruitment_activation', async () => {
        vacancyId = await clickFoguete(page, patientId, s1);
        expect(statusDe(patientId)).toBe('SEARCHING');
        expect(ultimaLinha(patientId)).toBe('ADMISSION|SEARCHING|recruitment_activation');
        expect(runSQL(`SELECT is_draft FROM job_postings WHERE id = '${vacancyId}'`).trim()).toBe('t'); // a vaga nasce rascunho
        await cardNaColuna(page, patientId, 'SEARCHING');
        expect(await readSubcardPair(page, s1)).toBe('0/8');
        await registrar(page, testInfo, '3-foguete-busqueda', patientId);
      });

      await test.step('4 a lista de vagas mostra o estado do PACIENTE ("Búsqueda") + o ciclo de vida da vaga ("Borrador")', async () => {
        await vagaMostra(page, vacancyId, 'Búsqueda', 'Borrador');
        await registrar(page, testInfo, '4-vaga-mostra-busqueda', patientId);
      });

      const slots = ((await readItineraryApi(request, patientId)).body.data?.services.find((s) => s.contractedServiceId === s1)?.slots ?? [])
        .slice().sort((a, b) => a.weekday - b.weekday).map((s) => s.id);
      expect(slots).toHaveLength(2);
      const wa = insertAptoWorker({ occupation: 'AT', lastName: `EstadoAutoA${STAMP}` }).workerId;
      const wb = insertAptoWorker({ occupation: 'AT', lastName: `EstadoAutoB${STAMP}` }).workerId;
      for (const w of [wa, wb]) {
        workerIds.push({ workerId: w, vacancyId });
        insertWJA({ workerId: w, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      }
      const opcoes = await allocationOptionsApi(request, token, patientId, s1); // só para LER o rótulo digitável de cada prestador
      const rotulo = (w: string): string => {
        const r = (opcoes.body.data as { options: Array<{ workerId: string; displayName: string | null }> } | undefined)?.options.find((o) => o.workerId === w)?.displayName;
        if (!r) throw new Error(`prestador ${w} sem displayName nas opções`);
        return r;
      };

      await test.step('5 [API: montar o itinerário] alocar A na 1ª faixa pela tela → "Reemplazos"', async () => {
        const montar = await assembleApi(request, token, patientId);
        expect(montar.status).toBe(201);
        expect(statusDe(patientId)).toBe('SEARCHING'); // montar, sem horas cobertas, não muda
        await alocarPelaTela(page, patientId, s1, slots[0], rotulo(wa));
        await expect.poll(() => statusDe(patientId)).toBe('REPLACEMENT');
        expect(ultimaLinha(patientId)).toBe('SEARCHING|REPLACEMENT|system');
        await expectHorasCubiertas(page, '4/8', 15_000);
        await cardNaColuna(page, patientId, 'REPLACEMENT');
        await vagaMostra(page, vacancyId, 'Reemplazos', 'Borrador');
        await registrar(page, testInfo, '5-reemplazos', patientId);
      });

      await test.step('6 alocar B na 2ª faixa pela tela → "Activo"', async () => {
        await alocarPelaTela(page, patientId, s1, slots[1], rotulo(wb));
        await expect.poll(() => statusDe(patientId)).toBe('ACTIVE');
        expect(ultimaLinha(patientId)).toBe('REPLACEMENT|ACTIVE|system');
        await expectHorasCubiertas(page, '8/8', 15_000);
        await cardNaColuna(page, patientId, 'ACTIVE');
        await vagaMostra(page, vacancyId, 'Activo', 'Borrador');
        await registrar(page, testInfo, '6-activo', patientId);
      });

      await test.step('7 desalocar pela tela: B sai → "Reemplazos"; A sai → "Búsqueda"', async () => {
        await quitarPelaTela(page, patientId, s1, slots[1], wb);
        await expect.poll(() => statusDe(patientId)).toBe('REPLACEMENT');
        expect(ultimaLinha(patientId)).toBe('ACTIVE|REPLACEMENT|system');
        await expectHorasCubiertas(page, '4/8', 15_000);
        await cardNaColuna(page, patientId, 'REPLACEMENT');
        await registrar(page, testInfo, '7a-reemplazos-de-volta', patientId);

        await quitarPelaTela(page, patientId, s1, slots[0], wa);
        await expect.poll(() => statusDe(patientId)).toBe('SEARCHING');
        expect(ultimaLinha(patientId)).toBe('REPLACEMENT|SEARCHING|system');
        await expectHorasCubiertas(page, '0/8', 15_000);
        await cardNaColuna(page, patientId, 'SEARCHING');
        await vagaMostra(page, vacancyId, 'Búsqueda', 'Borrador');
        await registrar(page, testInfo, '7b-busqueda-de-volta', patientId);
        expect(contarTrilha(patientId, 'system')).toBe(4);
        expect(contarTrilha(patientId, 'recruitment_activation')).toBe(1);
      });

      expect(hosts.filter((h) => CADEIA_FORBIDDEN_HOSTS.test(h)), 'nenhum host de canal real pedido pela página').toEqual([]);
    } finally {
      cleanupSubstituicao(patientId);
      for (const t of workerIds) cleanupWJAAndEncuadre(t.workerId, t.vacancyId);
      for (const w of new Set(workerIds.map((t) => t.workerId))) cleanupTestWorker(w);
      cleanupPatientDeep(patientId);
    }
  });
});
