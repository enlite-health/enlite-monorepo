/**
 * anacare-hours-axonico-envio.integration.e2e.ts @integration
 *
 * E2E REAL (sem mock de API) do botão "Enviar" ao Axonico, dentro da tela "Conferência de horas
 * do Ana Care" (`AxonicoSendControl`/`AxonicoDocumentModal`, decisão do Gabriel 19/09) — frontend
 * real + `worker-functions` real (engine ABAC LIGADO, `ANACARE_HOURS_SOURCE=fake`) + Postgres
 * real. Login humano (click + keyboard.type, mesmo padrão de `anacare-hours-conferencia....ts`,
 * que é o MODELO deste arquivo); interação com a TELA sempre humana — nunca `fill()`/`forceFill`/
 * `evaluate` (memória `e2e-humano-nao-e-fill`).
 *
 * ⚠️ REGRA DE SEGURANÇA ACIMA DE TUDO — o Axonico NÃO tem sandbox: todo `PUT /api/comprobante`
 * real GERA FATURAMENTO em produção do Axonico. `AxonicoApiClient.ts:44` cai em
 * `https://api.apiws.axonico.ar` por DEFAULT quando a env falta — por isso este arquivo confere,
 * ANTES DE QUALQUER CLIQUE, a env `AXONICO_BASE_URL` do container `enlite-api` (guard local, ver
 * `guardAxonicoEnvOuFalha`) e prova DEPOIS que o tráfego foi mesmo para o stub local
 * (`requestCounts.comprobantePut`, `axonicoStubServer.ts`) — nunca para `*.axonico.ar`.
 *
 * STACK (pré-condição documentada em `enlite-frontend/CLAUDE.md` + `docker-compose.anacare-hours.
 * yml`):
 *   docker compose -p worker-functions -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.anacare-hours.yml up -d --build --no-deps postgres api
 *   cd enlite-frontend && pnpm dev
 *
 * STUB do Axonico: sobe NESTE processo (fora do container) na porta 9912 — o container da API
 * alcança via `host.docker.internal` (`AXONICO_BASE_URL` do compose acima). Nunca mock de rede do
 * lado do FRONTEND (`page.route`) para a chamada sob teste — o e2e prova o caminho real
 * front→nossa API→stub.
 *
 * DADOS: adapter FALSO (`FakeAnaCareShiftsSource`) — mesma massa determinística por mês do
 * arquivo-modelo. Usamos os pacientes `AC-PAT-7`/`AC-PAT-8`/`AC-PAT-9` (o modelo já usa
 * `AC-PAT-6` para a suíte de conferência — evita colidir). Para cada paciente, calculamos em
 * runtime (nunca cravado) o único turno do mês que nasce VALIDÁVEL e JÁ com check-in/checkout e
 * hora CHEIA (as 3 condições de elegibilidade do Axonico que não são o documento) — a mesma
 * fórmula de `FakeAnaCareShiftsSource.generateMonth`/`buildOriginSequence`.
 *
 * Isolamento: RUN_ID no uid/e-mail do staff; `afterAll` limpa `shift_hours_validation` dos 3
 * turnos tocados, `ana_care_patient_document` dos 3 pacientes e `axonico_comprobante_lancamento`
 * dos DNIs sintéticos usados — nunca `TRUNCATE`/`DELETE` largo (outras sessões usam o mesmo
 * Postgres).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect, type Page, type Route } from '@playwright/test';
// Import cruzado de pacote (worker-functions/ é sibling de enlite-frontend/ na mesma worktree) —
// caminho relativo simples, mesmo padrão que `tests/e2e/axonico-lancamento.e2e.test.ts` já usa
// para importar o stub dentro do próprio worker-functions. Fonte única: NUNCA duplicar o stub
// aqui. Playwright transpila cada arquivo com esbuild (sem checagem de projeto/tsconfig), então a
// fronteira de pacote não quebra a resolução em runtime.
// Import cruzado de pacote: `worker-functions/` não declara `"type":"module"` (CJS) enquanto
// `enlite-frontend/` declara (ESM) — um `import` estático nomeado do arquivo do outro pacote
// falha (Node tenta análise estática de export num arquivo .ts CRU, fora do hook de transform do
// Playwright, medido: "may not support all module.exports as named exports" / "Cannot use import
// statement outside a module", dependendo da forma do import). `createRequire` + `require()`
// dinâmico passa pelo MESMO hook de transform TS do Playwright (que intercepta `require`
// globalmente, não só `import`) e resolve em runtime, sem essa análise estática — nunca duplica o
// stub, só troca a SINTAXE de import por fronteira de pacote.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const axonicoStubServerPkg = require('../../../worker-functions/tests/e2e/helpers/axonicoStubServer') as typeof import('../../../worker-functions/tests/e2e/helpers/axonicoStubServer');
const { startAxonicoStub } = axonicoStubServerPkg;
type AxonicoStub = import('../../../worker-functions/tests/e2e/helpers/axonicoStubServer').AxonicoStub;

const PRINTS_DIR =
  process.env.ANACARE_HOURS_EVIDENCE_DIR ?? path.resolve(process.cwd(), 'e2e', '__evidence__', 'anacare-axonico-envio');
let printsDirEnsured = false;
const print = (page: Page, name: string) => {
  if (!printsDirEnsured) {
    fs.mkdirSync(PRINTS_DIR, { recursive: true });
    printsDirEnsured = true;
  }
  return page.screenshot({ path: path.join(PRINTS_DIR, name), fullPage: true });
};

const DB_URL = process.env.ANACARE_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const AXONICO_STUB_PORT = 9912;

const STAFF_UID = `axo-envio-e2e-${RUN_ID}`;
const STAFF_EMAIL = `${STAFF_UID}@e2e.test`;
const GRUPO = `Axonico Envio E2E ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

// ── DNIs sintéticos, um por caso — nunca reciclados entre casos (mesmo cuidado de
// `axonico-lancamento.e2e.test.ts`: o dedupe LOCAL é chaveado por documentNumber+serviceType+
// serviceDate, e cada caso usa uma DATA diferente também, então nem precisaria, mas mantém a
// leitura do teste sem ambiguidade sobre "de quem é esse DNI").
const DNI_FELIZ = '30777001';
const DNI_DUPLICADO = '30888002';
const DNI_DNI_CASE = '30999003'; // digitado no modal, nunca pré-semeado no banco

const HC_FELIZ = 'HC-E2E-FELIZ';
const HC_DUPLICADO = 'HC-E2E-DUPLICADO';
const HC_DNI_CASE = 'HC-E2E-DNI';

// ────────────────────────────────────────────────────────────────────────────────────────────
// Réplica EXATA (nunca cravada) da massa determinística de `FakeAnaCareShiftsSource` — a mesma
// fórmula do arquivo-modelo (`shiftDateForIndexS`), generalizada para QUALQUER paciente/turno,
// porque aqui precisamos varrer os 3 pacientes procurando o único turno-do-mês que nasce
// VALIDÁVEL + com check-in/checkout + hora CHEIA (as 3 condições de `axonicoDayEligibility` que
// não são o documento).
// ────────────────────────────────────────────────────────────────────────────────────────────
const PATIENTS_PER_MONTH = 10;
const PROVIDERS_PER_PATIENT = 2;
const SHIFTS_PER_PROVIDER = 5;
const TOTAL_SHIFTS = PATIENTS_PER_MONTH * PROVIDERS_PER_PATIENT * SHIFTS_PER_PROVIDER; // 100
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
/** MESMA função do arquivo-modelo — a tela abre no MÊS CORRENTE (`currentMonthIso`). */
function currentMonthIsoForE2E(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}`;
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
  /** `null` quando `sin_checkin` OU "em andamento" (sem checkout) — nesses casos `hoursActual` é `null` no domínio. */
  earlyMin: number | null;
}

/** Réplica de `FakeAnaCareShiftsSource.generateMonth` — só os campos que decidem elegibilidade. */
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

/**
 * Acha, para o paciente `p`, o ÚNICO turno do mês que: (a) é o turno SOZINHO no seu dia (nenhum
 * outro turno do MESMO paciente, de qualquer prestador, cai na mesma data — `DayGroup` agrupa por
 * data, não por prestador, e as 4 condições de elegibilidade valem para TODOS os turnos do dia);
 * (b) tem check-in E checkout (`isFinalized`); (c) soma hora CHEIA (`earlyMin === 0`, única forma
 * da fórmula do adapter falso zerar a fração — ver cálculo no README desta task). Lança se o mês
 * em que o teste roda não tiver candidato (nunca cai num turno errado em silêncio).
 */
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
  throw new Error(
    `Nenhum turno elegível (sozinho no dia + check-in/out + hora cheia) para o paciente AC-PAT-${p} no mês ${MONTH} — a massa é determinística por ÍNDICE GLOBAL, então isto só muda se o MÊS mudar; ajustar o índice do paciente escolhido.`,
  );
}

const TARGET_FELIZ = pickEligibleSingleShiftDay(7);
const TARGET_DUPLICADO = pickEligibleSingleShiftDay(8);
const TARGET_DNI = pickEligibleSingleShiftDay(9);

const PATIENT_FELIZ = `AC-PAT-${TARGET_FELIZ.p}`;
const PATIENT_DUPLICADO = `AC-PAT-${TARGET_DUPLICADO.p}`;
const PATIENT_DNI = `AC-PAT-${TARGET_DNI.p}`;

const SHIFT_FELIZ = `FAKE-${MONTH}-${TARGET_FELIZ.p}-${TARGET_FELIZ.pr}-${TARGET_FELIZ.s}`;
const SHIFT_DUPLICADO = `FAKE-${MONTH}-${TARGET_DUPLICADO.p}-${TARGET_DUPLICADO.pr}-${TARGET_DUPLICADO.s}`;
const SHIFT_DNI = `FAKE-${MONTH}-${TARGET_DNI.p}-${TARGET_DNI.pr}-${TARGET_DNI.s}`;
const SHIFT_IDS_TOCADOS = [SHIFT_FELIZ, SHIFT_DUPLICADO, SHIFT_DNI];

// ── Navegador de semana COM ESTADO — mesmo padrão do arquivo-modelo (`criarNavegadorDeSemana`),
// mas o `DEFAULT_WEEK_START` é calculado POR PACIENTE (a tela abre na semana do turno MAIS
// ANTIGO daquele paciente especificamente, entre os 10 dele).
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
/**
 * MESMA fórmula de `AnaCareHoursDetailPage.tsx:110-111` (decisão do Gabriel, 18/09) — a tela NÃO
 * abre na semana do turno mais antigo (comentário desatualizado no arquivo-modelo; conferido no
 * código atual): abre na semana de HOJE se o mês exibido contém hoje, senão na PRIMEIRA semana do
 * mês exibido (`${snapshot.month}-01`). Revisto 20/09: `MONTH` aqui é o mês CORRENTE (Tarefa 3,
 * 16/09), então cai sempre no PRIMEIRO ramo (semana de hoje) — antes, com `MONTH` no mês ANTERIOR,
 * caía sempre no segundo. A condição vem escrita por igual mesmo assim, nunca cravada.
 */
function defaultWeekStart(): string {
  const todayIso = new Date().toISOString().slice(0, 10);
  return startOfWeekMonday(MONTH === todayIso.slice(0, 7) ? todayIso : `${MONTH}-01`);
}
function criarNavegadorDeSemana(page: Page): { irPara: (dateIso: string) => Promise<void>; resetarAposReloadOuMount: () => void } {
  const defaultStart = defaultWeekStart();
  let atual = defaultStart;
  return {
    async irPara(dateIso: string): Promise<void> {
      const alvo = startOfWeekMonday(dateIso);
      const delta = weeksBetweenMondays(atual, alvo);
      if (delta > 0) {
        for (let i = 0; i < delta; i += 1) await page.getByTestId('anacare-hours-week-next').click();
      } else if (delta < 0) {
        for (let i = 0; i < -delta; i += 1) await page.getByTestId('anacare-hours-week-prev').click();
      }
      atual = alvo;
    },
    resetarAposReloadOuMount(): void {
      atual = defaultStart;
    },
  };
}

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

interface MockUser {
  uid: string;
  email: string;
  role: string;
  country: string;
}
const STAFF: MockUser = { uid: STAFF_UID, email: STAFF_EMAIL, role: 'admin', country: 'AR' };

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

/** Login HUMANO (click + keyboard.type) — mesmo `loginAs` do arquivo-modelo. */
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
  await page.waitForTimeout(1_200);
}

/**
 * GUARD (a) — lê a env do CONTAINER REAL da API (nunca a do processo do teste, que não roda
 * dentro do Docker) e falha IMEDIATAMENTE se estiver vazia ou apontar para `*.axonico.ar`. Chamado
 * ANTES de qualquer clique em QUALQUER teste deste arquivo — nenhum caso pode abrir mão disto.
 */
function guardAxonicoEnvOuFalha(): void {
  const containerCandidates = ['enlite-api'];
  let raw: string | null = null;
  let usedContainer: string | null = null;
  for (const name of containerCandidates) {
    try {
      raw = execFileSync('docker', ['exec', name, 'printenv', 'AXONICO_BASE_URL'], { stdio: ['ignore', 'pipe', 'pipe'] })
        .toString()
        .trim();
      usedContainer = name;
      break;
    } catch {
      // tenta o próximo candidato
    }
  }
  console.log(`[guard-axonico-env] container=${usedContainer ?? 'NENHUM ENCONTRADO'} AXONICO_BASE_URL="${raw ?? ''}"`);
  if (!raw || raw.length === 0) {
    throw new Error(`[guard-axonico-env] AXONICO_BASE_URL vazia no container ${usedContainer ?? '?'} — RECUSANDO rodar (cairia no default de produção do AxonicoApiClient).`);
  }
  if (/axonico\.ar/.test(raw)) {
    throw new Error(`[guard-axonico-env] AXONICO_BASE_URL="${raw}" aponta para o Axonico REAL — RECUSANDO rodar.`);
  }
}

test.describe('Envio ao Axonico — E2E real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  let stub: AxonicoStub;

  test.beforeAll(async () => {
    // GUARD (a) — antes de QUALQUER OUTRA COISA, inclusive antes de subir o stub.
    guardAxonicoEnvOuFalha();

    stub = await startAxonicoStub(
      [
        { dni: DNI_FELIZ, historiaClinica: HC_FELIZ, nroCobertura: 'COB-E2E-FELIZ' },
        { dni: DNI_DUPLICADO, historiaClinica: HC_DUPLICADO, nroCobertura: 'COB-E2E-DUPLICADO' },
        { dni: DNI_DNI_CASE, historiaClinica: HC_DNI_CASE, nroCobertura: 'COB-E2E-DNI' },
      ],
      AXONICO_STUB_PORT,
    );
    // Caso 2 (duplicado remoto) — o stub já "tem" um comprobante para este DNI ANTES do teste
    // clicar em qualquer coisa (dedupe REMOTO, guard 4 do use case).
    stub.dnisComComprobanteExistente.add(DNI_DUPLICADO);

    safeSql(`DELETE FROM shift_hours_validation WHERE source = 'anacare' AND source_shift_id IN ('${SHIFT_IDS_TOCADOS.join("','")}')`);
    safeSql(`DELETE FROM ana_care_patient_document WHERE ana_care_patient_id IN ('${PATIENT_FELIZ}','${PATIENT_DUPLICADO}','${PATIENT_DNI}')`);
    safeSql(`DELETE FROM axonico_comprobante_lancamento WHERE document_number IN ('${DNI_FELIZ}','${DNI_DUPLICADO}','${DNI_DNI_CASE}')`);

    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${STAFF_UID}', '${STAFF_EMAIL}', 'E2E Axonico Envio', 'admin', true, 'ACTIVE', '${TENANT}')`);

    const grupoId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO}', 'e2e axonico-envio — nao mexer manual') RETURNING id`);
    // anacare_hours: read/validate (mesma célula da tela) + patient_identity:read (o gate que
    // decide se `patientDocumentNumber` sai no payload — sem ela `axonicoDayEligibility` acusaria
    // `missingDocument` SEMPRE, mesmo com o documento pré-semeado no banco).
    psql(`INSERT INTO iam.group_permissions (group_id, permission_id)
          SELECT '${grupoId}', id FROM iam.permissions WHERE (resource='anacare_hours' AND action IN ('read','validate'))
             OR (resource='patient_identity' AND action IN ('read','create'))`);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${grupoId}', 'AR', '${STAFF_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${STAFF_UID}', '${grupoId}', '${TENANT}')`);

    // Documento PRÉ-registrado só para FELIZ e DUPLICADO — o caso DNI precisa nascer SEM
    // documento (é o que dispara o modal).
    psql(`INSERT INTO ana_care_patient_document (ana_care_patient_id, document_number, document_type, registered_by)
          VALUES ('${PATIENT_FELIZ}', '${DNI_FELIZ}', 'DNI', '${STAFF_UID}')`);
    psql(`INSERT INTO ana_care_patient_document (ana_care_patient_id, document_number, document_type, registered_by)
          VALUES ('${PATIENT_DUPLICADO}', '${DNI_DUPLICADO}', 'DNI', '${STAFF_UID}')`);
  });

  test.afterAll(async () => {
    safeSql(`DELETE FROM shift_hours_validation WHERE source = 'anacare' AND source_shift_id IN ('${SHIFT_IDS_TOCADOS.join("','")}')`);
    safeSql(`DELETE FROM ana_care_patient_document WHERE ana_care_patient_id IN ('${PATIENT_FELIZ}','${PATIENT_DUPLICADO}','${PATIENT_DNI}')`);
    safeSql(`DELETE FROM axonico_comprobante_lancamento WHERE document_number IN ('${DNI_FELIZ}','${DNI_DUPLICADO}','${DNI_DNI_CASE}')`);
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id = '${STAFF_UID}'`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id = '${STAFF_UID}'`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = '${GRUPO}')`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = '${GRUPO}')`);
    safeSql(`DELETE FROM iam.permission_groups WHERE name = '${GRUPO}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid = '${STAFF_UID}'`);
    await stub.close();
  });

  test('FELIZ — dia validado, horas inteiras, paciente COM documento: Enviar mostra o comprobante do stub', async ({ page }) => {
    guardAxonicoEnvOuFalha();

    await loginAs(page, STAFF);
    await page.goto(`/admin/anacare/horas/${PATIENT_FELIZ}`);
    await expect(page.getByRole('heading', { name: /ID AC-PAT-7/ })).toBeVisible({ timeout: 15_000 });

    const semana = criarNavegadorDeSemana(page);
    await semana.irPara(TARGET_FELIZ.dateIso);

    // valida o turno — condição 1/3 de elegibilidade (as outras 2, check-in/out e hora cheia, já
    // nascem prontas na massa falsa; o documento já foi pré-semeado no banco).
    const validarBtn = page.getByTestId(`anacare-hours-validate-shift-${SHIFT_FELIZ}`);
    await expect(validarBtn).toBeVisible({ timeout: 15_000 });
    await validarBtn.click();
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_FELIZ}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_FELIZ}`)).toContainText('Validado por');

    // nenhum motivo de bloqueio deve aparecer — as 4 condições estão satisfeitas.
    await expect(page.getByTestId(`anacare-hours-axonico-reason-notValidated-${TARGET_FELIZ.dateIso}`)).toHaveCount(0);
    await expect(page.getByTestId(`anacare-hours-axonico-reason-missingCheckInOut-${TARGET_FELIZ.dateIso}`)).toHaveCount(0);
    await expect(page.getByTestId(`anacare-hours-axonico-reason-fractionalHours-${TARGET_FELIZ.dateIso}`)).toHaveCount(0);
    await expect(page.getByTestId(`anacare-hours-axonico-reason-missingDocument-${TARGET_FELIZ.dateIso}`)).toHaveCount(0);

    const countesAntes = stub.requestCounts.comprobantePut;
    await print(page, 'feliz-antes-de-enviar.png');

    const enviarBtn = page.getByTestId(`anacare-hours-send-day-${TARGET_FELIZ.dateIso}`);
    await expect(enviarBtn).toBeEnabled({ timeout: 10_000 });
    await enviarBtn.click();

    const sentLabel = page.getByTestId(`anacare-hours-day-sent-${TARGET_FELIZ.dateIso}`);
    await expect(sentLabel).toBeVisible({ timeout: 15_000 });
    await expect(sentLabel).toContainText('CMP-'); // número do comprobante vem do STUB (`numero_comprobante: CMP-${n}`)
    await print(page, 'feliz-enviado.png');

    // PROVA POSITIVA (b) — o PUT chegou no stub de verdade; contagem parada = tráfego foi pra
    // outro lugar (produção ou nenhum lugar), o que é FALHA, nunca sucesso.
    expect(stub.requestCounts.comprobantePut).toBeGreaterThan(countesAntes);
  });

  test('ALTERNATIVO duplicado — stub responde duplicado SEM número; a tela nunca mostra "undefined"', async ({ page }) => {
    guardAxonicoEnvOuFalha();

    await loginAs(page, STAFF);
    await page.goto(`/admin/anacare/horas/${PATIENT_DUPLICADO}`);
    await expect(page.getByRole('heading', { name: /ID AC-PAT-8/ })).toBeVisible({ timeout: 15_000 });

    const semana = criarNavegadorDeSemana(page);
    await semana.irPara(TARGET_DUPLICADO.dateIso);

    const validarBtn = page.getByTestId(`anacare-hours-validate-shift-${SHIFT_DUPLICADO}`);
    await expect(validarBtn).toBeVisible({ timeout: 15_000 });
    await validarBtn.click();
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_DUPLICADO}`)).toHaveCount(0, { timeout: 15_000 });

    const putAntes = stub.requestCounts.comprobantePut;
    const enviarBtn = page.getByTestId(`anacare-hours-send-day-${TARGET_DUPLICADO.dateIso}`);
    await expect(enviarBtn).toBeEnabled({ timeout: 10_000 });
    await enviarBtn.click();

    const duplicadoLabel = page.getByTestId(`anacare-hours-day-duplicated-no-comprobante-${TARGET_DUPLICADO.dateIso}`);
    await expect(duplicadoLabel).toBeVisible({ timeout: 15_000 });
    await print(page, 'duplicado-sem-numero.png');

    // regra dura do brief: NUNCA interpolar null/undefined no DOM — asserta no escopo do DIA
    // inteiro (cabeçalho + linha + rótulo de duplicado), não só no rótulo.
    const escopoDoDia = page.getByTestId(`anacare-hours-day-group-${TARGET_DUPLICADO.dateIso}`);
    await expect(escopoDoDia).not.toContainText('undefined');
    await expect(escopoDoDia).not.toContainText('null');

    // dedupe REMOTO (guard 4) achou o comprobante ANTES do PUT — o stub prova que NENHUM PUT
    // novo aconteceu (senão faturaria de novo o mesmo comprobante).
    expect(stub.requestCounts.comprobantePut).toBe(putAntes);
  });

  test('ALTERNATIVO DNI — paciente sem documento: modal registra o DNI, envia, e não pergunta de novo após reload', async ({ page }) => {
    guardAxonicoEnvOuFalha();

    await loginAs(page, STAFF);
    await page.goto(`/admin/anacare/horas/${PATIENT_DNI}`);
    await expect(page.getByRole('heading', { name: /ID AC-PAT-9/ })).toBeVisible({ timeout: 15_000 });

    const semana = criarNavegadorDeSemana(page);
    await semana.irPara(TARGET_DNI.dateIso);

    const validarBtn = page.getByTestId(`anacare-hours-validate-shift-${SHIFT_DNI}`);
    await expect(validarBtn).toBeVisible({ timeout: 15_000 });
    await validarBtn.click();
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_DNI}`)).toHaveCount(0, { timeout: 15_000 });

    // único motivo de bloqueio visível é `missingDocument` — as outras 3 condições já valem.
    await expect(page.getByTestId(`anacare-hours-axonico-reason-missingDocument-${TARGET_DNI.dateIso}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`anacare-hours-axonico-reason-notValidated-${TARGET_DNI.dateIso}`)).toHaveCount(0);
    await expect(page.getByTestId(`anacare-hours-axonico-reason-missingCheckInOut-${TARGET_DNI.dateIso}`)).toHaveCount(0);
    await expect(page.getByTestId(`anacare-hours-axonico-reason-fractionalHours-${TARGET_DNI.dateIso}`)).toHaveCount(0);

    // clicar "Enviar" com missingDocument como ÚNICA razão abre o modal (em vez de recusar) —
    // desenho do brief 19/09.
    const enviarBtn = page.getByTestId(`anacare-hours-send-day-${TARGET_DNI.dateIso}`);
    await expect(enviarBtn).toBeEnabled({ timeout: 10_000 });
    await enviarBtn.click();

    const modal = page.getByTestId('anacare-hours-axonico-document-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await print(page, 'dni-modal-aberto.png');

    const input = page.getByTestId('anacare-hours-axonico-document-modal-input');
    await input.click();
    await expect(input).toBeFocused();
    await page.keyboard.type(DNI_DNI_CASE);
    await expect(input).toHaveValue(DNI_DNI_CASE);

    const putAntes = stub.requestCounts.comprobantePut;
    await page.getByTestId('anacare-hours-axonico-document-modal-confirm').click();
    await expect(modal).toHaveCount(0, { timeout: 15_000 });

    // registro encadeia o envio — sucesso (não é DNI de duplicado remoto, então enviado de verdade).
    const sentLabel = page.getByTestId(`anacare-hours-day-sent-${TARGET_DNI.dateIso}`);
    await expect(sentLabel).toBeVisible({ timeout: 15_000 });
    await print(page, 'dni-enviado.png');
    expect(stub.requestCounts.comprobantePut).toBeGreaterThan(putAntes);

    // reload — prova "depois disso não perguntar mais": o documento agora vem do BANCO
    // (`ana_care_patient_document`, populado pelo registro acima) no próximo GET, então
    // `missingDocument` não é mais razão nenhuma e o clique NUNCA abre o modal de novo.
    await page.reload();
    semana.resetarAposReloadOuMount();
    await expect(page.getByRole('heading', { name: /ID AC-PAT-9/ })).toBeVisible({ timeout: 15_000 });
    await semana.irPara(TARGET_DNI.dateIso);

    await expect(page.getByTestId(`anacare-hours-axonico-reason-missingDocument-${TARGET_DNI.dateIso}`)).toHaveCount(0, { timeout: 15_000 });
    const enviarBtnDeNovo = page.getByTestId(`anacare-hours-send-day-${TARGET_DNI.dateIso}`);
    await expect(enviarBtnDeNovo).toBeVisible({ timeout: 15_000 });
    await enviarBtnDeNovo.click();

    // o clique segue direto (duplicado LOCAL, guard 2 — mesmo doc/mesma data/mesmo tipo já
    // enviado acima) — o que importa aqui é só isto: o modal NUNCA aparece de novo.
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('anacare-hours-axonico-document-modal')).toHaveCount(0);
    await print(page, 'dni-reload-sem-modal.png');
  });
});
