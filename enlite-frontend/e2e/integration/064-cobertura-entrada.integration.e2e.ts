/**
 * 064-cobertura-entrada.integration.e2e.ts @integration — spec 064: "Cobertura actual" e "Ingreso al servicio" no cartão de identidade da ficha.
 *
 * E2E DE TELA, SEM MOCK de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo. O cenário (obras sociais, contratos,
 * vínculos) vem da API real; o serviço contratado entra por SQL (molde do `058a-cascata-servico`) para fixar `start_date`. A asserção é o TEXTO da tela.
 * NENHUM efeito externo: não ativa recrutamento, não completa worker, não chama mirror Ana Care / mensageria — só Postgres + API de leitura/vínculo.
 *
 *  FELIZ         — 2 serviços ativos, 2 obras sociais distintas, `start_date` distintas -> os 2 nomes e a MENOR data (DD/MM/AAAA).
 *  ALTERNATIVO A — (ABAC) ator SEM `patient_services:read` -> os dois campos dizem "Sin permiso" e nenhum nome vaza para o DOM.
 *  ALTERNATIVO B — serviço ativo sem vínculo e sem `start_date` -> "Sin obra social vinculada" e "Sin fecha de inicio en los servicios".
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAs } from '../helpers/abac-stack-helper';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  CELLS_FICHA, CELLS_INSURANCE_ALL, seedActor, dropActors, purgeProviders, apiOk, makeProvider, makeContract, asOfAR, addDays,
  type Actor, type ProviderMade, type ContractMade,
} from '../helpers/insurance-058a-helper';

type Seed = { patientId: string; addressId: string; stamp: string };

const ddmmaaaa = (iso: string): string => iso.split('-').reverse().join('/');

test.use({ viewport: { width: 1600, height: 1200 } });

test.describe('064-cobertura-entrada — cobertura atual e data de entrada na ficha (spec 064) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let ator: Actor;
  let semServicos: Actor;
  let pa: ProviderMade;
  let pb: ProviderMade;
  let hoje = '';
  let dataA = '';
  let dataB = '';
  const pacientes: Seed[] = [];
  let pFeliz: Seed;
  let pSemVinculo: Seed;

  const novoPaciente = (base: number): Seed => { const p = seedActivatablePatient(base); pacientes.push(p); return p; };
  const novoServico = (p: Seed, startDate: string | null): string =>
    runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, start_date, created_by, updated_by) VALUES ('${p.patientId}', 'CAREGIVER', 20, '${p.addressId}', ${startDate ? `'${startDate}'` : 'NULL'}, 'e2e-064', 'e2e-064') RETURNING id`).split('\n')[0].trim();

  async function abrirFicha(page: Page, p: Seed): Promise<void> {
    await page.goto(`/admin/patients/${p.patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('patient-current-coverage')).toBeVisible({ timeout: 20_000 });
  }

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    ator = seedActor('cob', [...CELLS_FICHA, ...CELLS_INSURANCE_ALL]);
    // A mesma ficha, SEM a célula do container `services`: a pessoa do alternativo A.
    semServicos = seedActor('cob-sem-servicos', CELLS_FICHA.filter(([r]) => r !== 'patient_services'));
    pa = await makeProvider(request, ator, 'Cob A');
    pb = await makeProvider(request, ator, 'Cob B');
    hoje = await asOfAR(request, ator);
    dataA = addDays(hoje, -90); // a MENOR: é a data de entrada esperada
    dataB = addDays(hoje, -30);
    const desde = addDays(hoje, -200);
    const ca = await makeContract(request, ator, pa.code, 'COBA', { hourlyRate: 1500, taxRatePercent: 0, validFrom: desde });
    const cb = await makeContract(request, ator, pb.code, 'COBB', { hourlyRate: 1000, taxRatePercent: 10.5, validFrom: desde });

    pFeliz = novoPaciente(661000);
    const sA = novoServico(pFeliz, dataB); // ordem trocada de propósito: o 1º serviço NÃO tem a menor data
    const sB = novoServico(pFeliz, dataA);
    const vincular = (sid: string, contract: ContractMade) =>
      apiOk(request, ator, 'POST', `/api/admin/patients/${pFeliz.patientId}/contracted-services/${sid}/contract-link`, { contractId: contract.id, validFrom: addDays(hoje, -29) }, 201);
    await vincular(sA, ca);
    await vincular(sB, cb);

    pSemVinculo = novoPaciente(662000);
    novoServico(pSemVinculo, null);
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

  test('FELIZ: dois serviços ativos em duas obras sociais -> a ficha mostra os dois nomes e a MENOR data de início', async ({ page }) => {
    await loginAs(page, ator.user);
    await abrirFicha(page, pFeliz);
    const cobertura = page.getByTestId('patient-current-coverage');
    await expect(cobertura).toContainText(pa.name);
    await expect(cobertura).toContainText(pb.name);
    const entrada = page.getByTestId('patient-entry-date');
    await expect(entrada).toHaveText(ddmmaaaa(dataA));
    await expect(entrada).not.toContainText(ddmmaaaa(dataB));
  });

  test('ALTERNATIVO A (ABAC): sem a célula de serviços os dois campos dizem "Sin permiso" e nenhum nome chega ao DOM', async ({ page }) => {
    await loginAs(page, semServicos.user);
    await abrirFicha(page, pFeliz);
    await expect(page.getByTestId('patient-current-coverage')).toHaveText('Sin permiso');
    await expect(page.getByTestId('patient-entry-date')).toHaveText('Sin permiso');
    await expect(page.getByText(pa.name)).toHaveCount(0);
    await expect(page.getByText(pb.name)).toHaveCount(0);
  });

  test('ALTERNATIVO B: serviço ativo sem vínculo e sem data de início -> frases de vazio, não "—"', async ({ page }) => {
    await loginAs(page, ator.user);
    await abrirFicha(page, pSemVinculo);
    await expect(page.getByTestId('patient-current-coverage')).toHaveText('Sin obra social vinculada');
    await expect(page.getByTestId('patient-entry-date')).toHaveText('Sin fecha de inicio en los servicios');
  });
});
