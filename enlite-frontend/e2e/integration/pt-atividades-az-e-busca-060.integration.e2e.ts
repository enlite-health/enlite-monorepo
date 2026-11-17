/**
 * Spec 060 (ajustada na 091) — Projeto Terapêutico: as ATIVIDADES de uma versão ANTIGA (formato plano, DF-7) saem em ordem alfabética na
 * edição — stack REAL (frontend + API + Postgres), zero mock. Régua humana (memória `e2e-humano-nao-e-fill`): click, valor lido da TELA.
 *
 * O campo de atividades com busca (Combobox `tp-activities` + `tp-activities-search`) saiu do "Nuevo" na 091: agora o "Nuevo" é em cascata
 * (as atividades vêm agrupadas sob o objetivo, na ordem do vínculo — DD-4, coberta por `pti-cascata-cid-091`). A lista plana só existe em
 * versão antiga, lida em "Editar" como TEXTO travado (MACRO) e continua A–Z. O que se prova (1 teste):
 *   a ordem das atividades LIDA DA TELA é A–Z pelo Intl.Collator('es') calculado AQUI (independente do código de produção) e DIFERE da ordem
 *   gravada no snapshot da versão (por `sort_order`, não alfabética).
 * FR-12: nada é gravado pelo teste além da versão semeada por SQL; o "Editar" é aberto e lido, nunca salvo.
 */
import { test, expect } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';
import {
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, psql, safeSql, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const CELULAS: [string, string][] = [
  ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'], ['patient_therapeutic_project', 'create'],
  ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_family', 'read'], ['patient_family', 'write'],
  ['patient_care_team', 'read'], ['patient_services', 'read'], ['patient_coverage', 'read'], ['patient_address', 'read'], ['patient_identity', 'read'],
  ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'],
];

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('spec 060 — atividades da versão antiga (plana) em A–Z na edição @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let staff: { user: MockUser; groupId: string };
  let ordemGravada: string[] = [];

  test.beforeAll(() => {
    seed = seedActivatablePatient(756000, { withDiagnosis: false }); // faixa própria (as vizinhas: 755000 e 800000)
    const servico = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-060', 'e2e-060') RETURNING id`).split('\n')[0].trim();
    // Versão ANTIGA por SQL (o CHECK ≥1 objetivo/atividade vale só para o formato plano): 8 atividades ativas na ordem do catálogo (`sort_order`).
    const atividades = runSQL(`SELECT jsonb_agg(jsonb_build_object('id', id, 'label', label) ORDER BY sort_order, lower(label)) FROM (SELECT id, label, sort_order FROM therapeutic_activities WHERE active ORDER BY sort_order, lower(label) LIMIT 8) t`).trim();
    ordemGravada = (JSON.parse(atividades) as Array<{ label: string }>).map((a) => a.label);
    expect(ordemGravada.length).toBe(8); // controle de não-vacuidade
    runSQL(`INSERT INTO patient_therapeutic_projects (patient_id, major, minor, contracted_service_id, modality, diagnoses, clinical_context, general_objective, specific_objectives, activities, pathology_types, start_date, end_date, created_by)
      VALUES ('${seed.patientId}', 1, 0, '${servico}', 'IN_PERSON', '[{"uri":"http://id.who.int/icd/entity/e2e-060","title":"Diagnóstico sintético 060"}]', 'Contexto sintético 060', 'Objetivo sintético 060',
        (SELECT jsonb_build_array(jsonb_build_object('id', id, 'label', label)) FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order LIMIT 1),
        (SELECT jsonb_agg(jsonb_build_object('id', id, 'label', label) ORDER BY sort_order, lower(label)) FROM (SELECT id, label, sort_order FROM therapeutic_activities WHERE active ORDER BY sort_order, lower(label) LIMIT 8) t), '[{"id":"06","label":"Capítulo 06 sintético 060"}]', '2026-09-01', '2026-12-31', 'e2e-060')`);
    const uid = `e2e-pt060-${RUN_ID}`;
    const user: MockUser = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };
    const { groupId } = seedStaffInGroup({ uid, email: user.email, groupName: `PT060 ${RUN_ID}`, country: 'AR' });
    psql(`UPDATE users SET display_name = 'E2E PT060' WHERE firebase_uid = '${uid}'`);
    for (const [resource, action] of CELULAS) grantCell(groupId, resource, action);
    staff = { user, groupId };
  });

  test.afterAll(() => {
    // A versão é IMUTÁVEL (trigger): só sai por CASCADE do paciente.
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`);
    cleanupPatientDeep(seed.patientId);
    cleanupStaffAndGroup(staff.user.uid, staff.groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'PT060 ${RUN_ID}'`);
  });

  test('1. editar a versão antiga: as atividades (texto travado) saem em A–Z lidas da tela, e a ordem difere da gravada', async ({ page }) => {
    await loginAs(page, staff.user);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('tp-edit-btn').click();
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 15_000 });
    const lista = page.getByTestId('tp-activities-locked');
    await expect(lista).toBeVisible();

    const naTela = (await lista.locator('li').allTextContents()).map((t) => t.trim());
    expect(naTela.length).toBe(8);
    const es = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
    expect(naTela).toEqual([...naTela].sort((a, b) => es.compare(a, b)));
    expect([...naTela].sort()).toEqual([...ordemGravada].sort()); // as mesmas 8, só reordenadas
    expect(naTela).not.toEqual(ordemGravada); // controle: a gravada não é A–Z, então a ordenação da tela é do código sob teste
  });
});
