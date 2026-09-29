/**
 * kanban-pacientes-itinerario-aba.integration.e2e.ts @integration — Fase 12 (cadeia-paciente-vacante-itinerario),
 * DX-12.4 / DX-12.14 / DX-12.17.
 *
 * A aba "Itinerario" da ficha do paciente (5ª de 6, D442) pela TELA, engine OFF. Nome do ARQUIVO sem
 * tocar `pr-gate.yml`: o caminho casa `kanban-pacientes` do job padrão. Um `test` por critério, sem
 * modo serial; cada um imprime `console.log('[12.<n>]', …)` só com ids/contagens (o título não
 * aparece no log do CI).
 *
 * Semente reusada (nunca copiada): `seedLaunchablePatient` (serviço AT segunda 08-12, 1 slot) →
 * `activateRecruitmentViaApi` → `insertTestWorker({ occupation: 'AT' })` → `insertWJA(…
 * 'QUICK_RESPONSE_TEAM')` (Selecionado C). A alocação do fluxo feliz é pela TELA (clique real +
 * `page.keyboard.type` no campo de busca do `SearchableSelect`). Datas: só o `asOf` da API — nenhuma
 * conta de data no runner. `finally` por teste, por `patient_id`: `cleanupItineraryWrite` →
 * `cleanupWJAAndEncuadre` → `cleanupTestWorker` → `seed.cleanup()`.
 */
import { test, expect, type Response } from '@playwright/test';
import {
  seedLaunchablePatient, mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR, backendUrl,
} from '../helpers/lancamento-e2e-helper';
import {
  activateRecruitmentViaApi, readItineraryApi, createServiceViaApi, ITINERARIO_STAFF,
} from '../helpers/itinerario-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { tokenFor, loginAs } from '../helpers/abac-stack-helper';
import { selectServiceRow } from '../helpers/quadro-c-e2e-helper';
import { allocationOptionsApi, cleanupItineraryWrite } from '../helpers/itinerario-escrita-e2e-helper';
import { openItineraryTab, slotAllocationsInDom, countSlotAllocationsInDom } from '../helpers/itinerario-aba-e2e-helper';

interface OptionDto { workerId: string; displayName: string | null }
interface OptionsData { options: OptionDto[] }

const STAFF = mockAdminUserFor('itinerario-aba');
const CLINICAL = /diagnos|clinic/gi;

/** O par da seção como a tela o monta (`cobertas/contratadas`, `—` sem horas semanais) — oráculo lido da ROTA. */
function expectedPair(cobertas: number, weekly: number | null): string {
  return `${cobertas}/${weekly ?? '—'}`;
}

test.describe('itinerario-aba @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  useLancamentoStaff(STAFF, 'E2E Itinerario Aba');

  test('itinerario-aba', async ({ page, request }, testInfo) => {
    // Critério 8: todo host pedido pela página e os corpos das respostas da aba e da ficha.
    const hosts: string[] = [];
    page.on('request', (r) => hosts.push(new URL(r.url()).host));
    const tabBodies: Array<Promise<string>> = [];
    const detailBodies: Array<Promise<string>> = [];
    let patientIdForBodies = '';
    page.on('response', (r: Response) => {
      const url = r.url();
      if (!url.startsWith(backendUrl()) || !patientIdForBodies) return;
      if (/\/itinerary(\?|$)|\/allocation-options(\?|$)|\/allocations(\?|$)/.test(url)) {
        tabBodies.push(r.text().catch(() => ''));
      } else if (r.request().method() === 'GET' && new RegExp(`/api/admin/patients/${patientIdForBodies}(\\?|$)`).test(url)) {
        detailBodies.push(r.text().catch(() => ''));
      }
    });

    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    patientIdForBodies = seed.patientId;
    const token = tokenFor(ITINERARIO_STAFF);
    const v = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const w = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId: w, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const before = await readItineraryApi(request, seed.patientId);
      expect(before.status).toBe(200);
      const svcBefore = before.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId);
      const slotId = svcBefore?.slots[0]?.id;
      if (!svcBefore || !slotId) throw new Error('itinerario-aba: slot do serviço ausente na semente');

      // O `SearchableSelect` filtra pelo rótulo visível: lê o nome sintético da API DENTRO do teste.
      const opts = await allocationOptionsApi(request, token, seed.patientId, seed.serviceId);
      expect(opts.status).toBe(200);
      const wLabel = (opts.body.data as OptionsData | undefined)?.options.find((o) => o.workerId === w)?.displayName;
      if (!wLabel) throw new Error('itinerario-aba: W sem displayName nas opções');

      await loginAs(page, STAFF);
      await openItineraryTab(page, seed.patientId);

      // Critério 10: 6 abas, o Itinerario é o 5º (índice 4).
      const tabButtons = page.getByTestId('patient-profile-tabs').getByRole('button');
      await expect(tabButtons).toHaveCount(6);
      await expect(tabButtons.nth(4)).toHaveText('Itinerario');

      const par = page.getByTestId(`itinerario-servico-par-${seed.serviceId}`);
      await expect(par).toContainText(expectedPair(svcBefore.cobertas, svcBefore.contratadas.weekly));
      await expect(slotAllocationsInDom(page, slotId)).toHaveCount(0);

      // Alocar pela TELA.
      await page.getByTestId(`itinerario-slot-asignar-${slotId}`).click();
      const modal = page.getByTestId('itinerario-alocar-modal');
      await expect(modal).toBeVisible();
      await modal.getByTestId('itinerario-alocar-prestador').click();
      const search = modal.getByRole('textbox');
      await search.click();
      await page.keyboard.type(wLabel.slice(-10), { delay: 20 });
      await modal.getByRole('option', { name: wLabel }).click();
      const [itinAfterResp, postResp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'GET' && /\/itinerary(\?|$)/.test(r.url()) && r.status() === 200),
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/slots/${slotId}/allocations`)),
        modal.getByTestId('itinerario-alocar-confirmar').click(),
      ]);
      expect(postResp.status()).toBe(201);

      // Critério 1: o par subiu e o DOM = a rota, na mesma execução.
      const after = await readItineraryApi(request, seed.patientId);
      const svcAfter = after.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId);
      if (!svcAfter) throw new Error('itinerario-aba: serviço ausente no itinerário depois');
      const slotAfter = svcAfter.slots.find((s) => s.id === slotId);
      const vigentes = (slotAfter?.assignments ?? []).filter((a) => a.status === 'ACTIVE' && a.workerId === w);
      expect(vigentes).toHaveLength(1);
      expect(svcAfter.cobertas).toBeGreaterThan(svcBefore.cobertas);
      await expect(par).toContainText(expectedPair(svcAfter.cobertas, svcAfter.contratadas.weekly));
      await expect(page.getByTestId(`itinerario-slot-prestador-${slotId}-${w}`)).toBeVisible();
      await expect(slotAllocationsInDom(page, slotId)).toHaveCount(1);
      await expect(page.getByTestId(`itinerario-slot-asignar-${slotId}`)).toHaveCount(0);
      const domCount = await countSlotAllocationsInDom(page, slotId);
      console.log('[12.1]', postResp.status(), itinAfterResp.status(), svcBefore.cobertas, svcAfter.cobertas, svcAfter.contratadas.weekly, vigentes.length, domCount);
      console.log('[12.10]', await tabButtons.count(), 4);

      // Prints DEPOIS (DX-12.17) e baseline da seção com o slot coberto.
      await page.evaluate(() => document.fonts.ready);
      const secao = page.getByTestId(`itinerario-servico-${seed.serviceId}`);
      const printDir = process.env.PRINT_DIR;
      if (printDir) {
        await page.getByTestId('patient-profile-tabs').screenshot({ path: `${printDir}/abas.png`, animations: 'disabled', caret: 'hide' });
        await page.screenshot({ path: `${printDir}/ficha.png`, fullPage: false, animations: 'disabled', caret: 'hide' });
        await secao.screenshot({ path: `${printDir}/aba-itinerario.png`, animations: 'disabled', caret: 'hide' });
      }
      await expect(secao).toHaveScreenshot(`${testInfo.project.name}-itinerario-aba-secao.png`, {
        maxDiffPixelRatio: 0.05,
        mask: [secao.locator('[data-testid^="itinerario-slot-prestador-"]')],
      });

      // Critério 5: o prestador alocado aparece em Em Atendimento no quadro C.
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
      await expect(page.getByTestId('servicos-contratados-card')).toBeVisible({ timeout: 15_000 });
      await selectServiceRow(page, seed.serviceId);
      const inService = page.getByTestId('kanban-column-IN_SERVICE').getByTestId(`service-team-card-${w}`);
      await expect(inService).toHaveCount(1);
      console.log('[12.5]', await inService.count());

      // Critério 8: nenhum Places; nada clínico nos corpos da aba — controles positivos ao lado.
      const tabTexts = await Promise.all(tabBodies);
      const detailTexts = await Promise.all(detailBodies);
      const mapsHits = hosts.filter((h) => /maps\.googleapis\.com/.test(h)).length;
      const apiHits = hosts.filter((h) => h === new URL(backendUrl()).host).length;
      const clinicInTab = tabTexts.reduce((n, t) => n + (t.match(CLINICAL) ?? []).length, 0);
      const clinicInDetail = detailTexts.reduce((n, t) => n + (t.match(CLINICAL) ?? []).length, 0);
      console.log('[12.8]', mapsHits, apiHits, tabTexts.length, clinicInTab, detailTexts.length, clinicInDetail);
      expect(mapsHits).toBe(0);
      expect(apiHits).toBeGreaterThan(0);
      expect(tabTexts.length).toBeGreaterThan(0);
      expect(clinicInTab).toBe(0);
      expect(clinicInDetail).toBeGreaterThan(0);
    } finally {
      if (process.env.ITINERARIO_ABA_KEEP === '1') {
        console.log('[12.keep]', seed.patientId);
      } else {
        cleanupItineraryWrite(seed.patientId);
        cleanupWJAAndEncuadre(w, v);
        cleanupTestWorker(w);
        seed.cleanup();
      }
    }
  });

  test('itinerario-dia-vazio', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    try {
      const s2 = await createServiceViaApi(request, seed.patientId, { addressId: seed.addressId });
      const itin = await readItineraryApi(request, seed.patientId);
      expect(itin.status).toBe(200);
      const s1Slot = itin.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId)?.slots[0];
      if (!s1Slot) throw new Error('itinerario-dia-vazio: slot do 1º serviço ausente');
      expect(s1Slot.weekday).toBe(1);

      await loginAs(page, STAFF);
      await openItineraryTab(page, seed.patientId);

      const s1 = seed.serviceId;
      await expect(page.getByTestId(`itinerario-servico-${s1}`)).toBeVisible();
      await expect(page.getByTestId(`itinerario-servico-${s2}`)).toBeVisible();
      let vazios1 = 0;
      for (const wd of [0, 2, 3, 4, 5, 6]) {
        await expect(page.getByTestId(`itinerario-dia-vazio-${s1}-${wd}`)).toHaveCount(1);
        vazios1 += 1;
      }
      await expect(page.getByTestId(`itinerario-dia-vazio-${s1}-1`)).toHaveCount(0);
      let vazios2 = 0;
      for (const wd of [0, 1, 2, 3, 4, 5, 6]) {
        await expect(page.getByTestId(`itinerario-dia-vazio-${s2}-${wd}`)).toHaveCount(1);
        vazios2 += 1;
      }
      // Controle positivo: a segunda do 1º serviço tem o card com o chip do horário.
      const monday = page.getByTestId(`itinerario-dia-${s1}-1`);
      await expect(monday).toBeVisible();
      await expect(monday.getByTestId(`itinerario-slot-horario-${s1Slot.id}`)).toBeVisible();
      console.log('[12.2]', vazios1, vazios2, await monday.getByTestId(`itinerario-slot-horario-${s1Slot.id}`).count());
    } finally {
      cleanupItineraryWrite(seed.patientId);
      seed.cleanup();
    }
  });
});
