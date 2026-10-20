/**
 * 058a-cobertura-pdf.integration.e2e.ts @integration — spec 058 Parte A, T135: cartão "Cobertura Médica" (informada × verificada) e o PDF do projeto terapêutico.
 *
 * E2E DE TELA, SEM MOCK de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo, clique e teclado de humano; o PDF é o
 * baixado de verdade e lido (`pdf-parse`). As obras sociais saem da API real; o paciente, o serviço e a versão do projeto, por SQL (molde do spec 417).
 *
 *  FELIZ         — as DUAS linhas do cartão (informada e verificada): apaga a informada e marca 2 obras sociais do catálogo no drawer -> o cartão mostra os
 *                  NOMES do catálogo -> o PDF imprime "Cobertura médica" com esses nomes (a informada, quando existe, é a que vale).
 *  ALTERNATIVO 1 — só rótulo SEM mapeamento ao catálogo = o cartão e o PDF dizem "sem mapeo" (o rótulo cru não sai); sem nada = "no informada".
 *  ALTERNATIVO 2 — (ABAC) sem `patient_coverage:read` o cartão nem aparece e o PDF diz "sem permissão" no lugar da cobertura; o servidor manda `coverage: null`.
 *                  Só mede com o engine ligado.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { loginAs } from '../helpers/abac-stack-helper';
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

  const novoPaciente = (base: number): Seed => { const p = seedActivatablePatient(base); pacientes.push(p); return p; };

  /** Serviço + 1 versão do projeto terapêutico (por SQL: o fluxo humano de criar o projeto tem spec próprio); devolve o id da versão. */
  function versaoDoProjeto(p: Seed): string {
    const sid = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${p.patientId}', 'CAREGIVER', 20, '${p.addressId}', 'e2e-058a', 'e2e-058a') RETURNING id`).split('\n')[0].trim();
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
    // Paciente "rótulos": nada informado e UM rótulo cru que o catálogo não conhece.
    runSQL(`UPDATE patients SET insurance_informed = NULL WHERE id = '${rotulos.patientId}'`);
    runSQL(`INSERT INTO patient_insurance_verified (patient_id, ordinal, raw_label, source) VALUES ('${rotulos.patientId}', 1, 'QA058A rotulo sin catalogo', 'clickup')`);
    // Paciente "oculto": informada e verificada existem — quem não lê a cobertura não pode vê-las em lugar nenhum.
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

  test('FELIZ: tira a cobertura informada e marca 2 obras sociais do catálogo -> o cartão mostra os nomes do catálogo -> o PDF imprime "Cobertura médica" com eles', async ({ page }) => {
    const feliz = pacientes[0];
    await loginAs(page, ator.user);
    await abrirCartao(page, feliz);
    // As DUAS linhas: a informada (semente) e a verificada (vazia).
    await expect(page.getByTestId('coverage-informed')).toContainText('OSDE');
    await expect(page.getByTestId('coverage-verified-value')).toHaveText('—');

    await page.getByTestId('edit-coverage-btn').click();
    const drawer = page.getByTestId('patient-coverage-edit-drawer');
    await expect(drawer).toBeVisible();
    const informada = page.getByTestId('pcv-name');
    await informada.click();
    await expect(informada).toBeFocused();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await expect(informada).toHaveValue('');
    for (const nome of [p1.name, p2.name]) {
      const raiz = page.locator('#pcv-codes');
      await raiz.locator('button[aria-haspopup="listbox"]').click();
      const opcao = raiz.locator('li[role="option"]', { hasText: nome });
      await expect(opcao).toBeVisible({ timeout: 10_000 });
      await opcao.locator('button').click();
      await informada.click(); // clique FORA da lista (o campo fica acima dela): o MultiSelect fecha no mousedown externo; nunca Esc (abre o "descartar")
      await expect(raiz.locator('li[role="option"]').first()).toHaveCount(0);
    }
    await expect(page.getByTestId('pcv-codes-selected')).toContainText(p1.name);
    await expect(page.getByTestId('pcv-codes-selected')).toContainText(p2.name);

    const salvo = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/patients\/[^/]+\/coverage$/.test(r.url()));
    await page.getByTestId('pcv-save').click();
    expect((await salvo).status()).toBe(200);
    await expect(drawer).toHaveCount(0);

    await expect(page.getByTestId('coverage-informed')).toContainText('—');
    await expect(page.getByTestId('coverage-informed')).not.toContainText('OSDE');
    await expect(page.getByTestId('coverage-verified-value')).toHaveText(`${p1.name}, ${p2.name}`);
    await page.screenshot({ path: 'test-results/058a-cobertura-pdf.png', fullPage: true });

    // O PDF baixado de verdade: a cobertura impressa são os NOMES do catálogo (a informada, vazia, não encobre).
    const texto = await exportarPdf(page, feliz);
    expect(texto).toContain('Cobertura médica');
    expect(texto).toContain(`${p1.name}, ${p2.name}`);
    expect(texto).not.toContain('OSDE');
  });

  test('ALTERNATIVO 1: só rótulo sem mapeamento = "sem mapeo" (cartão e PDF; o rótulo cru não sai); sem nada = "no informada"', async ({ page }) => {
    const rotulos = pacientes[1];
    await loginAs(page, ator.user);
    // UNMAPPED_ONLY
    await abrirCartao(page, rotulos);
    await expect(page.getByTestId('coverage-verified-value')).toHaveText('Sin mapeo al catálogo (1)');
    await expect(page.getByTestId('coverage-informed')).toContainText('—');
    const semMapeo = await exportarPdf(page, rotulos);
    expect(semMapeo).toContain('Cobertura sin mapeo al catálogo');
    expect(semMapeo).not.toContain('QA058A rotulo sin catalogo');

    // NONE: tira o rótulo; nada informado, nada verificado.
    runSQL(`DELETE FROM patient_insurance_verified WHERE patient_id = '${rotulos.patientId}'`);
    await abrirCartao(page, rotulos);
    await expect(page.getByTestId('coverage-verified-value')).toHaveText('—');
    const nenhuma = await exportarPdf(page, rotulos);
    expect(nenhuma).toContain('Cobertura no informada');
    expect(nenhuma).not.toContain('Cobertura sin mapeo');
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
