/**
 * patient-projeto-terapeutico-sem-servicos.integration.e2e.ts @integration
 *
 * Fix 018 (spec 018, PR-ficha-sem-servicos): sem `patient_services:read`, o backend redige
 * `contractedServices` para `null` (D113 — `null` ≠ `[]`, "não posso ver" nunca é "não tem").
 * ANTES do conserto, `ProjetoTerapeuticoCard.tsx:37` fazia `patient.contractedServices.some(...)`
 * sem checar `null` e a ficha INTEIRA caía no error boundary para todo ator com
 * `patient_therapeutic_project:read` mas sem `patient_services:read` — combinação real de
 * containers independentes (D286): a célula do card de projeto terapêutico não é a mesma célula
 * do card de serviços contratados.
 *
 * Prova contra o stack REAL — API com o engine LIGADO, Postgres real, `/v1/me/authz` real (mesmo
 * stack de `admin-access-cells-visual.integration.e2e.ts`: API 8089, Postgres 5439). O paciente
 * TEM um serviço contratado ativo (para diferenciar "sem permissão" de "sem serviço de verdade" —
 * D113); o que se prova é que a ficha abre, o card do projeto terapêutico aparece, e em NENHUM
 * lugar aparece o texto de "sem serviço contratado" (que seria uma afirmação falsa: o paciente
 * TEM serviço, só o ator não pode vê-lo).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  cleanupStaffAndGroup,
  grantCell,
  loginAs,
  meAuthz,
  psql,
  safeSql,
  scalar,
  seedStaffInGroup,
  type MockUser,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const STAFF: MockUser = { uid: `e2e-ptsemsrv-${RUN_ID}`, email: `e2e-ptsemsrv-${RUN_ID}@e2e.test`, role: 'recruiter', country: 'AR' };

/** D286: os containers da ficha (mesma lista de `admin-access-buttons-patients`), MENOS `patient_services`. */
const CONTAINERS_SEM_SERVICOS = ['patient_identity', 'patient_clinical', 'patient_care_team', 'patient_family', 'patient_chat', 'patient_coverage', 'patient_address', 'patient_therapeutic_project'] as const;

let groupId = '';
let patientId = '';
let serviceId = '';

test.describe('D113 — ficha sem `patient_services:read`: o card de projeto terapêutico NÃO quebra nem finge "sem serviço" @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    ({ groupId } = seedStaffInGroup({ uid: STAFF.uid, email: STAFF.email, groupName: `E2E PT sem servicos ${RUN_ID}`, country: 'AR' }));
    grantCell(groupId, 'patient', 'read');
    // O cenário do achado: TODOS os containers de leitura da ficha, MENOS `patient_services`.
    for (const c of CONTAINERS_SEM_SERVICOS) grantCell(groupId, c, 'read');
    grantCell(groupId, 'patient_therapeutic_project', 'write'); // pra "Nuevo" existir (desabilitado) e provar o `title`

    const clickupTaskId = `E2E-PTSEMSRV-${RUN_ID}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${clickupTaskId}', 'E2E', 'SemServicos ${RUN_ID}', 'ACTIVE', 'TEA leve', 'MODERATE', 'AR', NOW(), NOW())`);
    patientId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`);
    if (!patientId) throw new Error('paciente e2e não foi inserido');

    // O paciente TEM serviço ATIVO — é o que faz a asserção "nunca diz 'sem serviço'" valer algo:
    // sem isto, o texto genérico e o de "precisa de serviço" ficam indistinguíveis por acidente.
    serviceId = scalar(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
          VALUES ('${patientId}', 'AT', true, 'AR', 'e2e-ptsemsrv-setup', 'e2e-ptsemsrv-setup') RETURNING id`);
    if (!serviceId) throw new Error('serviço contratado e2e não foi inserido');

    // Uma versão VIGENTE para "Editar" existir (`tp-edit-btn` só aparece com `current`, D328) —
    // os campos JSONB são snapshot (sem FK pro catálogo), então o conteúdo é sintético mesmo.
    psql(`INSERT INTO patient_therapeutic_projects
        (patient_id, major, minor, contracted_service_id, modality, diagnoses, clinical_context,
         general_objective, specific_objectives, activities, pathology_types, start_date, end_date, created_by)
        VALUES ('${patientId}', 1, 0, '${serviceId}', 'IN_PERSON',
          '[{"uri":"http://id.who.int/icd/entity/e2e-ptsemsrv","title":"Diagnóstico sintético e2e"}]',
          'Contexto sintético e2e', 'Objetivo sintético e2e',
          '[{"id":"so-e2e","label":"Objetivo específico sintético"}]',
          '[{"id":"ac-e2e","label":"Atividade sintética"}]',
          '[{"id":"06","label":"Capítulo 06 sintético"}]',
          '2026-09-01', '2026-12-31', 'e2e-ptsemsrv-setup')`);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM patients WHERE id='${patientId}'`);
    cleanupStaffAndGroup(STAFF.uid, groupId);
  });

  test('0. pré-condição: o contrato real confirma enforcement=on e a célula de serviços AUSENTE', async ({ request }) => {
    const { status, body } = await meAuthz(request, STAFF);
    expect(status).toBe(200);
    expect(body.enforcement, 'PERMISSION_ENGINE_ENABLED precisa estar ligado — sem isso o achado nem existe (freio D268)').toBe('on');
    expect(body.permissions).toContain('patient_therapeutic_project:read');
    expect(body.permissions).not.toContain('patient_services:read');
  });

  test('1. a ficha abre, o card do projeto terapêutico aparece, e NUNCA diz "sem serviço contratado" (D113)', async ({ page }) => {
    await loginAs(page, STAFF);
    await page.goto(`/admin/patients/${patientId}`);

    // A ficha renderiza de verdade — nenhum dos dois error boundaries do app tomou o lugar da tela.
    await expect(page.getByTestId('route-error-boundary')).toHaveCount(0);
    await expect(page.getByTestId('admin-error-details')).toHaveCount(0);
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 20_000 });

    // O card do projeto terapêutico existe — a aba "Datos Clínicos" é a default (nenhum clique de tab).
    const card = page.getByTestId('projeto-terapeutico-card');
    await expect(card).toBeVisible({ timeout: 20_000 });

    // A afirmação central: em NENHUM lugar do card aparece o texto de "precisa de um serviço
    // contratado ativo" — o paciente TEM um; dizer isso seria a mentira que o D113 proíbe.
    await expect(card).not.toContainText('necesita un servicio contratado activo');
    // O vazio (sem versão de projeto ainda) mostra o texto GENÉRICO, não o de "precisa de serviço".
    await expect(page.getByTestId('tp-empty')).toContainText('todavía no tiene proyecto terapéutico');

    // "Nuevo" fica desabilitado (não temos como confirmar serviço ativo sem a célula) — mas o
    // motivo tem de ser "sem permiso", nunca "precisa de serviço" (que seria falso: ele tem um).
    const novo = page.getByTestId('tp-new-btn');
    await expect(novo).toBeDisabled();
    await expect(novo).toHaveAttribute('title', /permiso/i);
    await expect(novo).not.toHaveAttribute('title', /servicio contratado activo/i);
  });

  // Retomada 14/09 (achado do gate): "Editar" abre o form em modo edição — o campo de serviço é
  // MACRO travado (D328) e vira TEXTO a partir de `contractedServiceId`. Sem `patient_services:read`
  // o Drawer manda `services=[]` (redação); o form tem de mostrar "sem permiso", nunca
  // `tp-no-service` nem o UUID cru do serviço.
  test('2. "Editar" abre o form, e o campo de serviço mostra "sem permiso" — nunca `tp-no-service`, nunca o UUID cru', async ({ page }) => {
    await loginAs(page, STAFF);
    await page.goto(`/admin/patients/${patientId}`);

    await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('tp-edit-btn').click();

    const drawer = page.getByTestId('therapeutic-project-drawer');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('therapeutic-project-form')).toBeVisible({ timeout: 10_000 });

    // Nunca os dois sintomas do achado: `tp-no-service` (o aviso de "sem serviço ativo" — mentira,
    // o paciente TEM um) e o UUID cru do serviço travado no lugar do rótulo.
    await expect(page.getByTestId('tp-no-service')).toHaveCount(0);
    const servicoTravado = page.getByTestId('tp-service-locked');
    await expect(servicoTravado).toBeVisible();
    await expect(servicoTravado).not.toHaveText(serviceId);
    await expect(servicoTravado).toContainText('permiso');
  });
});
