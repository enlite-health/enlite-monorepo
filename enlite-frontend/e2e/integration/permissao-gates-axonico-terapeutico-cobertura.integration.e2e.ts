/**
 * permissao-gates-axonico-terapeutico-cobertura.integration.e2e.ts @integration
 *
 * Prova, contra o backend real (engine ABAC LIGADO), que os TRÊS componentes gateados que esta
 * sessão mexeu aparecem para quem TEM a célula e desaparecem do DOM para quem NÃO TEM — nunca
 * ficam visíveis-e-desabilitados (D269):
 *
 *   1. Botão "Enviar" ao Axônico (`AxonicoSendControl.tsx`, via `ActionButton`) — célula
 *      `integration:execute` (screenRegistry `anacareHours.detail`).
 *   2. Botão "Exportar PDF" do projeto terapêutico (`TherapeuticProjectDrawer.tsx:188`, via
 *      `ActionButton`) — célula `patient_therapeutic_project:export`.
 *   3. Container "Cobertura Médica" da ficha do paciente (`PatientDetailPage.tsx`, via
 *      `ContainerGate`) — célula `patient_coverage:read`.
 *
 * POR QUE NA STAGE (aqui: stack local com o MESMO overlay que liga o engine), NUNCA EM PRD:
 * em produção `PERMISSION_ENGINE_ENABLED=false`, e `useActionGate`/`useContainerAccess` (ver
 * `src/presentation/hooks/useCellAccess.ts`) devolvem `allowed`/`visible` = `true` ANTES de olhar
 * qualquer célula — o lado NEGATIVO deste teste é IMPOSSÍVEL de provar lá.
 *
 * STACK (mesmo padrão de `anacare-hours-axonico-envio.integration.e2e.ts`, que este arquivo usa
 * como MODELO — ver `.github/workflows/_frontend-integration.yml`, job `integration-e2e-anacare-hours`):
 *   cd worker-functions
 *   docker compose -p worker-functions -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.anacare-hours.yml up -d --build --no-deps postgres api
 *   cd ../enlite-frontend && pnpm dev
 *
 * Este overlay liga `PERMISSION_ENGINE_ENABLED=true` + `PERMISSION_CATALOG_SYNC_ENABLED=true`
 * (o catálogo de células nasce da varredura de rotas no boot, D-célula-em-closure: a célula
 * `patient_therapeutic_project:export` vive numa closure condicional [`?purpose=export`] que o
 * scanner não vê — ela só chega ao catálogo por `cellsForaDeRota`, `PermissionCell.ts`; conferido
 * manualmente contra `iam.permissions` antes de escrever este arquivo). `enforcement` (o que o
 * front lê) é um único booleano global (`GetMyAuthzUseCase.ts:46`, injetado de
 * `PERMISSION_ENGINE_ENABLED`) — independe de `PERMISSION_ENFORCED_ROUTES` (que só decide 403
 * NO SERVIDOR); por isso o MESMO overlay (`admin.patients` enforçado) já basta para gatear os 3
 * alvos na UI, mesmo o alvo 1 sendo `admin.integrations` no backend.
 *
 * Ambiente FRESCO (banco novo, sem `iam.rollout_state` marcado): o boot com o engine ligado
 * recusa subir (`RolloutNotMigratedError`, lex C2) até `iam.rollout_state.permission_groups_
 * migrated='done'` existir — nesta sessão foi marcado à mão, uma vez, via psql como
 * `enlite_admin` (a ACL da migration 282 só revoga escrita de `app_runtime`/`app_system`, não do
 * dono), replicando o que o script de migração de dados faria num ambiente real.
 *
 * SEM STUB DO AXONICO E SEM CLICAR "Enviar": este arquivo prova só a GATE (elemento existe/some),
 * nunca o envio de verdade — não há tráfego de rede que possa vazar para o Axônico real, então
 * nenhum dos guards de `anacare-hours-axonico-envio...ts` é necessário aqui.
 *
 * Auth/DB: reusa `e2e/helpers/abac-stack-helper.ts` (psql, grantCell, seedStaffInGroup, loginAs
 * humano — click + keyboard.type, nunca `fill()`) e `e2e/helpers/db-test-helper.ts`
 * (`insertTestPatient`) — fix-once, evita reescrever o que os specs `admin-access-*` já
 * resolveram. Os defaults desses helpers apontam para o stack fixo 8089/5439 de OUTRA sessão;
 * aqui rodamos contra o stack local padrão (5432/8080, mesmo do resto do repo) via
 * `ABAC_API_URL`/`ABAC_TEST_DB_URL` passadas na hora de rodar (ver rodapé deste arquivo).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  psql,
  scalar,
  safeSql,
  grantCell,
  seedStaffInGroup,
  cleanupStaffAndGroup,
  loginAs,
  type MockUser,
} from '../helpers/abac-stack-helper';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';

// ── Identidade da rodada ─────────────────────────────────────────────────────────────────────
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const FULL_UID = `e2e-gates-full-${RUN_ID}`;
const FULL_EMAIL = `${FULL_UID}@e2e.test`;
const LIMITADO_UID = `e2e-gates-limitado-${RUN_ID}`;
const LIMITADO_EMAIL = `${LIMITADO_UID}@e2e.test`;
const GROUP_FULL = `E2E Gates Full ${RUN_ID}`;
const GROUP_LIMITADO = `E2E Gates Limitado ${RUN_ID}`;

const FULL: MockUser = { uid: FULL_UID, email: FULL_EMAIL, role: 'admin', country: 'AR' };
const LIMITADO: MockUser = { uid: LIMITADO_UID, email: LIMITADO_EMAIL, role: 'admin', country: 'AR' };

let groupFullId = '';
let groupLimitadoId = '';
let patientId = '';
let serviceId = '';
let versionId = '';

// ── Réplica DETERMINÍSTICA de `FakeAnaCareShiftsSource.generateMonth` (mesmo molde de
// `anacare-hours-axonico-envio.integration.e2e.ts`) — só para achar, para os pacientes AC-PAT-2
// (FULL) e AC-PAT-3 (LIMITADO, índices NÃO usados pelos outros specs @integration, conferido por
// `git grep AC-PAT-`), o único turno do mês sozinho no seu dia + com check-in/checkout + hora
// CHEIA — a mesma régua de elegibilidade do Axônico, para provar o botão "Enviar" HABILITADO (não
// só visível) quando a célula está presente.
const PATIENTS_PER_MONTH = 10;
const PROVIDERS_PER_PATIENT = 2;
const SHIFTS_PER_PROVIDER = 5;
const TOTAL_SHIFTS = PATIENTS_PER_MONTH * PROVIDERS_PER_PATIENT * SHIFTS_PER_PROVIDER;
const ORIGIN_COUNTS: Record<'app' | 'web_admin' | 'sin_checkin', number> = { app: 46, web_admin: 35, sin_checkin: 19 };

function buildOriginSequence(total: number): Array<'app' | 'web_admin' | 'sin_checkin'> {
  const order: Array<'app' | 'web_admin' | 'sin_checkin'> = ['app', 'web_admin', 'sin_checkin'];
  const weights = order.map((k) => ORIGIN_COUNTS[k]);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const acc = [0, 0, 0];
  const out: Array<'app' | 'web_admin' | 'sin_checkin'> = [];
  for (let i = 0; i < total; i += 1) {
    for (let k = 0; k < order.length; k += 1) acc[k] += weights[k];
    let best = 0;
    for (let k = 1; k < order.length; k += 1) if (acc[k] > acc[best]) best = k;
    acc[best] -= weightTotal;
    out.push(order[best]);
  }
  return out;
}
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}
function currentMonthIsoForE2E(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}
const MONTH = currentMonthIsoForE2E();
const [MONTH_YEAR, MONTH_NUM] = MONTH.split('-').map(Number);
const DIM = daysInMonth(MONTH_YEAR, MONTH_NUM);
const ORIGIN_SEQUENCE = buildOriginSequence(TOTAL_SHIFTS);

interface FakeShiftMeta {
  p: number;
  pr: number;
  s: number;
  shiftIndex: number;
  dateIso: string;
  isFinalized: boolean;
  earlyMin: number | null;
}
function computeMonthMeta(): FakeShiftMeta[] {
  const out: FakeShiftMeta[] = [];
  let shiftIndex = 0;
  for (let p = 0; p < PATIENTS_PER_MONTH; p += 1) {
    for (let pr = 0; pr < PROVIDERS_PER_PATIENT; pr += 1) {
      for (let s = 0; s < SHIFTS_PER_PROVIDER; s += 1) {
        const day = (shiftIndex % DIM) + 1;
        const dateIso = `${MONTH}-${pad2(day)}`;
        const origin = ORIGIN_SEQUENCE[shiftIndex];
        let isFinalized = false;
        let earlyMin: number | null = null;
        if (origin !== 'sin_checkin') {
          const emAndamento = shiftIndex % 9 === 0;
          if (!emAndamento) {
            earlyMin = (shiftIndex % 5) * 3;
            isFinalized = true;
          }
        }
        out.push({ p, pr, s, shiftIndex, dateIso, isFinalized, earlyMin });
        shiftIndex += 1;
      }
    }
  }
  return out;
}
const MONTH_META = computeMonthMeta();

function pickEligibleSingleShiftDay(p: number): FakeShiftMeta {
  const mine = MONTH_META.filter((m) => m.p === p);
  const byDate = new Map<string, FakeShiftMeta[]>();
  for (const m of mine) {
    const arr = byDate.get(m.dateIso) ?? [];
    arr.push(m);
    byDate.set(m.dateIso, arr);
  }
  for (const m of mine) {
    const sameDay = byDate.get(m.dateIso);
    if (sameDay && sameDay.length === 1 && m.isFinalized && m.earlyMin === 0) return m;
  }
  throw new Error(`Nenhum turno elegível para AC-PAT-${p} no mês ${MONTH} — massa determinística por ÍNDICE GLOBAL, só muda se o mês mudar.`);
}

const TARGET_FULL = pickEligibleSingleShiftDay(2);
const TARGET_LIMITADO = pickEligibleSingleShiftDay(3);
const PATIENT_FULL_AXONICO = `AC-PAT-${TARGET_FULL.p}`;
const PATIENT_LIMITADO_AXONICO = `AC-PAT-${TARGET_LIMITADO.p}`;
const SHIFT_FULL = `FAKE-${MONTH}-${TARGET_FULL.p}-${TARGET_FULL.pr}-${TARGET_FULL.s}`;
const SHIFT_LIMITADO = `FAKE-${MONTH}-${TARGET_LIMITADO.p}-${TARGET_LIMITADO.pr}-${TARGET_LIMITADO.s}`;
const DNI_FULL = '30111001';
const DNI_LIMITADO = '30111002';

// ── Navegador de semana (mesmo padrão do arquivo-modelo) ────────────────────────────────────
function startOfWeekMonday(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isoWeekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (isoWeekday - 1));
  return date.toISOString().slice(0, 10);
}
function weeksBetweenMondays(fromMondayIso: string, toMondayIso: string): number {
  const from = Date.parse(`${fromMondayIso}T00:00:00Z`);
  const to = Date.parse(`${toMondayIso}T00:00:00Z`);
  return Math.round((to - from) / (7 * 24 * 60 * 60 * 1000));
}
function defaultWeekStart(): string {
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return startOfWeekMonday(MONTH === todayIso.slice(0, 7) ? todayIso : `${MONTH}-01`);
}
async function irParaSemanaDe(page: Page, dateIso: string): Promise<void> {
  const alvo = startOfWeekMonday(dateIso);
  const atual = defaultWeekStart();
  const delta = weeksBetweenMondays(atual, alvo);
  if (delta > 0) {
    for (let i = 0; i < delta; i += 1) await page.getByTestId('anacare-hours-week-next').click();
  } else if (delta < 0) {
    for (let i = 0; i < -delta; i += 1) await page.getByTestId('anacare-hours-week-prev').click();
  }
}

// ── Setup / teardown ─────────────────────────────────────────────────────────────────────────

test.describe('Gates de permissão — Axônico, exportar projeto terapêutico, cobertura médica @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    // FULL — tem as 3 células-alvo + o que cada tela exige para carregar.
    const full = seedStaffInGroup({ uid: FULL_UID, email: FULL_EMAIL, groupName: GROUP_FULL, country: 'AR' });
    groupFullId = full.groupId;
    for (const [resource, action] of [
      ['patient', 'read'],
      ['patient_identity', 'read'],
      ['patient_therapeutic_project', 'read'],
      ['patient_therapeutic_project', 'export'],
      ['patient_coverage', 'read'],
      ['anacare_hours', 'read'],
      ['anacare_hours', 'validate'],
      ['integration', 'execute'],
    ]) grantCell(groupFullId, resource, action);

    // LIMITADO — tem o `:read` que abre cada tela/card/aba, mas NENHUMA das 3 células-alvo.
    // `patient_address:read` fica para provar que a aba "Servicio Contratado" segue existindo e
    // `localizacoes-card` continua visível quando SÓ falta `patient_coverage` (isola o alvo 3 do
    // gate de aba/tela, que é OUTRO mecanismo).
    const limitado = seedStaffInGroup({ uid: LIMITADO_UID, email: LIMITADO_EMAIL, groupName: GROUP_LIMITADO, country: 'AR' });
    groupLimitadoId = limitado.groupId;
    for (const [resource, action] of [
      ['patient', 'read'],
      ['patient_identity', 'read'],
      ['patient_therapeutic_project', 'read'],
      ['patient_address', 'read'],
      ['anacare_hours', 'read'],
      ['anacare_hours', 'validate'],
    ]) grantCell(groupLimitadoId, resource, action);

    // Paciente COMPARTILHADO pelos alvos 2/3 — as duas contas só LEEM; nenhuma escreve nele além
    // do setup, então não há disputa entre FULL e LIMITADO.
    const ins = insertTestPatient({ firstName: 'E2E Gates', lastName: `Permissao ${RUN_ID}`, status: 'ADMISSION' });
    patientId = ins.patientId;
    serviceId = scalar(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
          VALUES ('${patientId}', 'AT', true, 'AR', 'e2e-gates-setup', 'e2e-gates-setup') RETURNING id`);
    if (!serviceId) throw new Error('serviço contratado e2e não foi inserido');

    // Uma versão do projeto terapêutico — dado 100% SINTÉTICO (mesmo padrão de `diagnosis='TEA leve'`
    // já usado nos outros specs @integration), só para o botão "Exportar" ter o que exportar.
    versionId = scalar(`INSERT INTO patient_therapeutic_projects (
          patient_id, major, minor, contracted_service_id, diagnoses, clinical_context,
          general_objective, specific_objectives, activities, pathology_types, start_date, end_date, created_by
        ) VALUES (
          '${patientId}', 1, 0, '${serviceId}',
          '[{"uri":"http://id.who.int/icd/entity/e2e","code":"E2E00","title":"Diagnostico sintetico e2e"}]'::jsonb,
          'Texto clinico SINTETICO gerado so para este e2e de permission gates -- nao e dado real de paciente.',
          'Objetivo geral sintetico e2e.',
          '[{"id":"e2e-obj-1","label":"Objetivo especifico sintetico"}]'::jsonb,
          '[{"id":"e2e-act-1","label":"Atividade sintetica"}]'::jsonb,
          '[{"id":"e2e-path-1","label":"Tipo sintetico"}]'::jsonb,
          CURRENT_DATE, CURRENT_DATE + INTERVAL '90 days', '${FULL_UID}'
        ) RETURNING id`);
    if (!versionId) throw new Error('versao do projeto terapeutico e2e nao foi inserida');

    // Documento pré-registrado dos DOIS pacientes fake do Axônico — remove `missingDocument` da
    // lista de razões para os dois lados provarem elegibilidade IGUAL; a única diferença entre
    // FULL e LIMITADO no alvo 1 é a célula `integration:execute`, nunca a elegibilidade do turno.
    psql(`INSERT INTO ana_care_patient_document (ana_care_patient_id, document_number, document_type, registered_by)
          VALUES ('${PATIENT_FULL_AXONICO}', '${DNI_FULL}', 'DNI', '${FULL_UID}')`);
    psql(`INSERT INTO ana_care_patient_document (ana_care_patient_id, document_number, document_type, registered_by)
          VALUES ('${PATIENT_LIMITADO_AXONICO}', '${DNI_LIMITADO}', 'DNI', '${LIMITADO_UID}')`);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM ana_care_patient_document WHERE ana_care_patient_id IN ('${PATIENT_FULL_AXONICO}','${PATIENT_LIMITADO_AXONICO}')`);
    safeSql(`DELETE FROM shift_hours_validation WHERE source = 'anacare' AND source_shift_id IN ('${SHIFT_FULL}','${SHIFT_LIMITADO}')`);
    // `patient_therapeutic_projects` é IMUTÁVEL por trigger (lex C5, `fn_patient_therapeutic_
    // projects_imutavel`): DELETE direto é recusado enquanto o paciente ainda existe. A única
    // saída limpa é apagar `patients` PRIMEIRO — o `ON DELETE CASCADE` de `patient_id` remove a
    // versão (o trigger deixa passar quando o paciente já não existe) e também
    // `patient_contracted_services` (mesma regra, migration 319). `cleanupTestPatient` roda
    // DEPOIS só para as tabelas que ele cobre e que não tenham sido pegas pelo cascade — vira
    // no-op seguro (DELETE de 0 linhas não erra).
    safeSql(`DELETE FROM patients WHERE id = '${patientId}'`);
    cleanupTestPatient(patientId);
    cleanupStaffAndGroup(FULL_UID, groupFullId);
    cleanupStaffAndGroup(LIMITADO_UID, groupLimitadoId);
  });

  // ── Alvo 1 — Axônico (`integration:execute`) ────────────────────────────────────────────────

  test('1a. COM integration:execute — botão "Enviar" ao Axônico existe e fica HABILITADO', async ({ page }) => {
    await loginAs(page, FULL);
    await page.goto(`/admin/anacare/horas/${PATIENT_FULL_AXONICO}`);
    await expect(page.getByRole('heading', { name: new RegExp(`ID ${PATIENT_FULL_AXONICO}`) })).toBeVisible({ timeout: 15_000 });
    await irParaSemanaDe(page, TARGET_FULL.dateIso);

    const validar = page.getByTestId(`anacare-hours-validate-shift-${SHIFT_FULL}`);
    await expect(validar).toBeVisible({ timeout: 15_000 });
    await validar.click();
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_FULL}`)).toHaveCount(0, { timeout: 15_000 });

    // as 4 razões de bloqueio devem estar ausentes — turno elegível de verdade, não só visível.
    for (const reason of ['notValidated', 'missingCheckInOut', 'fractionalHours', 'missingDocument']) {
      await expect(page.getByTestId(`anacare-hours-axonico-reason-${reason}-${TARGET_FULL.dateIso}`)).toHaveCount(0);
    }

    const enviar = page.getByTestId(`anacare-hours-send-day-${TARGET_FULL.dateIso}`);
    await expect(enviar).toBeVisible({ timeout: 10_000 });
    await expect(enviar).toBeEnabled();
  });

  test('1b. SEM integration:execute — botão "Enviar" ao Axônico NÃO existe no DOM (turno igualmente elegível)', async ({ page }) => {
    await loginAs(page, LIMITADO);
    await page.goto(`/admin/anacare/horas/${PATIENT_LIMITADO_AXONICO}`);
    await expect(page.getByRole('heading', { name: new RegExp(`ID ${PATIENT_LIMITADO_AXONICO}`) })).toBeVisible({ timeout: 15_000 });
    await irParaSemanaDe(page, TARGET_LIMITADO.dateIso);

    const validar = page.getByTestId(`anacare-hours-validate-shift-${SHIFT_LIMITADO}`);
    await expect(validar).toBeVisible({ timeout: 15_000 });
    await validar.click();
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_LIMITADO}`)).toHaveCount(0, { timeout: 15_000 });

    for (const reason of ['notValidated', 'missingCheckInOut', 'fractionalHours', 'missingDocument']) {
      await expect(page.getByTestId(`anacare-hours-axonico-reason-${reason}-${TARGET_LIMITADO.dateIso}`)).toHaveCount(0);
    }

    // prova que a TELA renderizou o dia normalmente (não é falha de carga) — só o botão gateado sumiu.
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LIMITADO}`)).toBeVisible();
    await expect(page.getByTestId(`anacare-hours-send-day-${TARGET_LIMITADO.dateIso}`)).toHaveCount(0);
  });

  // ── Alvo 2 — Exportar PDF do projeto terapêutico (`patient_therapeutic_project:export`) ─────

  test('2a. COM patient_therapeutic_project:export — botão "Exportar" existe e fica HABILITADO', async ({ page }) => {
    await loginAs(page, FULL);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByText('Ficha del Paciente', { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByTestId(`tp-view-${versionId}`).click();
    await expect(page.getByTestId('therapeutic-project-drawer')).toBeVisible({ timeout: 10_000 });

    const exportar = page.getByTestId('therapeutic-project-export-btn');
    await expect(exportar).toBeVisible();
    await expect(exportar).toBeEnabled();
  });

  test('2b. SEM patient_therapeutic_project:export — botão "Exportar" NÃO existe no DOM (drawer abre normal)', async ({ page }) => {
    await loginAs(page, LIMITADO);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByText('Ficha del Paciente', { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByTestId(`tp-view-${versionId}`).click();
    // o drawer em si segue existindo (`patient_therapeutic_project:read` está concedido) — só o
    // botão de exportar, gateado por CÉLULA PRÓPRIA, some.
    await expect(page.getByTestId('therapeutic-project-drawer')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('therapeutic-project-export-btn')).toHaveCount(0);
  });

  // ── Alvo 3 — Container "Cobertura Médica" (`patient_coverage:read`) ─────────────────────────

  test('3a. COM patient_coverage:read — o card "Cobertura Médica" existe', async ({ page }) => {
    await loginAs(page, FULL);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByText('Ficha del Paciente', { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Servicio Contratado', exact: true }).click();
    await expect(page.getByTestId('cobertura-medica-card')).toBeVisible({ timeout: 10_000 });
  });

  test('3b. SEM patient_coverage:read — o card "Cobertura Médica" NÃO existe no DOM (aba/irmão seguem visíveis)', async ({ page }) => {
    await loginAs(page, LIMITADO);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByText('Ficha del Paciente', { exact: true })).toBeVisible({ timeout: 15_000 });

    // a aba existe porque `patient_address:read` (OUTRO container da mesma aba) foi concedido —
    // isola o gate do alvo 3 do gate de aba, que é mecanismo diferente (`tabsVisibleFor`).
    await page.getByRole('button', { name: 'Servicio Contratado', exact: true }).click();
    await expect(page.getByTestId('localizacoes-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('cobertura-medica-card')).toHaveCount(0);
  });
});
