/**
 * enquadre-052-eventos.integration.e2e.ts @integration — spec 052 (aba "Encuadre" da vaga), Fase 2, T-32.
 *
 * E2E DE TELA, sem mock de resposta: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por SQL),
 * clique/teclado de humano (`loginAs`, `keyboard.type`, valor lido da tela). A fronteira externa é DUBLÊ dentro da API
 * (`ADMISSION_EXTERNALS=fake` no `docker-compose.group-simulation.yml`: o Calendar do enquadre é o `FakeAdmissionCalendar`; e-mail de
 * entrevistadora com prefixo `falha.` faz a criação do evento falhar). NENHUM canal real: nada de Google, WhatsApp ou Tactiq.
 *  - Mensagem de etapa: marcar Selecionado/Rechazado grava o evento de estágio e publica no Pub/Sub, que com `NODE_ENV=test` é
 *    mock (`PubSubClient.ts`); ninguém chama `/api/internal/outbox/process` neste job; e `api.twilio.com` resolve para 127.0.0.1
 *    dentro do contêiner (`docker-compose.test.yml`, `extra_hosts`). O convite é o do próprio Google (dublê), só para `example.test`
 *    (`ENQUADRE_GUEST_POLICY=allowlist:example.test`, trava fail-closed da criação).
 *
 *  1 feliz  — criar (3 prestadores) -> marcar 1 Selecionado ("Mover a…") e 1 Rechazado (botão + motivo obrigatório) -> evento no
 *             passado vira "pendiente de cierre" -> "Cerrar evento" (diálogo conta 1 sem marcação) -> somente leitura; o banco
 *             guarda os carimbos selected/rejected/returned e as 2 linhas de histórico de estágio.
 *  2 alt    — o Google falha (entrevistadora `falha.`): a mensagem aprovada aparece, o drawer fica aberto e NADA é gravado (0 eventos,
 *             0 participações; controle positivo: com a entrevistadora boa, o mesmo drawer grava 1 evento e 2 participações).
 *  3 alt    — encerrar com não marcados gera anotação de sistema por prestador, que aparece no card, e os dois voltam à lista de
 *             disponíveis e podem entrar num novo evento.
 *  4 alt    — spec 067 FR-24: o prestador convocado deixou de ser apto (documento desvalidado depois de entrar no evento): "Mover a…
 *             Seleccionado" é RECUSADO pelo servidor (403 WORKER_NOT_ELIGIBLE / documents_not_validated) e a tela mostra a mensagem aprovada;
 *             nada é gravado (etapa, carimbo e histórico intactos). Sem canal: a recusa vem ANTES de qualquer escrita, Calendar nem é tocado.
 *
 * ⚠️ Precisa do engine ABAC LIGADO e da API com `ADMISSION_EXTERNALS=fake` + as duas envs do enquadre — por isso o token
 * `enquadre-052` entra no `--grep` do job `integration-e2e-group-simulation` do `_frontend-integration.yml` (e NÃO no `grep:` do
 * `pr-gate.yml`). Rodar local = o job do CI: `ABAC_API_URL`, `ABAC_TEST_DB_URL`, `E2E_PG_CONTAINER`.
 * Dados SINTÉTICOS ("Ficticio NN", e-mails @example.test). Escrito na T-32; quem prova que PASSA é o CI.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from '../helpers/db-test-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';
import { seedInterviewHost, cleanupInterviewHosts } from '../helpers/interview-host-seed';
import { insertAptoWorker, cleanupEligibilityWorkerChildren } from '../helpers/eligibility-worker-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const HOST_OK = `ana.e2e052-${RUN_ID}@example.test`;
const HOST_FALHA = `falha.e2e052-${RUN_ID}@example.test`;
const CREATE_ROUTE = /\/api\/admin\/vacancies\/[0-9a-f-]+\/enquadre-events$/;
const MOVE_ROUTE = /\/api\/admin\/vacancies\/[0-9a-f-]+\/enquadre-events\/[0-9a-f-]+\/participants\/[0-9a-f-]+\/move$/;
const NOTA_RE = /^No fue marcado en el encuadre del \d{2}\/\d{2} \d{2}:\d{2}$/;
const GOOGLE_ERROR = 'No se pudo crear el evento en Google Calendar. No se guardó nada.';

const staffUid = `e2e-052-chefe-${RUN_ID}`;
const staff: MockUser = { uid: staffUid, email: `${staffUid}@e2e.test`, role: 'admin', country: 'AR' };

interface Scenario { patientId: string; vacancyId: string; workerIds: string[] }
const scenarios: Scenario[] = [];
let groupId = '';
let hostOkId = '';
let hostFalhaId = '';

/** Dia civil de Buenos Aires + N dias: `YYYY-MM-DD` (o que o input date guarda) e `MMDDYYYY` (o que uma pessoa digita no Chrome en-US). */
function diaEmBuenosAires(n: number): { iso: string; digitado: string } {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = hoje.split('-').map(Number);
  const iso = new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  return { iso, digitado: `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}` };
}
let proximoDia = 20 + Math.floor(Math.random() * 300);
const diaLivre = (): { iso: string; digitado: string } => diaEmBuenosAires(++proximoDia);

const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64');

/** Paciente + vaga publicada (SEARCHING) + N prestadores REGISTERED com e-mail `example.test` e candidatura em COMPLETED. */
function seedScenario(nWorkers: number): Scenario {
  const { patientId, addressId } = insertTestPatient({ withAddress: true, firstName: 'Ficticio', lastName: `Enq052${RUN_ID}` });
  const vacancyId = insertBaseVacancy({
    patientId, patientAddressId: addressId!, caseNumber: 960_000 + Math.floor(Math.random() * 30_000), status: 'SEARCHING', isDraft: false,
  });
  const workerIds: string[] = [];
  const sc: Scenario = { patientId, vacancyId, workerIds };
  scenarios.push(sc);
  for (let i = 1; i <= nWorkers; i++) {
    const tag = `${RUN_ID}-${scenarios.length}-${i}`;
    // Spec 067 FR-07: só prestador APTO (REGISTERED + cadastro completo + documentos obrigatórios VALIDADOS) é convocável.
    // O helper ÚNICO semeia isso (documentos e document_validations); aqui só se ajusta identidade/e-mail (allowlist `example.test`).
    const id = insertAptoWorker({ docs: 'validated' }).workerId;
    psql(`UPDATE workers SET auth_uid = 'e2e052-${tag}', email = 'prestador${i}.e2e052-${tag}@example.test',
      first_name_encrypted = '${b64(`Ficticio ${String(i).padStart(2, '0')}`)}', last_name_encrypted = '${b64('E2E052')}' WHERE id = '${id}'`);
    workerIds.push(id);
    psql(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ('${id}', '${vacancyId}', 'COMPLETED', 'talentum')`);
  }
  return sc;
}

function cleanupScenario(sc: Scenario): void {
  const ids = sc.workerIds.map((w) => `'${w}'`).join(',') || "''";
  safeSql(`DELETE FROM enquadre_events WHERE job_posting_id = '${sc.vacancyId}'`); // participações saem em cascata
  safeSql(`DELETE FROM worker_job_applications WHERE job_posting_id = '${sc.vacancyId}'`); // notas e histórico saem em cascata
  safeSql(`DELETE FROM encuadres WHERE job_posting_id = '${sc.vacancyId}'`);
  for (const w of sc.workerIds) { try { cleanupEligibilityWorkerChildren(w); } catch (err) { console.error('[cleanup] satélites do apto falharam (seguindo)', err); } }
  safeSql(`DELETE FROM workers WHERE id IN (${ids})`);
  try { cleanupTestPatient(sc.patientId); } catch (err) { console.error('[cleanup] paciente/vaga falhou (seguindo)', err); }
}

const eventsOf = (sc: Scenario): number => Number(scalar(`SELECT count(*) FROM enquadre_events WHERE job_posting_id = '${sc.vacancyId}'`));
const participantsOf = (sc: Scenario): number => Number(scalar(`SELECT count(*) FROM enquadre_event_participants WHERE job_posting_id = '${sc.vacancyId}'`));
const stageOf = (sc: Scenario, workerId: string): string =>
  scalar(`SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${sc.vacancyId}'`);
const participantId = (eventId: string, workerId: string): string =>
  scalar(`SELECT id FROM enquadre_event_participants WHERE event_id = '${eventId}' AND worker_id = '${workerId}'`);
/** Põe o evento no passado (como dona do banco de teste; `ends_at > starts_at` é CHECK, por isso os dois). */
const makePast = (eventId: string): void => { psql(`UPDATE enquadre_events SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id = '${eventId}'`); };

/** Digita como uma pessoa: clique no campo, volta ao 1º segmento pelo teclado, digita e LÊ o valor da tela. */
async function digitar(page: Page, campo: Locator, teclas: string, esperado: string): Promise<void> {
  await campo.click();
  await expect(campo).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft'); // 1º segmento (mês / hora)
  await page.keyboard.type(teclas);
  await expect(campo).toHaveValue(esperado);
}

async function abrirAbaEncuadre(page: Page, sc: Scenario): Promise<void> {
  await page.goto(`/admin/vacancies/${sc.vacancyId}`);
  await expect(page.getByTestId('vacancy-tab-enquadre')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('vacancy-tab-enquadre').click();
  await expect(page.getByTestId('enquadre-tab')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('enquadre-unassigned-count')).toBeVisible({ timeout: 15_000 });
}

/** Abre o drawer, escolhe a entrevistadora, digita data e hora (11:00) e marca os prestadores. Devolve o dia escolhido. */
async function preencherDrawer(page: Page, hostId: string, workerIds: string[]): Promise<{ iso: string; digitado: string }> {
  await page.getByTestId('enquadre-create-button').or(page.getByTestId('enquadre-empty-create-button')).first().click();
  await expect(page.getByTestId('enquadre-create-drawer')).toBeVisible();
  await expect(page.getByTestId('enquadre-create-submit')).toBeDisabled(); // nada escolhido ainda
  await page.getByTestId(`enquadre-create-host-${hostId}`).click();
  await expect(page.getByTestId(`enquadre-create-host-radio-${hostId}`)).toBeChecked();
  const dia = diaLivre();
  await digitar(page, page.getByTestId('enquadre-create-date-input'), dia.digitado, dia.iso);
  await digitar(page, page.getByTestId('enquadre-create-time-input'), '1100AM', '11:00');
  for (const w of workerIds) {
    await page.getByTestId(`enquadre-create-worker-checkbox-${w}`).click();
    await expect(page.getByTestId(`enquadre-create-worker-checkbox-${w}`)).toBeChecked();
  }
  await expect(page.getByTestId('enquadre-create-selected-count')).toHaveAttribute('data-count', String(workerIds.length));
  await expect(page.getByTestId('enquadre-create-submit')).toBeEnabled();
  return dia;
}

const colunaDe = (page: Page, pid: string): Locator => page.getByTestId(`enquadre-participant-${pid}`);

test.use({ viewport: { width: 1600, height: 1100 } });

test.describe('enquadre-052 — aba Encuadre da vaga: criar, marcar, encerrar, falha do Google e anotação (spec 052) @integration', () => {
  test.setTimeout(240_000);

  test.beforeAll(() => {
    hostOkId = seedInterviewHost({ email: HOST_OK, displayName: 'Entrevistadora E2E052' });
    hostFalhaId = seedInterviewHost({ email: HOST_FALHA, displayName: 'Falha E2E052' });
    psql(`INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ('${HOST_OK}', 'tq-e052-ok-${RUN_ID}', 'linked'), ('${HOST_FALHA}', 'tq-e052-falha-${RUN_ID}', 'linked')`);

    // Células concedidas ANTES do 1º request (o override liga PERMISSION_CACHE_TTL_MS=30000). Leitura da vaga/funil/paciente: a página
    // e as anotações do card (`funnel:*`) as pedem; `match:read` é a leitura que a aba Reclutamiento (padrão) faz ao abrir.
    groupId = seedStaffInGroup({ uid: staffUid, email: staff.email, groupName: `Enq052 Chefe ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of [
      ['vacancy', 'read'], ['patient_identity', 'read'], ['funnel', 'read'], ['match', 'read'],
      ['enquadre_event', 'read'], ['enquadre_event', 'create'], ['enquadre_event', 'update'], ['enquadre_result', 'update'],
    ] as Array<[string, string]>) grantCell(groupId, r, a);
  });

  test.afterAll(() => {
    for (const sc of scenarios) cleanupScenario(sc);
    safeSql(`DELETE FROM tactiq_links WHERE lower(host_email) = ANY(ARRAY['${HOST_OK}','${HOST_FALHA}'])`);
    cleanupInterviewHosts([HOST_OK, HOST_FALHA]);
    cleanupStaffAndGroup(staffUid, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Enq052 Chefe ${RUN_ID}'`);
  });

  test('enquadre-052 feliz: cria com 3 prestadores -> marca Selecionado e Rechazado -> pendiente de cierre -> encerra -> somente leitura e carimbos no banco', async ({ page }, testInfo) => {
    const sc = seedScenario(4); // 3 convocados + 1 que fica de fora
    const [w1, w2, w3, w4] = sc.workerIds;
    await loginAs(page, staff);
    await abrirAbaEncuadre(page, sc);
    await expect(page.getByTestId('enquadre-empty')).toBeVisible();
    await expect(page.getByTestId('enquadre-unassigned-count')).toHaveAttribute('data-count', '4');
    expect(eventsOf(sc), 'começa sem evento').toBe(0);

    // Criar: entrevistadora apta, data e hora digitadas, 3 prestadores.
    const dia = await preencherDrawer(page, hostOkId, [w1, w2, w3]);
    const criou = page.waitForResponse((r) => r.request().method() === 'POST' && CREATE_ROUTE.test(r.url()));
    await page.getByTestId('enquadre-create-submit').click();
    expect((await criou).status()).toBe(201);
    await expect(page.getByTestId('enquadre-create-drawer')).toHaveCount(0);

    const eventId = scalar(`SELECT id FROM enquadre_events WHERE job_posting_id = '${sc.vacancyId}'`);
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
    const linha = page.getByTestId(`enquadre-event-row-${eventId}`);
    await expect(linha).toBeVisible({ timeout: 15_000 });
    await expect(linha).toHaveAttribute('data-phase', 'scheduled');
    await expect(page.getByTestId(`enquadre-event-convoked-${eventId}`)).toHaveText('3');
    await expect(page.getByTestId(`enquadre-event-time-${eventId}`)).toHaveText('11:00');
    await expect(page.getByTestId(`enquadre-event-date-${eventId}`)).toHaveText(`${dia.iso.slice(8, 10)}/${dia.iso.slice(5, 7)}`);
    await expect(page.getByTestId(`enquadre-event-phase-${eventId}`)).toHaveText('Agendado');
    await expect(page.getByTestId('enquadre-unassigned-count')).toHaveAttribute('data-count', '1'); // só o w4 sobrou
    expect(scalar(`SELECT status || '|' || (event_code ~ '^ENC-[0-9A-Z]{6}$') || '|' || host_email FROM enquadre_events WHERE id = '${eventId}'`)).toBe(`open|true|${HOST_OK}`);
    expect(scalar(`SELECT count(*) FROM enquadre_event_participants WHERE event_id = '${eventId}' AND released_at IS NULL`)).toBe('3');
    await page.screenshot({ path: testInfo.outputPath('1-feliz-lista-com-evento.png'), fullPage: true });

    // Kanban do evento: 3 em Convocados; "Cerrar evento" bloqueado com o motivo escrito (o evento ainda não terminou).
    await linha.click();
    await expect(page.getByTestId('enquadre-kanban')).toHaveAttribute('data-phase', 'scheduled');
    await expect(page.getByTestId('kanban-column-CONVOKED-count')).toHaveText('3');
    await expect(page.getByTestId('kanban-column-SELECTED-count')).toHaveText('0');
    await expect(page.getByTestId('enquadre-kanban-close')).toBeDisabled();
    await expect(page.getByTestId('enquadre-kanban-close-blocked')).toBeVisible();
    const [p1, p2, p3] = [participantId(eventId, w1), participantId(eventId, w2), participantId(eventId, w3)];

    // Selecionado pelo "Mover a…".
    await colunaDe(page, p1).getByTestId('move-to-button').click();
    await page.getByTestId('move-to-option-SELECTED').click();
    await expect(colunaDe(page, p1)).toHaveAttribute('data-column', 'SELECTED', { timeout: 15_000 });
    expect(stageOf(sc, w1)).toBe('SELECTED');

    // Rechazado pelo botão do card: o motivo é obrigatório (confirmar só habilita depois de escolher).
    await colunaDe(page, p2).getByTestId('reject-button').click();
    await expect(page.getByTestId('rejection-modal')).toBeVisible();
    await expect(page.getByTestId('rejection-confirm')).toBeDisabled();
    const motivo = page.locator('[data-testid^="rejection-option-"]').first();
    await motivo.click();
    const categoria = await motivo.locator('input[type="radio"]').inputValue();
    await expect(page.getByTestId('rejection-confirm')).toBeEnabled();
    await page.getByTestId('rejection-confirm').click();
    await expect(colunaDe(page, p2)).toHaveAttribute('data-column', 'REJECTED', { timeout: 15_000 });
    expect(stageOf(sc, w2)).toBe('REJECTED');
    expect(stageOf(sc, w3), 'o não marcado segue em Completado').toBe('COMPLETED');
    await expect(page.getByTestId('kanban-column-CONVOKED-count')).toHaveText('1');

    // O histórico de estágio ganhou as 2 linhas (e a de Rechazado carrega o motivo escolhido na tela).
    const historico = psql(`SELECT wja.worker_id || ':' || h.new_value || ':' || COALESCE(h.reason_category, '') FROM worker_job_application_stage_history h
        JOIN worker_job_applications wja ON wja.id = h.application_id
       WHERE wja.job_posting_id = '${sc.vacancyId}' AND h.field_name = 'application_funnel_stage' AND h.new_value IN ('SELECTED','REJECTED')`).trim().split('\n').sort();
    expect(historico).toEqual([`${w1}:SELECTED:`, `${w2}:REJECTED:${categoria}`].sort());
    await page.screenshot({ path: testInfo.outputPath('2-feliz-marcados.png'), fullPage: true });

    // O evento passa do horário (dona do banco de teste): a linha vira "pendiente de cierre" com "2 marcados de 3".
    makePast(eventId);
    await abrirAbaEncuadre(page, sc);
    await expect(page.getByTestId(`enquadre-event-row-${eventId}`)).toHaveAttribute('data-phase', 'pending_close', { timeout: 15_000 });
    await expect(page.getByTestId(`enquadre-event-marked-${eventId}`)).toHaveText('2 marcados de 3');
    await expect(page.getByTestId(`enquadre-event-phase-${eventId}`)).toHaveText('Pendiente de cierre');

    // Encerrar: o diálogo conta 1 sem marcação; confirmar fecha e o evento vira somente leitura.
    await page.getByTestId(`enquadre-event-row-${eventId}`).click();
    await expect(page.getByTestId('enquadre-kanban')).toHaveAttribute('data-phase', 'pending_close');
    await expect(page.getByTestId('enquadre-kanban-close')).toBeEnabled();
    await expect(page.getByTestId('enquadre-kanban-close-blocked')).toHaveCount(0);
    await page.getByTestId('enquadre-kanban-close').click();
    await expect(page.getByTestId('enquadre-close-dialog')).toBeVisible();
    await expect(page.getByTestId('enquadre-close-dialog')).toContainText('1 convocado sin marcación vuelve a Completado');
    await page.getByTestId('enquadre-close-dialog-confirm').click();
    await expect(page.getByTestId('enquadre-close-dialog')).toHaveCount(0);
    await expect(page.getByTestId('enquadre-kanban')).toHaveAttribute('data-phase', 'closed', { timeout: 15_000 });
    await expect(page.getByTestId('enquadre-kanban-readonly')).toBeVisible();
    await expect(page.getByTestId('enquadre-kanban-actions')).toHaveCount(0);
    await expect(page.getByTestId('move-to-button')).toHaveCount(0);
    await expect(page.getByTestId('reject-button')).toHaveCount(0);
    await expect(colunaDe(page, p3)).toHaveAttribute('data-column', 'CONVOKED');
    await expect(page.getByTestId(`enquadre-participant-returned-${p3}`)).toBeVisible(); // "Devuelto"
    await expect(colunaDe(page, p1)).toHaveAttribute('data-column', 'SELECTED');
    await expect(colunaDe(page, p2)).toHaveAttribute('data-column', 'REJECTED');

    // Sem arrasto: arrastar o Seleccionado para Rechazados não move nada (nenhum PUT .../move) e o card fica onde estava.
    let puts = 0;
    page.on('request', (r) => { if (r.method() === 'PUT' && MOVE_ROUTE.test(r.url())) puts += 1; });
    await dndKitDrag(page, page.getByTestId(`kanban-card-${p1}`), page.getByTestId('kanban-column-REJECTED'));
    expect(puts, 'evento encerrado: nenhum PUT de mover').toBe(0);
    await expect(colunaDe(page, p1)).toHaveAttribute('data-column', 'SELECTED');
    expect(stageOf(sc, w1)).toBe('SELECTED');
    await page.screenshot({ path: testInfo.outputPath('3-feliz-encerrado.png'), fullPage: true });

    // O banco concorda: evento encerrado e os 3 carimbos.
    expect(scalar(`SELECT status FROM enquadre_events WHERE id = '${eventId}'`)).toBe('closed');
    const carimbos = psql(`SELECT worker_id || ':' || outcome || ':' || release_kind FROM enquadre_event_participants WHERE event_id = '${eventId}'`).trim().split('\n').sort();
    expect(carimbos).toEqual([`${w1}:selected:closed`, `${w2}:rejected:closed`, `${w3}:returned:closed`].sort());
    expect(w4, 'o w4 nunca foi convocado').toBeTruthy();
    expect(scalar(`SELECT count(*) FROM enquadre_event_participants WHERE worker_id = '${w4}'`)).toBe('0');
  });

  test('enquadre-052 Google falha: o drawer mostra o erro aprovado, fica aberto e NADA é gravado (0 eventos, 0 participações)', async ({ page }, testInfo) => {
    const sc = seedScenario(3);
    const [w1, w2] = sc.workerIds;
    await loginAs(page, staff);
    await abrirAbaEncuadre(page, sc);
    await expect(page.getByTestId('enquadre-unassigned-count')).toHaveAttribute('data-count', '3');
    expect(eventsOf(sc)).toBe(0);

    await preencherDrawer(page, hostFalhaId, [w1, w2]); // entrevistadora `falha.`: o dublê do Calendar rejeita a criação
    const tentou = page.waitForResponse((r) => r.request().method() === 'POST' && CREATE_ROUTE.test(r.url()), { timeout: 90_000 });
    await page.getByTestId('enquadre-create-submit').click();
    expect((await tentou).status(), 'a criação falhou no servidor').toBeGreaterThanOrEqual(400);
    await expect(page.getByTestId('enquadre-create-error')).toHaveText(GOOGLE_ERROR, { timeout: 30_000 });
    await expect(page.getByTestId('enquadre-create-drawer')).toBeVisible(); // continua aberto
    await expect(page.getByTestId('enquadre-create-selected-count')).toHaveAttribute('data-count', '2'); // a seleção não se perdeu
    await page.screenshot({ path: testInfo.outputPath('4-google-falhou.png') });

    // Nada gravado: as contagens do banco (controle positivo logo abaixo prova que a consulta enxerga um evento criado).
    expect(scalar(`SELECT count(*) FROM enquadre_events WHERE job_posting_id = '${sc.vacancyId}'`), 'eventos da vaga').toBe('0');
    expect(scalar(`SELECT count(*) FROM enquadre_event_participants WHERE job_posting_id = '${sc.vacancyId}'`), 'participações da vaga').toBe('0');

    // Fechando o drawer: a lista segue vazia e o contador de completados sem evento não mudou.
    await page.getByTestId('enquadre-create-cancel').click();
    await expect(page.getByTestId('enquadre-create-drawer')).toHaveCount(0);
    await expect(page.getByTestId('enquadre-empty')).toBeVisible();
    await expect(page.getByTestId('enquadre-unassigned-count')).toHaveAttribute('data-count', '3');

    // Controle positivo: com a entrevistadora boa o MESMO fluxo grava 1 evento e 2 participações.
    await preencherDrawer(page, hostOkId, [w1, w2]);
    const criou = page.waitForResponse((r) => r.request().method() === 'POST' && CREATE_ROUTE.test(r.url()));
    await page.getByTestId('enquadre-create-submit').click();
    expect((await criou).status()).toBe(201);
    await expect(page.locator('[data-testid^="enquadre-event-row-"]')).toHaveCount(1, { timeout: 15_000 });
    expect(eventsOf(sc)).toBe(1);
    expect(participantsOf(sc)).toBe(2);
  });

  test('enquadre-052 encerrar com não marcados: 2 anotações do Sistema, aparecem no card, e os 2 voltam a poder ser convocados', async ({ page }, testInfo) => {
    const sc = seedScenario(2);
    const [wa, wb] = sc.workerIds;
    // Evento JÁ no passado, aberto, com 2 convocados sem marca (semeado direto: como dona do banco de teste).
    const codigo = `ENC-${Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X')}`;
    const eventId = scalar(`INSERT INTO enquadre_events (job_posting_id, host_email, host_display_name, starts_at, ends_at, event_code, created_by_uid)
      VALUES ('${sc.vacancyId}', '${HOST_OK}', 'Entrevistadora E2E052', now() - interval '2 hours', now() - interval '1 hour', '${codigo}', '${staffUid}') RETURNING id`);
    psql(`INSERT INTO enquadre_event_participants (event_id, job_posting_id, worker_id, added_by_uid)
          VALUES ('${eventId}', '${sc.vacancyId}', '${wa}', '${staffUid}'), ('${eventId}', '${sc.vacancyId}', '${wb}', '${staffUid}')`);

    await loginAs(page, staff);
    await abrirAbaEncuadre(page, sc);
    await expect(page.getByTestId(`enquadre-event-row-${eventId}`)).toHaveAttribute('data-phase', 'pending_close', { timeout: 15_000 });
    await expect(page.getByTestId(`enquadre-event-marked-${eventId}`)).toHaveText('0 marcados de 2');
    await expect(page.getByTestId('enquadre-unassigned-count')).toHaveAttribute('data-count', '0'); // os 2 estão convocados

    await page.getByTestId(`enquadre-event-row-${eventId}`).click();
    await page.getByTestId('enquadre-kanban-close').click();
    await expect(page.getByTestId('enquadre-close-dialog')).toContainText('2 convocados sin marcación vuelven a Completado');
    await page.getByTestId('enquadre-close-dialog-confirm').click();
    await expect(page.getByTestId('enquadre-kanban')).toHaveAttribute('data-phase', 'closed', { timeout: 15_000 });

    // O banco: 2 participações devolvidas e 2 anotações do Sistema com o texto fixo (hora de parede do evento em Buenos Aires).
    expect(scalar(`SELECT count(*) FROM enquadre_event_participants WHERE event_id = '${eventId}' AND outcome = 'returned' AND release_kind = 'closed'`)).toBe('2');
    const notas = psql(`SELECT note_text FROM wja_contact_notes WHERE job_posting_id = '${sc.vacancyId}' AND created_by_admin_id = 'system:enquadre' AND created_by_admin_name = 'Sistema'`).trim().split('\n');
    expect(notas).toHaveLength(2);
    for (const n of notas) expect(n).toMatch(NOTA_RE);
    const esperada = scalar(`SELECT 'No fue marcado en el encuadre del ' || to_char(starts_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') FROM enquadre_events WHERE id = '${eventId}'`);
    expect(notas).toEqual([esperada, esperada]);

    // Na tela: as notas do card do prestador mostram a anotação, de autor "Sistema".
    const pa = participantId(eventId, wa);
    await colunaDe(page, pa).getByTestId('notes-button').click();
    const nota = page.getByTestId('contact-note-item');
    await expect(nota).toHaveCount(1, { timeout: 15_000 });
    await expect(nota).toContainText('No fue marcado en el encuadre del');
    await expect(nota).toContainText('Sistema');
    await page.screenshot({ path: testInfo.outputPath('5-anotacao-do-sistema.png') });
    await page.getByRole('button', { name: 'Cerrar', exact: true }).last().click();
    await expect(page.getByTestId('contact-note-item')).toHaveCount(0);

    // Volta à lista: o contador refaz (2 completados sem evento) e o "Crear evento" oferece os 2 de novo.
    await page.getByTestId('enquadre-kanban-back').click();
    await expect(page.getByTestId('enquadre-unassigned-count')).toHaveAttribute('data-count', '2', { timeout: 15_000 });
    await page.getByTestId('enquadre-create-button').click();
    await expect(page.getByTestId('enquadre-create-drawer')).toBeVisible();
    await expect(page.getByTestId(`enquadre-create-worker-option-${wa}`)).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId(`enquadre-create-worker-option-${wb}`)).toHaveCount(1);
    await page.getByTestId('enquadre-create-cancel').click();

    // Um 2º evento com um deles.
    await preencherDrawer(page, hostOkId, [wa]);
    const criou = page.waitForResponse((r) => r.request().method() === 'POST' && CREATE_ROUTE.test(r.url()));
    await page.getByTestId('enquadre-create-submit').click();
    expect((await criou).status()).toBe(201);
    const novoId = scalar(`SELECT id FROM enquadre_events WHERE job_posting_id = '${sc.vacancyId}' AND id <> '${eventId}'`);
    await expect(page.getByTestId(`enquadre-event-row-${novoId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`enquadre-event-convoked-${novoId}`)).toHaveText('1');
    await expect(page.getByTestId(`enquadre-event-row-${eventId}`)).toHaveAttribute('data-phase', 'closed'); // o 1º segue encerrado, na lista
    expect(scalar(`SELECT count(*) FROM enquadre_event_participants WHERE event_id = '${novoId}' AND worker_id = '${wa}' AND released_at IS NULL`)).toBe('1');
    await expect(page.getByTestId('enquadre-unassigned-count')).toHaveAttribute('data-count', '1'); // só o wb sobrou
  });

  test('enquadre-052 prestador deixou de ser apto (067 FR-24): "Mover a… Seleccionado" é recusado com a mensagem aprovada e NADA é gravado', async ({ page }, testInfo) => {
    const sc = seedScenario(2);
    const [wa, wb] = sc.workerIds;
    // Evento ABERTO e futuro, com os 2 convocados (semeado direto, como dona do banco de teste: nenhum Calendar, nenhum e-mail).
    const codigo = `ENC-${Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X')}`;
    const eventId = scalar(`INSERT INTO enquadre_events (job_posting_id, host_email, host_display_name, starts_at, ends_at, event_code, created_by_uid)
      VALUES ('${sc.vacancyId}', '${HOST_OK}', 'Entrevistadora E2E052', now() + interval '1 day', now() + interval '1 day 1 hour', '${codigo}', '${staffUid}') RETURNING id`);
    psql(`INSERT INTO enquadre_event_participants (event_id, job_posting_id, worker_id, added_by_uid)
          VALUES ('${eventId}', '${sc.vacancyId}', '${wa}', '${staffUid}'), ('${eventId}', '${sc.vacancyId}', '${wb}', '${staffUid}')`);
    // A validação do documento do `wa` cai DEPOIS de ele entrar no evento (o admin a tirou na ficha): ele deixa de ser apto.
    psql(`UPDATE worker_documents SET document_validations = '{}'::jsonb WHERE worker_id = '${wa}'`);
    expect(scalar(`SELECT fn_worker_is_apto('${wa}')`), 'o dono do apto diz NÃO para o wa').toBe('f');
    expect(scalar(`SELECT fn_worker_is_apto('${wb}')`), 'e SIM para o wb (controle)').toBe('t');
    const pa = participantId(eventId, wa);
    const historicoAntes = scalar(`SELECT count(*) FROM worker_job_application_stage_history h JOIN worker_job_applications wja ON wja.id = h.application_id WHERE wja.job_posting_id = '${sc.vacancyId}'`);

    await loginAs(page, staff);
    await abrirAbaEncuadre(page, sc);
    await page.getByTestId(`enquadre-event-row-${eventId}`).click();
    await expect(page.getByTestId('enquadre-kanban')).toHaveAttribute('data-phase', 'scheduled');
    await expect(page.getByTestId('kanban-column-CONVOKED-count')).toHaveText('2');
    await expect(page.getByTestId('enquadre-kanban-error')).toHaveCount(0);

    // o clique de quem tenta marcar o prestador como Selecionado
    const recusa = page.waitForResponse((r) => r.request().method() === 'PUT' && MOVE_ROUTE.test(r.url()));
    await colunaDe(page, pa).getByTestId('move-to-button').click();
    await page.getByTestId('move-to-option-SELECTED').click();
    const resposta = await recusa;
    expect(resposta.status(), 'o servidor recusa').toBe(403);
    const corpo = (await resposta.json()) as { code?: string; reason?: string };
    expect(corpo.code).toBe('WORKER_NOT_ELIGIBLE');
    expect(corpo.reason).toBe('documents_not_validated');

    // a tela diz o que houve, na mensagem aprovada (e o card NÃO saiu de Convocados)
    await expect(page.getByTestId('enquadre-kanban-error')).toHaveText('Algún prestador ya no es apto (sus documentos dejaron de estar validados). Actualizamos la lista.');
    await expect(colunaDe(page, pa)).toHaveAttribute('data-column', 'CONVOKED');
    await page.screenshot({ path: testInfo.outputPath('6-nao-apto-recusado.png'), fullPage: true });

    // nada gravado: etapa, carimbo da participação e histórico de estágio intactos
    expect(stageOf(sc, wa)).toBe('COMPLETED');
    expect(scalar(`SELECT coalesce(outcome, 'null') FROM enquadre_event_participants WHERE id = '${pa}'`)).toBe('null');
    expect(scalar(`SELECT count(*) FROM worker_job_application_stage_history h JOIN worker_job_applications wja ON wja.id = h.application_id WHERE wja.job_posting_id = '${sc.vacancyId}'`)).toBe(historicoAntes);
  });
});
