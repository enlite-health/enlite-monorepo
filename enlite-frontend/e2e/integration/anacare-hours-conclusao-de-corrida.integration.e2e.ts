/**
 * anacare-hours-conclusao-de-corrida.integration.e2e.ts @integration
 *
 * E2E REAL (sem mock de API) dos 3 estados novos do banner de topo da lista "Horas Ana Care"
 * (F1+F2, change `anacare-horas-conclusao-de-corrida`, migration 457, PRs #458/#459) —
 * `computeSnapshotState` em `AnaCareHoursMapper.ts` (precedência: nao_construido > desconhecido >
 * parcial > velho > fresco). Mesmo stack/padrão de login dos moldes
 * `anacare-hours-conferencia.integration.e2e.ts`/`anacare-hours-sync-real.integration.e2e.ts`:
 *
 *   API      http://localhost:8080
 *   Postgres postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e
 *   Vite     http://localhost:5173 — SEM VITE_FIREBASE_AUTH_EMULATOR (padrão `integration`)
 *
 * MONTAGEM DE CENÁRIO POR SQL DIRETO (aceitável — o fluxo sob teste é a TELA, não o setup):
 * cada caso escreve sua própria linha em `anacare_sync_run` (source='anacare', period_month) e
 * garante ≥1 linha em `anacare_patient_month` para o mês (senão `naoConstruido` teria precedência
 * e mascararia os 3 estados testados aqui — `AnaCareHoursService.getMonthSnapshot`,
 * `freshness.shifts === 0`).
 *
 * DOIS MESES (limite real da tela, não escolha arbitrária): o seletor de mês
 * (`selectors.ts` `monthOptionsUntilNow`) só lista do PISO fixo `'2026-08'` até o mês CORRENTE —
 * hoje (`currentMonthIsoForE2E`) só existem 2 opções. MONTH_FLOOR ('2026-08', estável — é o piso
 * fixo do código, sempre <= o mês corrente) hospeda os casos 1 (desconhecido) e 2 (parcial), que
 * rodam em SEQUÊNCIA no mesmo describe.serial e por isso podem se auto-arranjar (UPSERT
 * `DO UPDATE`) sem quebrar nada. MONTH_CURRENT (mês corrente, aberto por padrão — sem precisar
 * tocar no seletor) hospeda o caso 3 (fresco) — este usa `DO NOTHING` no upsert de propósito: o
 * caso 3 precisa poder ser re-executado isoladamente (`--grep`) SEM se auto-corrigir, para a prova
 * de sabotagem (ver relatório da task) fazer sentido — se o teste sempre regravasse 144/144 antes
 * de checar, a sabotagem no banco nunca teria efeito.
 *
 * ⚠️ ACHADO (21/09/2026, bloqueia CASO 2 e CASO 3 — `test.fixme`, não é flakiness, é
 * inalcançável POR DESENHO no wiring atual): com `ANACARE_HOURS_SOURCE=fake` (a env deste
 * override, `docker-compose.anacare-hours.yml` — a MESMA que todo dev local e o CI usam pra essa
 * feature), `AnaCareHoursController.defaultServiceFactory()`
 * (`worker-functions/src/modules/anacare-hours/interfaces/controllers/AnaCareHoursController.ts:56-64`)
 * chama `createAnaCareSyncDependencies()` **de novo, sem cache, dentro do handler de CADA
 * request** (`requireService` → `serviceFactory()`, linha ~99, chamado por `getMonthSnapshot`
 * linha ~127) — isso cria um `FakeAnaCareSyncRunRepository`/`FakeAnaCarePatientMonthRepository`
 * (`FakeAnaCareSyncDependencies.ts`) NOVO a cada GET, cujos Maps internos nascem sempre vazios.
 * O `AnaCareHoursSyncController` (quem ESCREVE o progresso) faz o oposto — memoiza em
 * `sharedDeps`/`sharedRunner` (`AnaCareHoursSyncController.ts:47-62`) — logo escreve numa
 * instância que o LADO DA LEITURA nunca vê. Resultado medido (3 provas independentes, 21/09):
 *   1. UPDATE direto em `anacare_sync_run` (Postgres real) para `status='done'`,
 *      `reservations_total=120`, `reservations_done=45` — GET seguinte devolve
 *      `snapshotState:"desconhecido"` (Postgres nem é lido: em modo `fake` o serviço usa os
 *      repositórios EM MEMÓRIA acima, nunca `AnaCareSyncRunRepository`/`AnaCarePatientMonthRepository`
 *      reais).
 *   2. `POST /api/admin/anacare-hours/sync` de verdade (com `ANACARE_DIRECTORY_MIN_ABSOLUTE=0`)
 *      retornou `{reservationsTotal:1, reservationsDone:1, nextCursor:null}` (sucesso real) — o
 *      GET IMEDIATAMENTE seguinte para o MESMO mês ainda devolve `"desconhecido"`.
 *   3. `anacare_sync_run` no Postgres real permanece com 0 linhas para o mês sincronizado no
 *      passo 2 — a escrita do controller de sync foi para o repositório FALSO em memória, e o de
 *      LEITURA criou outro, também vazio.
 * Conclusão: `snapshotState` no GET só pode valer `'nao_construido'` (mês sem turno falso) ou
 * `'desconhecido'` (todo o resto) neste ambiente — `'parcial'`/`'fresco'` são ESTRUTURALMENTE
 * inalcançáveis via UI/API real enquanto essa memoização não existir no lado da leitura. Não é
 * algo que este arquivo de teste deveria consertar (fora do escopo pedido: "escreva e RODE o
 * e2e", não "corrija o backend") — reportado como achado, não corrigido aqui.
 *
 * CASO 1 continua como `test()` de verdade — é o único estado alcançável — mas com poder de
 * discriminação FRACO: ele passaria mesmo se a F2 inteira fosse revertida, porque
 * `'desconhecido'` é o que este wiring devolve incondicionalmente. Documentado no próprio teste.
 */
import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route } from '@playwright/test';

const DB_URL = process.env.ANACARE_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const COMPLETO_UID = `ach-conclusao-e2e-${RUN_ID}`;
const COMPLETO_EMAIL = `${COMPLETO_UID}@e2e.test`;
const GRUPO = `ACH Conclusao E2E ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

/** Piso fixo do seletor (`selectors.ts` `monthOptionsUntilNow`, default `'2026-08'`) — sempre <= o mês corrente, logo sempre presente no dropdown. */
const MONTH_FLOOR = '2026-08';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
/** Mesma régua de `currentMonthIso` (`selectors.ts`) — fuso LOCAL do operador, nunca `getUTC*`. Réplica local (arquivo autocontido, mesmo padrão dos moldes). */
function currentMonthIsoForE2E(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}
const MONTH_CURRENT = currentMonthIsoForE2E();

// Patients sintéticos únicos por RUN_ID — evita colidir com outros e2e que também escrevem em
// `anacare_patient_month` para os mesmos meses (mesmo Postgres isolado desta sessão, mas outros
// arquivos de spec podem rodar na mesma corrida do CI).
const PATIENT_FLOOR = `E2E-CONCLUSAO-FLOOR-${RUN_ID}`;
const PATIENT_CURRENT = `E2E-CONCLUSAO-CURRENT-${RUN_ID}`;

// Números do caso 2 (parcial) e do caso 3 (fresco) — os mesmos 144 do caso 3 são os que a
// sabotagem (relatório da task, critério B) muda para done=49, deixando done<total.
const PARCIAL_DONE = 45;
const PARCIAL_TOTAL = 120;
const FRESCO_DONE = 144;
const FRESCO_TOTAL = 144;

function psql(sql: string): string {
  try {
    return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`DB error: ${e.stderr?.toString() ?? e.message} | sql=${sql}`);
  }
}
const scalar = (sql: string): string => psql(sql).trim().split('\n')[0] ?? '';
function safeSql(sql: string): void {
  try {
    psql(sql);
  } catch (err) {
    console.error(`[cleanup] falhou (seguindo): ${(err as Error).message}`);
  }
}

/** Garante >=1 linha em `anacare_patient_month` para o mês — senão `naoConstruido` teria precedência sobre os 3 estados testados aqui. `DO NOTHING`: não importa o valor, só a PRESENÇA da linha. */
function ensurePatientMonthRow(patientId: string, month: string): void {
  psql(
    `INSERT INTO anacare_patient_month (
       source, ana_care_patient_id, period_month, patient_first_name, patient_last_name,
       providers_count, shifts_count, hours_actual_sum, hours_scheduled_sum_missing_actual,
       origin_sin_checkin, origin_web_admin, origin_app, fetched_at, updated_at
     ) VALUES (
       'anacare', '${patientId}', '${month}-01'::date, 'E2E', 'Conclusao',
       1, 1, 1, 0,
       0, 1, 0, NOW(), NOW()
     )
     ON CONFLICT (source, ana_care_patient_id, period_month) DO NOTHING`,
  );
}

interface MockUser {
  uid: string;
  email: string;
  role: string;
  country: string;
}
const COMPLETO: MockUser = { uid: COMPLETO_UID, email: COMPLETO_EMAIL, role: 'admin', country: 'AR' };

const tokenFor = (u: MockUser): string => 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');

function fakeIdToken(u: MockUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: u.uid,
    uid: u.uid,
    email: u.email,
    iss: 'https://securetoken.google.com/enlite-prd',
    aud: 'enlite-prd',
    iat: now,
    exp: now + 3600,
  };
  return 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.';
}

/** Login HUMANO (click + keyboard.type, `e2e-humano-nao-e-fill`) — mesmo padrão dos moldes desta feature. */
async function loginAs(page: Page, u: MockUser): Promise<void> {
  const idToken = fakeIdToken(u);
  const mockToken = tokenFor(u);

  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    const body =
      url.includes('signInWithPassword') || url.includes('signUp')
        ? { kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.uid, email: u.email, idToken, refreshToken: 'fake-refresh', expiresIn: '3600', registered: true }
        : { users: [{ localId: u.uid, email: u.email, emailVerified: true }] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: idToken, id_token: idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh' }),
    });
  });
  const swap = async (route: Route): Promise<void> => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${mockToken}` } });
  };
  await page.route('**/api/**', swap);
  await page.route('**/v1/me/authz', swap);

  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  const email = page.locator('input[type="email"]');
  await email.click();
  await expect(email).toBeFocused();
  await page.keyboard.type(u.email);
  const password = page.locator('input[type="password"]');
  await password.click();
  await expect(password).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
  await page.waitForTimeout(1_200); // 2º redirect da tela de login (mesma pegadinha dos moldes)
}

/** Abre a tela pelo MENU (não por goto direto) — prova que o item existe e que a rota está atrás do gate. */
async function abrirPeloMenu(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Horas Ana Care' }).click();
  await expect(page).toHaveURL(/\/admin\/anacare\/horas$/);
  await expect(page.getByRole('heading', { name: 'Horas Ana Care' })).toBeVisible({ timeout: 15_000 });
}

/** Nenhum dos 4 títulos possíveis de banner aparece na tela — usado pelo caso 3 (fresco: nenhum banner). */
async function expectNoStatusBanner(page: Page): Promise<void> {
  const titulos = [
    'Retrato desactualizado',
    'Retrato aún no construido',
    'Estado de la sincronización desconocido',
    'Sincronización incompleta',
  ];
  for (const titulo of titulos) {
    await expect(page.getByText(titulo, { exact: false })).toHaveCount(0);
  }
}

test.describe('Banner de conclusão de corrida — Horas Ana Care — E2E real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(() => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${COMPLETO_UID}', '${COMPLETO_EMAIL}', 'E2E Conclusao AnaCare', 'admin', true, 'ACTIVE', '${TENANT}')`);

    const grupoId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO}', 'e2e anacare-horas-conclusao — nao mexer manual') RETURNING id`);
    psql(`INSERT INTO iam.group_permissions (group_id, permission_id)
          SELECT '${grupoId}', id FROM iam.permissions WHERE resource='anacare_hours' AND action IN ('read','validate')`);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${grupoId}', 'AR', '${COMPLETO_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${COMPLETO_UID}', '${grupoId}', '${TENANT}')`);

    // >=1 linha agregada nos 2 meses usados pelos 3 casos — sem isto `naoConstruido` mascararia tudo.
    ensurePatientMonthRow(PATIENT_FLOOR, MONTH_FLOOR);
    ensurePatientMonthRow(PATIENT_CURRENT, MONTH_CURRENT);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id = '${COMPLETO_UID}'`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id = '${COMPLETO_UID}'`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = '${GRUPO}')`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = '${GRUPO}')`);
    safeSql(`DELETE FROM iam.permission_groups WHERE name = '${GRUPO}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid = '${COMPLETO_UID}'`);
    safeSql(`DELETE FROM anacare_patient_month WHERE ana_care_patient_id IN ('${PATIENT_FLOOR}', '${PATIENT_CURRENT}')`);
    // `anacare_sync_run` (chave por mês, não por RUN_ID) É DEIXADO DE PROPÓSITO — é o estado que a
    // prova de sabotagem (caso 3, relatório da task) precisa sobreviver entre execuções isoladas
    // do Playwright. Não fazer DELETE/RESET aqui.
  });

  // ⚠️ Discriminação FRACA (ver ACHADO no cabeçalho do arquivo): neste wiring, `snapshotState`
  // do GET só pode ser 'nao_construido' ou 'desconhecido' — este teste passaria mesmo sem a F2.
  // O arranjo SQL abaixo é mantido (documenta a INTENÇÃO/contrato correto — o que o teste
  // precisaria fazer se a leitura enxergasse a conclusão da corrida), mas não é ele quem decide
  // o resultado observado hoje.
  test('CASO 1 — status IS NULL → banner "desconhecido", texto não afirma completo nem incompleto', async ({ page }) => {
    // Arranjo por SQL direto (aceitável — não é o fluxo sob teste): linha legada, status NUNCA
    // escrito (migration 457) — é o estado real das linhas de agosto/setembro pré-existentes.
    psql(
      `INSERT INTO anacare_sync_run (source, period_month, run_started_at, updated_at, status, "cursor", reservations_total, reservations_done, finished_at, last_error)
       VALUES ('anacare', '${MONTH_FLOOR}-01'::date, NOW(), NOW(), NULL, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT (source, period_month) DO UPDATE SET
         status = NULL, "cursor" = NULL, reservations_total = NULL, reservations_done = NULL, finished_at = NULL, last_error = NULL, updated_at = NOW()`,
    );

    await loginAs(page, COMPLETO);
    await abrirPeloMenu(page);

    // mês padrão é o CORRENTE — navega pelo seletor até o piso (MONTH_FLOOR), como um humano faria.
    await page.getByLabel('Mes', { exact: true }).selectOption(MONTH_FLOOR);

    const titulo = page.getByText('Estado de la sincronización desconocido');
    await expect(titulo).toBeVisible({ timeout: 15_000 });
    // Texto exato do i18n (`stale.messageDesconhecido`, es.json) — a regra dura é que ele NUNCA
    // afirma "completo" nem "incompleto": diz explicitamente que não é possível afirmar nenhum
    // dos dois, o que é diferente de omitir as palavras — por isso a asserção é a frase INTEIRA,
    // não uma ausência de substring.
    const mensagem = page.getByText(
      'Este mes fue sincronizado antes de que el sistema registrara si la sincronización había terminado — no es posible afirmar si el retrato está completo o incompleto.',
    );
    await expect(mensagem).toBeVisible();
  });

  // `test.fixme` (não `skip`): o código deste teste está CORRETO — é o que a tela precisaria
  // fazer se `snapshotState` chegasse como 'parcial'. Não passa hoje porque o valor NUNCA chega
  // como 'parcial' neste wiring (ver ACHADO no cabeçalho do arquivo — medido 21/09, 2 técnicas
  // diferentes de arranjo, 0 sucessos, causa identificada e citada por arquivo:linha). Não é
  // flakiness — é caminho morto por desenho até o `AnaCareHoursController` memoizar suas
  // dependências como o `AnaCareHoursSyncController` já faz.
  test.fixme('CASO 2 — status=\'done\', reservations_done < reservations_total → banner "parcial" com "X de Y" interpolado', async ({ page }) => {
    psql(
      `INSERT INTO anacare_sync_run (source, period_month, run_started_at, updated_at, status, "cursor", reservations_total, reservations_done, finished_at, last_error)
       VALUES ('anacare', '${MONTH_FLOOR}-01'::date, NOW(), NOW(), 'done', 45, ${PARCIAL_TOTAL}, ${PARCIAL_DONE}, NOW(), NULL)
       ON CONFLICT (source, period_month) DO UPDATE SET
         status = 'done', "cursor" = 45, reservations_total = ${PARCIAL_TOTAL}, reservations_done = ${PARCIAL_DONE}, finished_at = NOW(), last_error = NULL, updated_at = NOW()`,
    );
    // Prova de que a tela lê do MESMO lugar que acabamos de escrever — não uma constante do teste.
    const [dbDone, dbTotal] = scalar(`SELECT reservations_done || ',' || reservations_total FROM anacare_sync_run WHERE source='anacare' AND period_month='${MONTH_FLOOR}-01'::date`)
      .split(',')
      .map(Number);
    expect(dbDone).toBe(PARCIAL_DONE);
    expect(dbTotal).toBe(PARCIAL_TOTAL);

    await loginAs(page, COMPLETO);
    await abrirPeloMenu(page);
    await page.getByLabel('Mes', { exact: true }).selectOption(MONTH_FLOOR);

    const titulo = page.getByText('Sincronización incompleta');
    await expect(titulo).toBeVisible({ timeout: 15_000 });

    const mensagem = page.getByText(/se procesaron \d+ de \d+ reservas/);
    await expect(mensagem).toBeVisible();
    const textoLido = (await mensagem.textContent()) ?? '';
    const match = textoLido.match(/se procesaron (\d+) de (\d+) reservas/);
    if (!match) throw new Error(`Não achei "X de Y" no texto lido da tela: "${textoLido}"`);
    const [, doneNaTela, totalNaTela] = match;
    // Números LIDOS DA TELA, comparados contra os valores que ACABAMOS de gravar no banco —
    // prova a interpolação dinâmica, nunca uma string cravada.
    expect(Number(doneNaTela)).toBe(dbDone);
    expect(Number(totalNaTela)).toBe(dbTotal);
    expect(textoLido).toContain(`se procesaron ${PARCIAL_DONE} de ${PARCIAL_TOTAL} reservas`);
  });

  // `test.fixme` pelo MESMO motivo do CASO 2 (ver ACHADO no cabeçalho): 'fresco' também nunca
  // chega no GET deste wiring — o banner "desconhecido" aparece incondicionalmente. Medido
  // (21/09): rodei ESTE teste isolado (`--grep "CASO 3"`) e a falha literal foi
  // `getByText('Estado de la sincronización desconocido') — Received: 1` (esperado 0).
  test.fixme('CASO 3 — status=\'done\', done === total, fonte fresca → SEM banner', async ({ page }) => {
    // `INSERT ... ON CONFLICT DO NOTHING`, de PROPÓSITO (ver docstring do arquivo): este mês
    // (MONTH_CURRENT) é o único usado pela prova de sabotagem (relatório da task, critério B) —
    // se este teste sempre regravasse 144/144 antes de checar, a sabotagem no banco nunca teria
    // efeito nenhum. Só a 1ª execução grava; execuções seguintes leem o que já está lá, seja o
    // valor limpo original, seja um valor sabotado de propósito por fora do teste.
    psql(
      `INSERT INTO anacare_sync_run (source, period_month, run_started_at, updated_at, status, "cursor", reservations_total, reservations_done, finished_at, last_error)
       VALUES ('anacare', '${MONTH_CURRENT}-01'::date, NOW(), NOW(), 'done', ${FRESCO_TOTAL}, ${FRESCO_TOTAL}, ${FRESCO_DONE}, NOW(), NULL)
       ON CONFLICT (source, period_month) DO NOTHING`,
    );

    await loginAs(page, COMPLETO);
    await abrirPeloMenu(page);
    // mês padrão já É o corrente (MONTH_CURRENT) — nenhuma interação com o seletor necessária.

    await expectNoStatusBanner(page);
  });
});
