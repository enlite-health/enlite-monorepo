/**
 * patient-itinerary-074-turno-24h.integration.e2e.ts @integration — spec 074: o rótulo do turno no itinerário. Uma faixa de
 * 1440 min é "Todo el día · 24 h" (pt-BR "Dia inteiro · 24 h"), nunca "08:00 – 08:00"; uma guardia de 3 turnos mostra as
 * 3 faixas "HH:MM – HH:MM" (a da noite atravessa a meia-noite: "20:00 – 08:00").
 *
 * Cenário montado pela API REAL (`POST …/contracted-services` com `schedule`) — a API só monta e desmonta; o que se
 * prova é o que a TELA "Horario fijo" mostra, lido do DOM contra o stack real (frontend + API + Postgres), sem mock de
 * rede (só a auth é o mock do stack, `loginAs`). Serviço: segunda 08:00/360 + 14:00/360 + 20:00/720 e quinta 08:00/1440
 * (a noite de segunda termina às 08:00 de terça, então a faixa de 24 h fica em outro dia, sem sobreposição).
 *
 * Side-effect outbound mapeado ANTES: o POST só escreve em Postgres (sem vaga ativa, nada de Talentum/Twilio/Periskope).
 * O pt-BR entra por `localStorage.i18nextLng` DEPOIS do login (o botão do login é achado pelo texto em español).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR, postContractedServiceViaApi,
} from '../helpers/lancamento-e2e-helper';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
import { insertTestPatient } from '../helpers/db-test-helper';
import { cleanupPatientDeep } from '../helpers/patient-detail-a-helper';
import { openItineraryTab, openFixedSchedule } from '../helpers/itinerario-aba-e2e-helper';

const STAFF = mockAdminUserFor('itinerario-turno-24h');

const TRES_GUARDIAS = [
  { dayOfWeek: 1, startTime: '08:00', durationMinutes: 360 },
  { dayOfWeek: 1, startTime: '14:00', durationMinutes: 360 },
  { dayOfWeek: 1, startTime: '20:00', durationMinutes: 720 },
];
const DIA_INTEIRO = { dayOfWeek: 4, startTime: '08:00', durationMinutes: 1440 };

test.describe('itinerario-turno-24h: o turno de 24 h e as 3 guardias no Horario fijo @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(120_000);
  useLancamentoStaff(STAFF, 'E2E Itinerario Turno 24h');

  let patientId = '';
  let serviceId = '';

  test.beforeAll(async ({ request }) => {
    const seed = insertTestPatient({ status: 'SEARCHING', withAddress: true, hasConsent: true, insuranceInformed: 'OSDE' });
    patientId = seed.patientId;
    if (!seed.addressId) throw new Error('itinerario-turno-24h: insertTestPatient sem addressId');
    serviceId = await postContractedServiceViaApi(request, tokenFor(STAFF), patientId, {
      serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId: seed.addressId,
      schedule: [...TRES_GUARDIAS, DIA_INTEIRO],
    });
  });

  test.afterAll(() => {
    if (patientId) cleanupPatientDeep(patientId);
  });

  /** Ficha → aba Itinerário → "Horario fijo" do serviço; o idioma da UI já foi fixado antes (es é o padrão do stack). */
  async function abrirHorarioFijo(page: Page): Promise<void> {
    await loginAs(page, STAFF);
    await openItineraryTab(page, patientId);
    await openFixedSchedule(page, serviceId);
  }

  test('feliz: serviço com 3 guardias mostra as 3 faixas', async ({ page }) => {
    await abrirHorarioFijo(page);
    const fixo = page.getByTestId('itinerario-horario-fijo');
    await expect(fixo.getByText('08:00 – 14:00', { exact: true })).toHaveCount(1);
    await expect(fixo.getByText('14:00 – 20:00', { exact: true })).toHaveCount(1);
    await expect(fixo.getByText('20:00 – 08:00', { exact: true })).toHaveCount(1);
  });

  test('alternativo: faixa de 1440 mostra Todo el día · 24 h e nenhuma ocorrência de 08:00 – 08:00', async ({ page }) => {
    await abrirHorarioFijo(page);
    // Controle positivo ANTES do "não aparece": a agenda renderizou (as 3 faixas da segunda estão na tela).
    await expect(page.getByText('20:00 – 08:00', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Todo el día · 24 h', { exact: true }).first()).toBeVisible();
    expect(await page.getByText('Todo el día · 24 h', { exact: true }).count()).toBeGreaterThanOrEqual(1);
    await expect(page.getByText('08:00 – 08:00')).toHaveCount(0);
  });

  test('alternativo: em pt-BR mostra Dia inteiro · 24 h', async ({ page }) => {
    await loginAs(page, STAFF); // o botão do login é achado em español; o pt-BR vale a partir daqui
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'pt-BR'));
    await page.goto(`/admin/patients/${patientId}`);
    const tabs = page.getByTestId('patient-profile-tabs');
    await expect(tabs).toBeVisible({ timeout: 15_000 });
    await tabs.getByRole('button', { name: 'Itinerário' }).click();
    await expect(page.getByTestId('itinerario-aba')).toBeVisible({ timeout: 15_000 });
    await openFixedSchedule(page, serviceId);

    // Controle positivo: a tela está em pt-BR (a aba tem o nome em português) e a agenda renderizou.
    await expect(tabs.getByRole('button', { name: 'Itinerário' })).toBeVisible();
    await expect(page.getByText('20:00 – 08:00', { exact: true })).toHaveCount(1);
    await expect(page.getByText('Dia inteiro · 24 h', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Todo el día · 24 h')).toHaveCount(0);
    await expect(page.getByText('08:00 – 08:00')).toHaveCount(0);
  });
});
