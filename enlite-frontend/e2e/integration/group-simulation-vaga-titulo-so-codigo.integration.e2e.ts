/**
 * group-simulation-vaga-titulo-so-codigo.integration.e2e.ts @integration — change 093.
 *
 * Sem `patient_identity:read` o título do detalhe da vaga é SÓ o código do caso (`Caso N-M`, sem
 * sufixo) e o card do paciente não está no DOM; com a célula (controle positivo, mesma execução) o
 * título traz o nome e o card aparece. Roda com o engine ABAC de verdade LIGADO (`enforcement: 'on'`):
 * com ele OFF `useContainerAccess` devolve `visible: true` e nada esconderia.
 *
 * O nome do arquivo casa o `--grep "group-simulation|…"` do job engine ON de `_frontend-integration.yml`
 * (workflow intocado). Usuários reais (`seedStaffInGroup`/`grantCell`), célula concedida ANTES do 1º
 * request (cache do ABAC ~30 s), sem `page.route` de dado. Paciente sintético semeado por
 * `seedVacancyWithCards` (`FunnelMoveE2E Seed-<ts>`); nenhum dado real.
 *   - A: `vacancy:read`, SEM `patient_identity:read`.
 *   - B: A + `patient_identity:read`.
 */
import { test, expect } from '@playwright/test';
import { seedVacancyWithCards } from '../helpers/funnel-move-e2e-helper';
import {
  tokenFor, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, type MockUser,
} from '../helpers/abac-stack-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const A_UID = `qa.sim.vaga-titulo.a.${RUN_ID}`;
const B_UID = `qa.sim.vaga-titulo.b.${RUN_ID}`;
const STAFF_A: MockUser = { uid: A_UID, email: `${A_UID}@enlite.test`, role: 'recruiter', country: 'AR' };
const STAFF_B: MockUser = { uid: B_UID, email: `${B_UID}@enlite.test`, role: 'recruiter', country: 'AR' };

const NOME_REDIGIDO = 'Contato restrito';
// Primeiro nome sintético que `seedVacancyWithCards` grava no paciente (funnel-move-e2e-helper.ts).
const NOME_SINTETICO = 'FunnelMoveE2E';

type AuthzBody = { enforcement?: string; permissions?: string[] };
const temCelula = (b: AuthzBody | null, cell: string) => Array.isArray(b?.permissions) && b!.permissions!.includes(cell);

test.describe('Título da vaga só com o código sem patient_identity (engine ABAC ligado) @integration', () => {
  test.use({ viewport: { width: 1366, height: 768 }, locale: 'es-AR', timezoneId: 'America/Argentina/Buenos_Aires' });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let vacancyId = '';
  let seedCleanup: (() => void) | undefined;
  let groupAId = '';
  let groupBId = '';

  test.beforeAll(async ({ request }) => {
    const seed = seedVacancyWithCards([]);
    vacancyId = seed.vacancyId;
    seedCleanup = seed.cleanup;

    ({ groupId: groupAId } = seedStaffInGroup({ uid: A_UID, email: STAFF_A.email, groupName: `Vaga titulo A ${RUN_ID}`, country: 'AR' }));
    grantCell(groupAId, 'vacancy', 'read');
    // NUNCA patient_identity:read no A — é o que este teste prova que falta.

    ({ groupId: groupBId } = seedStaffInGroup({ uid: B_UID, email: STAFF_B.email, groupName: `Vaga titulo B ${RUN_ID}`, country: 'AR' }));
    grantCell(groupBId, 'vacancy', 'read');
    grantCell(groupBId, 'patient_identity', 'read');

    const a = await pollAuthz(request, STAFF_A, (b: AuthzBody) => b?.enforcement === 'on' && temCelula(b, 'vacancy:read'));
    const b = await pollAuthz(request, STAFF_B, (x: AuthzBody) => x?.enforcement === 'on' && temCelula(x, 'patient_identity:read'));
    expect(a.body?.enforcement, 'A: engine ligado no contrato').toBe('on');
    expect(temCelula(a.body, 'patient_identity:read'), 'A: SEM patient_identity:read').toBe(false);
    expect(b.body?.enforcement, 'B: engine ligado no contrato').toBe('on');
    expect(temCelula(b.body, 'patient_identity:read'), 'B: com patient_identity:read').toBe(true);
  });

  test.afterAll(() => {
    for (const [uid, gid] of [[A_UID, groupAId], [B_UID, groupBId]] as const) {
      try { cleanupStaffAndGroup(uid, gid); } catch (err) { console.error('[cleanup] staff falhou (seguindo)', err); }
    }
    try { seedCleanup?.(); } catch (err) { console.error('[cleanup] vaga/paciente falhou (seguindo)', err); }
  });

  async function readVacancy(request: import('@playwright/test').APIRequestContext, u: MockUser) {
    const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, {
      headers: { Authorization: `Bearer ${tokenFor(u)}` }, failOnStatusCode: false,
    });
    expect(res.status(), 'GET /api/admin/vacancies/:id').toBe(200);
    const body = (await res.json()) as { data?: Record<string, any> } & Record<string, any>;
    return (body.data ?? body) as Record<string, any>;
  }

  // Mesma regra de `formatCaseNumber` (>= 1000 → prefixo EN) e do título da página; o rótulo "Caso" é o es-AR.
  const tituloSoCodigo = (v: Record<string, any>): string => {
    const caso = v.case_number >= 1000 ? `EN${v.case_number}` : `${v.case_number}`;
    return v.vacancy_number != null ? `Caso ${caso}-${v.vacancy_number}` : `Caso ${caso}`;
  };

  test('A (sem patient_identity:read): API redige, H1 é exatamente o código, sem card do paciente', async ({ page, request }) => {
    const vA = await readVacancy(request, STAFF_A);
    expect(vA.patient_first_name, 'A: API devolve o nome redigido').toBe(NOME_REDIGIDO);
    expect(vA.case_number, 'A: case_number presente').not.toBeNull();

    await loginAs(page, STAFF_A);
    await page.goto(`/admin/vacancies/${vacancyId}`);
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible({ timeout: 20_000 });
    await expect(h1, 'A: H1 é exatamente `Caso N-M`').toHaveText(tituloSoCodigo(vA), { useInnerText: true });
    await expect(h1).not.toContainText('—');
    await expect(h1).not.toContainText(NOME_REDIGIDO);
    await expect(page.getByTestId('vacancy-patient-card'), 'A: card do paciente ausente').toHaveCount(0);
    console.log('[093] A: H1 == código; card do paciente ausente; API redigida');
  });

  test('B (com patient_identity:read): H1 traz o nome sintético e o card aparece', async ({ page, request }) => {
    const vB = await readVacancy(request, STAFF_B);
    expect(vB.patient_first_name, 'B: API devolve o nome real (sintético)').toBe(NOME_SINTETICO);

    await loginAs(page, STAFF_B);
    await page.goto(`/admin/vacancies/${vacancyId}`);
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible({ timeout: 20_000 });
    await expect(h1, 'B: H1 contém o nome').toContainText(` — ${NOME_SINTETICO}`);
    await expect(page.getByTestId('vacancy-patient-card'), 'B: card do paciente presente').toBeVisible();
    console.log('[093] B: H1 com nome; card do paciente presente');
  });
});
