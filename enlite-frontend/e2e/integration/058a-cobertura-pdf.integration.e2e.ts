/**
 * 058a-cobertura-pdf.integration.e2e.ts @integration — spec 058 Parte A, T135 (reescrito na 087): cartão "Cobertura médica" (UMA linha, "Cobertura actual", lida do serviço contratado) e o PDF do projeto terapêutico.
 *
 * E2E DE TELA, SEM MOCK de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo, clique e teclado de humano; o PDF é o
 * baixado de verdade e lido (`pdf-parse`). As obras sociais saem da API real; o paciente, o serviço e a versão do projeto, por SQL (molde do spec 417).
 *
 *  FELIZ         — serviço vinculado ao contrato Particular -> o cartão mostra "Particular" (`coverage-current-value`); o drawer só edita a Credencial (sem `#pcv-codes`) ->
 *                  o PDF imprime "Cobertura médica" com "Particular" e a credencial.
 *  ALTERNATIVO 1 — serviço ativo SEM vínculo = "Sin obra social vinculada" (cartão e PDF); sem serviço ativo = "Sin servicio activo" (cartão).
 *  ALTERNATIVO 2 — (ABAC) sem `patient_coverage:read` o cartão nem aparece e o PDF diz "sem permissão" no lugar da cobertura; o servidor manda `coverage: null`.
 *                  Só mede com o engine ligado.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { loginAs } from '../helpers/abac-stack-helper';
import { vincularServicoAoParticular } from '../helpers/vinculo-servico-helper';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  CELLS_FICHA, CELLS_INSURANCE_ALL, seedActor, dropActors, purgeProviders, apiOk, makeProvider,
  type Actor, type ProviderMade,
} from '../helpers/insurance-058a-helper';

type Seed = { patientId: string; addressId: string; stamp: string };


test.use({ viewport: { width: 1600, height: 1200 }, video: 'on', acceptDownloads: true });

test.describe('058a-cobertura-pdf — cartão Cobertura Médica e o PDF do projeto terapêutico (spec 058 T135) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let ator: Actor;
  let semCobertura: Actor;
  let p1: ProviderMade;
  let p2: ProviderMade;
  const pacientes: Seed[] = [];
  const versoes: Record<string, string> = {};
  const servicos: Record<string, string> = {}; // paciente -> id do serviço contratado semeado

  const novoPaciente = (base: number): Seed => { const p = seedActivatablePatient(base); pacientes.push(p); return p; };

  /** Serviço + 1 versão do projeto terapêutico (por SQL: o fluxo humano de criar o projeto tem spec próprio); devolve o id da versão. */
  function versaoDoProjeto(p: Seed): string {
    const sid = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, active, country, created_by, updated_by) VALUES ('${p.patientId}', 'CAREGIVER', 20, '${p.addressId}', true, 'AR', 'e2e-058a', 'e2e-058a') RETURNING id`).split('\n')[0].trim();
    servicos[p.patientId] = sid;
    const obj = runSQL(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order LIMIT 1`).trim();
    const act = runSQL(`SELECT id FROM therapeutic_activities WHERE active ORDER BY sort_order LIMIT 1`).trim();
    return runSQL(`INSERT INTO patient_therapeutic_projects (patient_id, major, minor, contracted_service_id, modality, diagnoses, clinical_context, general_objective, specific_objectives, activities, pathology_types, start_date, end_date, created_by)
      VALUES ('${p.patientId}', 1, 0, '${sid}', 'ONLINE', '[{"uri":"http://id.who.int/icd/entity/e2e-058a","title":"Diagnóstico sintético 058a"}]', 'Contexto sintético 058a', 'Objetivo sintético 058a',
        (SELECT jsonb_build_array(jsonb_build_object('id', id, 'label', label)) FROM therapeutic_specific_objectives WHERE id = '${obj}'),
        (SELECT jsonb_build_array(jsonb_build_object('id', id, 'label', label)) FROM therapeutic_activities WHERE id = '${act}'),
        '[{"id":"06","label":"Capítulo 06 sintético 058a"}]', '2026-09-01', '2026-12-31', 'e2e-058a') RETURNING id`).split('\n')[0].trim();
  }

  async function abrirCartao(page: Page, p: Seed): Promise<void> {
    await page.goto(`/admin/patients/${p.patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await expect(page.getByTestId('cobertura-medica-card')).toBeVisible({ timeout: 30_000 });
  }

  /** Exporta o PDF da versão pela tela (download real) e devolve o texto com os espaços normalizados. */
  async function exportarPdf(page: Page, p: Seed): Promise<string> {
    await page.goto(`/admin/patients/${p.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`tp-view-${versoes[p.patientId]}`).click();
    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toHaveAttribute('data-mode', 'view');
    const download = page.waitForEvent('download');
    await page.getByTestId('therapeutic-project-export-btn').click();
    const file = await download;
    const parsed = await pdfParse(readFileSync((await file.path())!));
    await page.getByTestId('therapeutic-project-close').click();
    await expect(drawer).toHaveCount(0);
    return parsed.text.replace(/\s+/g, ' ');
  }

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    ator = seedActor('cob', [...CELLS_FICHA, ...CELLS_INSURANCE_ALL]);
    // A mesma ficha e o mesmo projeto, SEM a cobertura: a pessoa do alternativo 2.
    semCobertura = seedActor('cob-sem-cobertura', CELLS_FICHA.filter(([r]) => r !== 'patient_coverage'));
    p1 = await makeProvider(request, ator, 'Cobertura Uno');
    p2 = await makeProvider(request, ator, 'Cobertura Dos');
    const feliz = novoPaciente(651000); versoes[feliz.patientId] = versaoDoProjeto(feliz);
    const rotulos = novoPaciente(652000); versoes[rotulos.patientId] = versaoDoProjeto(rotulos);
    const oculto = novoPaciente(653000); versoes[oculto.patientId] = versaoDoProjeto(oculto);
    // Spec 087: "feliz" e "rótulos" não dependem mais da informada/verificada — o cartão lê o vínculo do SERVIÇO (semeado em cada teste).
    // Paciente "oculto": informada e verificada existem — quem não lê a cobertura não pode vê-las em lugar nenhum (o fio `coverage` segue na API).
    runSQL(`INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source, provider_code) VALUES ('${oculto.patientId}', 1, '${p1.name}', 'admin_manual', '${p1.code}')`);
    await request.dispose();
  });

  test.afterAll(() => {
    purgeProviders(); // `patient_insurance_verified` -> obra social: sai antes
    for (const p of pacientes) {
      runSQL(`DELETE FROM patients WHERE id = '${p.patientId}'`); // versão imutável: o pai sai primeiro
      cleanupPatientDeep(p.patientId);
    }
    dropActors();
  });

  test('FELIZ: serviço vinculado ao Particular -> o cartão mostra "Particular"; o drawer só edita a Credencial -> o PDF imprime "Cobertura médica" com "Particular" e a credencial', async ({ page }) => {
    const feliz = pacientes[0];
    vincularServicoAoParticular(servicos[feliz.patientId]);
    await loginAs(page, ator.user);
    await abrirCartao(page, feliz);
    await expect(page.getByTestId('coverage-current-value')).toHaveText('Particular', { timeout: 20_000 });

    await page.getByTestId('edit-coverage-btn').click();
    const drawer = page.getByTestId('patient-coverage-edit-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.locator('#pcv-codes')).toHaveCount(0); // a "verificada" por código acabou: o drawer só tem Credencial + contatos
    await page.getByTestId('pcv-affiliate').fill('AF-058A-0001');

    const salvo = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/patients\/[^/]+\/coverage$/.test(r.url()));
    await page.getByTestId('pcv-save').click();
    expect((await salvo).status()).toBe(200);
    await expect(drawer).toHaveCount(0);

    await expect(page.getByTestId('coverage-current-value')).toHaveText('Particular');
    await expect(page.getByTestId('cobertura-medica-card')).toContainText('AF-058A-0001');
    await page.screenshot({ path: 'test-results/058a-cobertura-pdf.png', fullPage: true });

    // O PDF baixado de verdade: a cobertura impressa é a ATUAL do serviço ("Particular") + a credencial.
    const texto = await exportarPdf(page, feliz);
    expect(texto).toContain('Cobertura médica');
    expect(texto).toContain('Particular');
    expect(texto).toContain('AF-058A-0001');
    expect(texto).not.toContain('OSDE');
  });

  test('ALTERNATIVO 1: serviço ativo sem vínculo = "Sin obra social vinculada" (cartão e PDF); sem serviço ativo = "Sin servicio activo"', async ({ page }) => {
    const rotulos = pacientes[1];
    await loginAs(page, ator.user);
    // Serviço ativo, SEM vínculo com contrato
    await abrirCartao(page, rotulos);
    await expect(page.getByTestId('coverage-current-value')).toHaveText('Sin obra social vinculada', { timeout: 20_000 });
    const semVinculo = await exportarPdf(page, rotulos);
    expect(semVinculo).toContain('Sin obra social vinculada');

    // Sem serviço ativo: o único serviço sai de cena.
    runSQL(`UPDATE patient_contracted_services SET active = false, ended_at = now() WHERE id = '${servicos[rotulos.patientId]}'`);
    await abrirCartao(page, rotulos);
    await expect(page.getByTestId('coverage-current-value')).toHaveText('Sin servicio activo', { timeout: 20_000 });
  });

  test('ALTERNATIVO 2 (ABAC): sem `patient_coverage:read` o cartão não aparece e o PDF diz "sem permissão" no lugar da cobertura; o servidor manda coverage null', async ({ page, request }) => {
    const oculto = pacientes[2];
    // Controle positivo: quem tem a célula lê os NOMES do MESMO paciente; quem não tem, `coverage: null` (redação — nunca "vazio").
    const comLeitura = await apiOk<{ coverage: { display: string | null } | null }>(request, ator, 'GET', `/api/admin/patients/${oculto.patientId}`, undefined, 200);
    expect(comLeitura.coverage?.display).toBe('OSDE');
    const semLeitura = await apiOk<{ coverage: unknown }>(request, semCobertura, 'GET', `/api/admin/patients/${oculto.patientId}`, undefined, 200);
    expect(semLeitura.coverage).toBeNull();

    await loginAs(page, semCobertura.user);
    await page.goto(`/admin/patients/${oculto.patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await expect(page.getByTestId('servicos-contratados-card')).toBeVisible({ timeout: 30_000 }); // a aba abriu (o card de serviços está lá)
    await expect(page.getByTestId('cobertura-medica-card')).toHaveCount(0);

    const texto = await exportarPdf(page, oculto);
    expect(texto).toContain('Sección no incluida: el usuario que emitió este documento no tiene permiso para este dato.');
    expect(texto).not.toContain('Cobertura médica');
    expect(texto).not.toContain('OSDE');
    expect(texto).not.toContain(p1.name);
  });
});
