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
 * ⚠️ ACHADO HISTÓRICO (21/09/2026, RESOLVIDO por troca de override — ver abaixo, não por código):
 * com `ANACARE_HOURS_SOURCE=fake` (o valor do override `docker-compose.anacare-hours.yml`),
 * `AnaCareHoursController.defaultServiceFactory()`
 * (`worker-functions/src/modules/anacare-hours/interfaces/controllers/AnaCareHoursController.ts:56-64`)
 * chama `createAnaCareSyncDependencies()` sem cache dentro do handler de CADA request, criando um
 * `FakeAnaCareSyncRunRepository`/`FakeAnaCarePatientMonthRepository` (`FakeAnaCareSyncDependencies.ts`)
 * NOVO a cada GET — os Maps nascem sempre vazios, então nem uma escrita direta em `anacare_sync_run`
 * (Postgres real) nem um `POST /anacare-hours/sync` de verdade (sucesso real, medido) mudam o que
 * o GET devolve: `snapshotState` fica travado em `'desconhecido'`. Isso é exclusivo do modo `fake`
 * (`FakeAnaCareSyncRunRepository`/`FakeAnaCarePatientMonthRepository` guardam estado em memória por
 * INSTÂNCIA; recriar a instância a cada request descarta esse estado). Segue como achado de
 * produto (ver "Achados fora do escopo" no relatório da task) — não corrigido aqui.
 *
 * SOLUÇÃO DE TESTE (decisão do orquestrador, 21/09): trocar `ANACARE_HOURS_SOURCE=real` só para
 * este e2e, via `worker-functions/docker-compose.anacare-hours-real-sem-rede.yml`. Em modo `real`,
 * `patientMonthRepository`/`syncRunRepository` são `AnaCarePatientMonthRepository`/
 * `AnaCareSyncRunRepository` — wrappers SEM ESTADO PRÓPRIO em volta do pool do Postgres
 * (`DatabaseConnection.getInstance().getPool()`, singleton) — recriar o wrapper a cada request é
 * inócuo, porque o dado mora no banco, não no objeto. `source`/`AnaCareShiftsSourceReal` também
 * fica real, mas o GET da LISTA nunca chama rede por ele: `getMonthSnapshot` só usa
 * `this.source.getRetratoStatus()`, que em `AnaCareShiftsSourceReal.getRetratoStatus()`
 * (`AnaCareShiftsSourceReal.ts:37-41`) é `{ stale: false, circuitBreakerOpen: this.client.
 * circuitBreakerOpen }` — um GETTER local (`AnaCareSessionClient.ts:325-327`, `this.rateLimiter.
 * isOpen`), nenhum `fetch`. Prova (colada no relatório da task): `AnaCareSessionClient` construído
 * com `ANACARE_BASE_URL=https://anacare-e2e-nunca-resolve.invalid` (domínio RFC 2606, nunca
 * resolve) + credenciais dummy não-vazias; `GET /anacare-hours/months/2026-08` com um
 * `anacare_sync_run` real semeado `done=49/total=144` respondeu em 0.076s com
 * `snapshotState:"parcial", reservationsTotal:144, reservationsDone:49` — nem hang de DNS nem
 * timeout, e os números vieram exatamente do que a SQL gravou.
 *
 * RETOMADA 4 (21/09/2026) — 2 lacunas que o gate `revisao-pr` (modo fecho) apontou:
 *
 * (1) TELA DE DETALHE (casos 4/5) — `AnaCareHoursDetailPage`/`useAnaCareHoursPatient` mostram o
 * MESMO banner (via `getRetratoStatus`, que é o MESMO GET `/months/:month` da lista — só extrai o
 * retrato, ignora `patients`) — mas o DETALHE também chama `service.getPatientMonth(month,
 * patientId)` em paralelo (`Promise.all`), e ESTE, ao contrário do retrato, SEMPRE bate rede em
 * modo `real` (`AnaCareHoursService.getPatientMonth:262-274` → `source.listShifts` →
 * `AnaCareShiftsSourceReal.listShifts` → `AnaCareSessionClient.listShifts`, sem try/catch em volta
 * — uma rede indisponível faz `Promise.all` rejeitar, e a tela cai no estado de ERRO genérico,
 * nunca no banner). Com o host `.invalid` do override anterior, a tela de detalhe NUNCA carrega —
 * por isso troquei `docker-compose.anacare-hours-real-sem-rede.yml` (host inalcançável) por
 * `docker-compose.anacare-hours-real-stub-local.yml` (host ALCANÇÁVEL, um stub HTTP local — ver
 * `startAnaCareStub` abaixo, mesmo precedente de `tests/e2e/helpers/periskopeStubServer.ts`/
 * `axonicoStubServer.ts`, porta 9913). O stub cobre login + `/api/shifts/` (1 turno sintético,
 * sem PII) — o bastante pra `getPatientMonth` resolver — e devolve 404 pra tudo mais, inclusive
 * `/admin/accounts/` (o diretório HTML que só o SYNC RUNNER usa).
 *
 * (2) CAMINHO DE ESCRITA REAL (caso 6) — até aqui nenhum teste disparava
 * `AnaCareSyncRunRepository.recordProgress` (`AnaCareSyncRunRepository.ts:60-61`) contra Postgres
 * de verdade; só escrevíamos via SQL direto. O caso 6 clica em "Sincronizar" de verdade — como o
 * stub NÃO implementa `/admin/accounts/`, `AnaCareEnliteDirectory.fetch()` recebe 404 →
 * `AnaCareHttpError` → propaga até `AnaCareHoursSyncRunner.run()` → `AnaCareHoursSyncController.
 * trigger` (`:152-160,199-206`) captura e grava `status:'failed'` + `lastError:
 * toStableErrorCode(e)`. Conferido contra `AnaCareSyncErrorCode.ts`: `AnaCareHttpError` não está
 * na lista de classes conhecidas (só `AnaCarePatientMonthCollisionError`), então cai no fallback
 * — o código gravado é `UnknownError:AnaCareHttpError` (nome da CLASSE, nunca `.message`, regra
 * dura da 457). `reservationsTotal`/`reservationsDone` NÃO viram `NULL` — medido, contra a minha
 * própria suposição inicial errada: `AnaCareSyncRunRepository.recordProgress` usa `COALESCE($3,
 * reservations_total)`/`COALESCE($4, reservations_done)` (`AnaCareSyncRunRepository.ts:60-79`) —
 * passar `null` nesses dois campos PRESERVA o último valor conhecido, nunca apaga (comentário do
 * próprio arquivo: "é assim que uma falha grava status='failed' sem apagar o último cursor/
 * contagem conhecidos"). Por isso o caso 6 semeia um baseline PRÓPRIO (200/88, números que não
 * coincidem com nenhum outro caso deste arquivo, de propósito) ANTES de sincronizar, e depois da
 * falha confere que 200/88 SOBREVIVEM intactos — é essa preservação, não um apagamento, que o
 * teste prova. `finished_at` é preenchido (`new Date()`, gravado pelo controller no `catch`). A
 * tela, recarregada, mostra `status==='failed'` → `computeSnapshotState` (precedência) →
 * `'parcial'` (mesmo ramo do caso 2) — e COM contagem preservada (`temContagemDaCorrida` é
 * verdadeiro), o texto é o INTERPOLADO ("se procesaron 88 de 200 reservas"), não o genérico.
 *
 * (3) CASO 3 (estabilidade) — trocado de `ON CONFLICT DO NOTHING` para `DO UPDATE`: o gate
 * apontou que "depender do que já está no banco" é não-determinístico (uma execução após
 * sabotagem manual — ou uma execução num Postgres reaproveitado com lixo de sessão anterior —
 * herdaria estado errado sem avisar). Trade-off explícito: isso DESFAZ a propriedade de
 * "sobrevive à sabotagem entre execuções isoladas" que o caso 3 tinha na retomada 3 (a prova de
 * sabotagem já foi feita e colada no relatório daquela retomada; não é objetivo desta retomada
 * mantê-la reproduzível ad-hoc) — o caso agora SEMPRE regrava 144/144 no início do próprio corpo,
 * como os casos 1/2 já faziam para seus meses.
 */
import { execFileSync } from 'child_process';
import * as http from 'http';
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
// Caso 5 (detalhe, parcial) — mesma dupla de números usada na prova de sabotagem da retomada 3
// (done=49/total=144), por continuidade — não há relação funcional obrigatória, só familiaridade.
const DETALHE_PARCIAL_DONE = 49;
const DETALHE_PARCIAL_TOTAL = 144;
// Caso 6 (sync real, falha) — baseline PRÓPRIO, deliberadamente distinto de qualquer outro par
// deste arquivo, para a asserção de que `recordProgress` PRESERVA (COALESCE) e não apaga não
// poder ser confundida com sobra de outro caso.
const SYNC_FALHA_BASELINE_DONE = 88;
const SYNC_FALHA_BASELINE_TOTAL = 200;

/** Porta do stub local do Ana Care — próxima a 9911 (Periskope)/9912 (Axonico), mesmo precedente (`docker-compose.test.yml`). */
const ANACARE_STUB_PORT = 9913;

interface AnaCareStub {
  server: http.Server;
  /** Caminhos batidos no stub — prova de que o tráfego ficou LOCAL, nunca saiu pro host real. */
  requestsLog: string[];
  close: () => Promise<void>;
}

/**
 * Stub HTTP local do Ana Care (login por cookie Django + `/api/shifts/`) — só existe porque
 * `AnaCareHoursService.getPatientMonth` (tela de DETALHE) SEMPRE chama rede em modo `real` (ver
 * docstring do arquivo, RETOMADA 4 item 1). Cobre o mínimo pra `AnaCareSessionClient` logar e
 * listar turnos: devolve 1 turno sintético por paciente pedido (nome "E2E"/"Stub", sem PII),
 * ECOANDO o `patient` da query — funciona pra qualquer paciente que o teste escolher, sem
 * ramificação por caso. Devolve 404 pra tudo mais, inclusive `/admin/accounts/` (o diretório HTML
 * que só o SYNC RUNNER usa) — de propósito, é o que faz o caso 6 (Sincronizar) falhar de forma
 * controlada e observável, mesmo precedente de `tests/e2e/helpers/periskopeStubServer.ts`/
 * `axonicoStubServer.ts` (stub local, nunca o serviço real).
 */
function startAnaCareStub(port: number): Promise<AnaCareStub> {
  const requestsLog: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      requestsLog.push(`${req.method} ${url.pathname}`);

      if (req.method === 'GET' && url.pathname === '/users/admin/login/') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'csrftoken=e2e-stub-csrf' });
        res.end('<html></html>');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/users/admin/login/') {
        req.resume(); // drena o corpo (form urlencoded) — não usamos o conteúdo, só precisamos consumir o stream.
        req.on('end', () => {
          res.writeHead(302, { 'Set-Cookie': 'sessionid=e2e-stub-session', Location: '/admin/' });
          res.end();
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/shifts/') {
        const patientId = url.searchParams.get('patient') ?? 'E2E-STUB-SEM-PATIENT-ID';
        const minDate = url.searchParams.get('min_date') ?? `${MONTH_CURRENT}-01`;
        const start = `${minDate}T13:00:00-06:00`;
        const end = `${minDate}T17:00:00-06:00`;
        const raw = {
          id: `E2E-STUB-SHIFT-${patientId}`,
          start,
          end,
          checkin: start,
          checkout: end,
          checkin_source: 'web_admin',
          checkout_source: 'web_admin',
          checkin_delay: null,
          duration: 4,
          is_finalized: true,
          month: minDate.slice(0, 7),
          patient: {
            id: patientId,
            agency: 116,
            identification_type: null,
            identification_number: null,
            first_name: 'E2E',
            last_name: 'Stub',
            surname: 'Stub',
          },
          nurse: { id: 'E2E-STUB-NURSE-1', agency: 116, first_name: 'Enfermera', last_name: 'Stub', surname: 'Stub' },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 1, next: null, previous: null, results: [raw] }));
        return;
      }

      // Qualquer outra rota (inclusive `/admin/accounts/`, o diretório do SYNC) — 404 DE
      // PROPÓSITO, ver docstring da função.
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('stub: rota nao implementada');
    });
    server.listen(port, '0.0.0.0', () => {
      resolve({
        server,
        requestsLog,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let anaCareStub: AnaCareStub | null = null;

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

  test.beforeAll(async () => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${COMPLETO_UID}', '${COMPLETO_EMAIL}', 'E2E Conclusao AnaCare', 'admin', true, 'ACTIVE', '${TENANT}')`);

    const grupoId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO}', 'e2e anacare-horas-conclusao — nao mexer manual') RETURNING id`);
    psql(`INSERT INTO iam.group_permissions (group_id, permission_id)
          SELECT '${grupoId}', id FROM iam.permissions WHERE resource='anacare_hours' AND action IN ('read','validate')`);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${grupoId}', 'AR', '${COMPLETO_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${COMPLETO_UID}', '${grupoId}', '${TENANT}')`);

    // >=1 linha agregada nos 2 meses usados pelos casos — sem isto `naoConstruido` mascararia tudo.
    ensurePatientMonthRow(PATIENT_FLOOR, MONTH_FLOOR);
    ensurePatientMonthRow(PATIENT_CURRENT, MONTH_CURRENT);

    // Stub do Ana Care (retomada 4, item 1) — precisa estar de pé ANTES dos casos 4/5 (detalhe) e
    // 6 (sync). A API (container Docker) já tem que ter sido recriada com
    // `docker-compose.anacare-hours-real-stub-local.yml` (ANACARE_BASE_URL apontando pra esta
    // porta) ANTES de rodar `npx playwright test` — isto aqui só sobe o SERVIDOR, não muda env do
    // container (feito manualmente pelo orquestrador, ver relatório da task).
    anaCareStub = await startAnaCareStub(ANACARE_STUB_PORT);
  });

  test.afterAll(async () => {
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id = '${COMPLETO_UID}'`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id = '${COMPLETO_UID}'`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = '${GRUPO}')`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = '${GRUPO}')`);
    safeSql(`DELETE FROM iam.permission_groups WHERE name = '${GRUPO}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid = '${COMPLETO_UID}'`);
    safeSql(`DELETE FROM anacare_patient_month WHERE ana_care_patient_id IN ('${PATIENT_FLOOR}', '${PATIENT_CURRENT}')`);
    // `anacare_sync_run` (chave por mês, não por RUN_ID) É DEIXADO DE PROPÓSITO — cada caso que o
    // usa regrava seu próprio estado no início do corpo (retomada 4, item 3: determinístico agora,
    // nenhum caso depende do que sobrou de uma execução anterior). Não fazer DELETE/RESET aqui.
    if (anaCareStub) {
      console.log(`[anacare-stub] rotas batidas nesta corrida: ${JSON.stringify(anaCareStub.requestsLog)}`);
      await anaCareStub.close();
      anaCareStub = null;
    }
  });

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
    // Espera o fetch do mês novo terminar (`isLoadingSelectedMonth`, `AnaCareHoursListPage.tsx`)
    // — sem isto o banner pode ainda estar mostrando o snapshot do mês ANTERIOR (o corrente,
    // default) no instante da leitura (achado desta retomada, medido no caso 2 — mesma classe de
    // corrida, aqui inofensiva porque os 2 meses concordam em "desconhecido", mas o padrão vale
    // pros dois casos).
    await expect(page.getByTestId('anacare-hours-list-loading-month')).toHaveCount(0, { timeout: 15_000 });

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

  test('CASO 2 — status=\'done\', reservations_done < reservations_total → banner "parcial" com "X de Y" interpolado', async ({ page }) => {
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
    // Espera o fetch do mês novo terminar ANTES de ler o banner — achado desta retomada: sem
    // isto, o teste podia ler o banner do mês CORRENTE (default, ainda em memória por um
    // instante) em vez do MONTH_FLOOR recém-selecionado. Medido: `Received: 49` (número do mês
    // corrente) onde se esperava `45` (MONTH_FLOOR) — corrida real, não flakiness de rede.
    await expect(page.getByTestId('anacare-hours-list-loading-month')).toHaveCount(0, { timeout: 15_000 });

    const titulo = page.getByText('Sincronización incompleta');
    await expect(titulo).toBeVisible({ timeout: 15_000 });

    // `getByText` com os números ESPERADOS (lidos do banco ACIMA, nunca uma constante cravada) —
    // o `toBeVisible` do Playwright faz polling até o DOM mostrar ESSE texto exato, o que também
    // fecha a corrida de vez (não aceita um valor antigo só porque "tem número ali").
    const mensagem = page.getByText(`se procesaron ${dbDone} de ${dbTotal} reservas`, { exact: false });
    await expect(mensagem).toBeVisible({ timeout: 15_000 });
    const textoLido = (await mensagem.textContent()) ?? '';
    expect(textoLido).toContain(`se procesaron ${PARCIAL_DONE} de ${PARCIAL_TOTAL} reservas`);
  });

  test('CASO 3 — status=\'done\', done === total, fonte fresca → SEM banner', async ({ page }) => {
    // Retomada 4, item 3: `DO UPDATE` — determinístico, sempre regrava 144/144 no início do
    // corpo (mesmo padrão dos casos 1/2 para seus meses). Ver docstring do arquivo (trade-off:
    // isto derruba a sobrevivência a sabotagem entre execuções isoladas que este caso tinha antes
    // — a prova de sabotagem já foi feita e colada no relatório da retomada 3).
    psql(
      `INSERT INTO anacare_sync_run (source, period_month, run_started_at, updated_at, status, "cursor", reservations_total, reservations_done, finished_at, last_error)
       VALUES ('anacare', '${MONTH_CURRENT}-01'::date, NOW(), NOW(), 'done', ${FRESCO_TOTAL}, ${FRESCO_TOTAL}, ${FRESCO_DONE}, NOW(), NULL)
       ON CONFLICT (source, period_month) DO UPDATE SET
         status = 'done', "cursor" = ${FRESCO_TOTAL}, reservations_total = ${FRESCO_TOTAL}, reservations_done = ${FRESCO_DONE},
         finished_at = NOW(), last_error = NULL, updated_at = NOW()`,
    );

    await loginAs(page, COMPLETO);
    await abrirPeloMenu(page);
    // mês padrão já É o corrente (MONTH_CURRENT) — nenhuma interação com o seletor necessária.

    await expectNoStatusBanner(page);
  });

  test('CASO 4 — DETALHE do paciente, status IS NULL → banner "desconhecido" (mesmo texto da lista)', async ({ page }) => {
    // Mesmo mês do caso 3 (MONTH_CURRENT) — o detalhe SEMPRE abre no mês corrente
    // (`AnaCareHoursPatientPage.tsx`, `currentMonthIso()`, nunca o mês selecionado na lista).
    psql(
      `INSERT INTO anacare_sync_run (source, period_month, run_started_at, updated_at, status, "cursor", reservations_total, reservations_done, finished_at, last_error)
       VALUES ('anacare', '${MONTH_CURRENT}-01'::date, NOW(), NOW(), NULL, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT (source, period_month) DO UPDATE SET
         status = NULL, "cursor" = NULL, reservations_total = NULL, reservations_done = NULL, finished_at = NULL, last_error = NULL, updated_at = NOW()`,
    );

    await loginAs(page, COMPLETO);
    await abrirPeloMenu(page);
    // mês padrão da LISTA já é o corrente — clica no paciente sintético (o mesmo que o caso 3 usa
    // para a lista) para abrir o DETALHE, como um humano faria.
    const linha = page.getByTestId(`anacare-hours-patient-row-${PATIENT_CURRENT}`);
    await expect(linha).toBeVisible({ timeout: 15_000 });
    await linha.click();
    await expect(page).toHaveURL(new RegExp(`/admin/anacare/horas/${PATIENT_CURRENT}$`));

    const titulo = page.getByText('Estado de la sincronización desconocido');
    await expect(titulo).toBeVisible({ timeout: 15_000 });
    const mensagem = page.getByText(
      'Este mes fue sincronizado antes de que el sistema registrara si la sincronización había terminado — no es posible afirmar si el retrato está completo o incompleto.',
    );
    await expect(mensagem).toBeVisible();
  });

  test('CASO 5 — DETALHE do paciente, status=\'done\' done=49/total=144 → banner "parcial" com "49 de 144"', async ({ page }) => {
    psql(
      `INSERT INTO anacare_sync_run (source, period_month, run_started_at, updated_at, status, "cursor", reservations_total, reservations_done, finished_at, last_error)
       VALUES ('anacare', '${MONTH_CURRENT}-01'::date, NOW(), NOW(), 'done', ${DETALHE_PARCIAL_DONE}, ${DETALHE_PARCIAL_TOTAL}, ${DETALHE_PARCIAL_DONE}, NOW(), NULL)
       ON CONFLICT (source, period_month) DO UPDATE SET
         status = 'done', "cursor" = ${DETALHE_PARCIAL_DONE}, reservations_total = ${DETALHE_PARCIAL_TOTAL}, reservations_done = ${DETALHE_PARCIAL_DONE},
         finished_at = NOW(), last_error = NULL, updated_at = NOW()`,
    );
    const [dbDone, dbTotal] = scalar(
      `SELECT reservations_done || ',' || reservations_total FROM anacare_sync_run WHERE source='anacare' AND period_month='${MONTH_CURRENT}-01'::date`,
    )
      .split(',')
      .map(Number);
    expect(dbDone).toBe(DETALHE_PARCIAL_DONE);
    expect(dbTotal).toBe(DETALHE_PARCIAL_TOTAL);

    await loginAs(page, COMPLETO);
    await abrirPeloMenu(page);
    const linha = page.getByTestId(`anacare-hours-patient-row-${PATIENT_CURRENT}`);
    await expect(linha).toBeVisible({ timeout: 15_000 });
    await linha.click();
    await expect(page).toHaveURL(new RegExp(`/admin/anacare/horas/${PATIENT_CURRENT}$`));

    const titulo = page.getByText('Sincronización incompleta');
    await expect(titulo).toBeVisible({ timeout: 15_000 });
    const mensagem = page.getByText(/se procesaron \d+ de \d+ reservas/);
    await expect(mensagem).toBeVisible();
    const textoLido = (await mensagem.textContent()) ?? '';
    const match = textoLido.match(/se procesaron (\d+) de (\d+) reservas/);
    if (!match) throw new Error(`Não achei "X de Y" no texto lido da tela: "${textoLido}"`);
    const [, doneNaTela, totalNaTela] = match;
    expect(Number(doneNaTela)).toBe(dbDone);
    expect(Number(totalNaTela)).toBe(dbTotal);
    expect(textoLido).toContain(`se procesaron ${DETALHE_PARCIAL_DONE} de ${DETALHE_PARCIAL_TOTAL} reservas`);
  });

  test('CASO 6 — botão "Sincronizar" real: falha de verdade grava anacare_sync_run (Postgres real), nunca toca o Ana Care real', async ({ page }) => {
    // Arranjo (não é o fluxo sob teste): baseline PRÓPRIO — números que não aparecem em nenhum
    // outro caso deste arquivo, para a prova de PRESERVAÇÃO (abaixo) não poder ser confundida com
    // sobra de outro teste.
    psql(
      `INSERT INTO anacare_sync_run (source, period_month, run_started_at, updated_at, status, "cursor", reservations_total, reservations_done, finished_at, last_error)
       VALUES ('anacare', '${MONTH_CURRENT}-01'::date, NOW(), NOW(), 'done', ${SYNC_FALHA_BASELINE_DONE}, ${SYNC_FALHA_BASELINE_TOTAL}, ${SYNC_FALHA_BASELINE_DONE}, NOW(), NULL)
       ON CONFLICT (source, period_month) DO UPDATE SET
         status = 'done', "cursor" = ${SYNC_FALHA_BASELINE_DONE}, reservations_total = ${SYNC_FALHA_BASELINE_TOTAL}, reservations_done = ${SYNC_FALHA_BASELINE_DONE},
         finished_at = NOW(), last_error = NULL, updated_at = NOW()`,
    );
    const antes = psql(
      `SELECT status, reservations_total, reservations_done, last_error, finished_at IS NOT NULL AS finished
         FROM anacare_sync_run WHERE source='anacare' AND period_month='${MONTH_CURRENT}-01'::date`,
    ).trim();
    console.log(`[caso 6] anacare_sync_run ANTES: ${antes}`);

    await loginAs(page, COMPLETO);
    await abrirPeloMenu(page);
    // mês padrão já é o corrente — clica em "Sincronizar" como um operador faria. O stub não tem
    // `/admin/accounts/` (404 de propósito) — a corrida falha ANTES de qualquer contagem NOVA.
    const botaoSync = page.getByTestId('anacare-hours-sync-button');
    await expect(botaoSync).toBeVisible({ timeout: 15_000 });
    await botaoSync.click();
    await expect(page.getByTestId('anacare-hours-sync-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('anacare-hours-sync-done')).toHaveCount(0);

    // DEPOIS — a linha real em Postgres, escrita pelo controller de sync (nunca por SQL deste
    // teste) — é a prova de que `recordProgress` rodou contra o banco de verdade.
    const depois = scalar(
      `SELECT status || '|' || COALESCE(reservations_total::text,'NULL') || '|' || COALESCE(reservations_done::text,'NULL')
              || '|' || COALESCE(last_error,'NULL') || '|' || (finished_at IS NOT NULL)::text
         FROM anacare_sync_run WHERE source='anacare' AND period_month='${MONTH_CURRENT}-01'::date`,
    );
    console.log(`[caso 6] anacare_sync_run DEPOIS: ${depois}`);
    const [status, reservationsTotal, reservationsDone, lastError, finishedNotNull] = depois.split('|');
    expect(status).toBe('failed');
    // PRESERVADOS (COALESCE no repositório), não apagados — o baseline que semeamos sobrevive à
    // falha intacto. Ver docstring do arquivo (item 2 da retomada 4).
    expect(reservationsTotal).toBe(String(SYNC_FALHA_BASELINE_TOTAL));
    expect(reservationsDone).toBe(String(SYNC_FALHA_BASELINE_DONE));
    // Código ESTÁVEL (nome da CLASSE do erro, nunca `.message` — regra dura da migration 457,
    // `AnaCareSyncErrorCode.ts`) — `AnaCareHttpError` não está entre as classes conhecidas de
    // `toStableErrorCode`, então cai no fallback `UnknownError:<Classe>`.
    expect(lastError).toBe('UnknownError:AnaCareHttpError');
    expect(finishedNotNull).toBe('true');

    // A tela, recarregada, reflete o que acabou de ser escrito — 'failed' entra no mesmo ramo
    // `incompleta` de 'parcial' (`computeSnapshotState`) — e COM contagem preservada, o texto é o
    // INTERPOLADO (não o genérico): os números batem com o baseline que sobreviveu à falha.
    await page.reload();
    const titulo = page.getByText('Sincronización incompleta');
    await expect(titulo).toBeVisible({ timeout: 15_000 });
    const mensagem = page.getByText(
      `se procesaron ${SYNC_FALHA_BASELINE_DONE} de ${SYNC_FALHA_BASELINE_TOTAL} reservas`,
      { exact: false },
    );
    await expect(mensagem).toBeVisible();

    // Nenhuma requisição saiu para o Ana Care real — só para o stub local (mesmo processo desta
    // corrida, porta ANACARE_STUB_PORT). E a rota do diretório (a que 404a de propósito) foi
    // realmente batida — prova de que a falha veio DAQUELA rota, não de outra coisa.
    expect(anaCareStub?.requestsLog.length ?? 0).toBeGreaterThan(0);
    expect(anaCareStub?.requestsLog.some((r) => r.includes('/users/admin/login/'))).toBe(true);
    expect(anaCareStub?.requestsLog.some((r) => r.includes('/admin/accounts/'))).toBe(true);
  });
});
