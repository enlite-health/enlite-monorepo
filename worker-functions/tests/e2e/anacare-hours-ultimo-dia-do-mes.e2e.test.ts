/**
 * Spec 036 (CA-3) — o ÚLTIMO DIA DO MÊS entra na conferência de horas do Ana Care.
 *
 * Defeito que isto trava: `monthToDateRange` mandava o último dia do mês (`2026-09-30`) como
 * `max_date`, mas o Ana Care trata `max_date` como EXCLUSIVO e compara pelo DIA LOCAL (`-06:00`) do
 * `start` — o dia 30 inteiro (e os noturnos que começam nele) saía de toda leitura mensal.
 *
 * Diferença para `anacare-hours-api.e2e.test.ts`: aquele roda com `ANACARE_HOURS_SOURCE=fake`, e o
 * `FakeAnaCareShiftsSource` gera por `month`, sem janela — por isso NÃO prova este conserto. Aqui
 * NADA do caminho sob teste é mockado: `ANACARE_HOURS_SOURCE=real`, `AnaCareSessionClient` real,
 * `AnaCareShiftsSourceReal` real, `AnaCareEnliteDirectory` real, `AnaCareHoursSyncRunner` real,
 * Postgres real, rotas HTTP reais com o engine de permissão ligado. O que é falso é só o Ana Care:
 * um servidor HTTP no processo do jest que imita o Ana Care de SESSÃO (login CSRF + 302 com
 * `sessionid`, painel HTML de contas, `/api/shifts/` paginado) e IMPLEMENTA a semântica MEDIDA em
 * 01/10/2026: `min_date <= dia_local(start) < max_date`, `max_date` exclusivo.
 *
 * Honestidade: o Ana Care real não roda no CI; este teste prova que o NOSSO cliente pede a janela
 * certa a um servidor que se comporta como o medido. A prova no Ana Care de verdade é a medida
 * pós-deploy (CA-4).
 *
 * O que se prova:
 *   (a) após o sync de 2026-09, a LISTA do mês mostra o paciente com 3 turnos (15/09, 30/09 diurno
 *       e 30/09 noturno) — 31/08 e 01/10 ficam de fora;
 *   (b) o DETALHE do paciente em 2026-09 traz os mesmos 3 turnos e nenhum de 31/08 ou 01/10;
 *   (c) sanidade: o servidor recebeu GETs em `/api/shifts/` e TODOS pediram `max_date=2026-10-01`.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const SOURCE = 'anacare';
const MONTH = '2026-09';
const PATIENT_ID = '7001';
const NURSE_ID = '8001';
const ENLITE_AGENCY = 116;
const SESSION_COOKIE = 'sessionid=sessao-falsa-e2e036';
const CSRF_COOKIE = 'csrftoken=csrf-falso-e2e036';

// ─── O Ana Care falso ────────────────────────────────────────────────────────────────────────

interface FakeShift {
  id: number;
  /** Reserva (conta) a que o turno pertence — só o servidor sabe; filtra por `reservation_id`. */
  reservation: number;
  start: string;
  end: string;
  month: string;
}

/**
 * Massa: UM paciente do universo Enlite (agency 116), prestador 8001, reserva 9001.
 * `start`/`end` com offset `-06:00` como a fonte envia. `month` é o campo da PRÓPRIA fonte, que
 * (medido em 01/10) vem calculado em UTC: o noturno de 30/09 22:00 -06:00 chega com `2026-10`.
 */
const SHIFTS: FakeShift[] = [
  { id: 910001, reservation: 9001, start: '2026-08-31T08:00:00-06:00', end: '2026-08-31T16:00:00-06:00', month: '2026-08' }, // fora: agosto
  { id: 910002, reservation: 9001, start: '2026-09-15T08:00:00-06:00', end: '2026-09-15T16:00:00-06:00', month: '2026-09' }, // dentro: controle do meio do mês
  { id: 910003, reservation: 9001, start: '2026-09-30T08:00:00-06:00', end: '2026-09-30T16:00:00-06:00', month: '2026-09' }, // dentro: ÚLTIMO DIA, diurno
  { id: 910004, reservation: 9001, start: '2026-09-30T22:00:00-06:00', end: '2026-10-01T10:00:00-06:00', month: '2026-10' }, // dentro: ÚLTIMO DIA, noturno cruzando a meia-noite
  { id: 910005, reservation: 9001, start: '2026-10-01T08:00:00-06:00', end: '2026-10-01T16:00:00-06:00', month: '2026-10' }, // fora: outubro
];
const IDS_SETEMBRO = ['910002', '910003', '910004'];
const IDS_FORA = ['910001', '910005'];

function rawShift(s: FakeShift): Record<string, unknown> {
  return {
    id: s.id,
    start: s.start,
    end: s.end,
    checkin: s.start,
    checkout: s.end,
    checkin_source: 'app',
    checkout_source: 'app',
    checkin_delay: 0,
    duration: 8,
    is_finalized: true,
    month: s.month,
    patient: {
      id: Number(PATIENT_ID),
      agency: ENLITE_AGENCY,
      identification_type: null,
      identification_number: null,
      first_name: 'Paciente',
      last_name: 'Sintetico',
      surname: 'QA',
    },
    nurse: { id: Number(NURSE_ID), agency: ENLITE_AGENCY, first_name: 'Prestador', last_name: 'Sintetico', surname: 'QA' },
  };
}

/** Dia LOCAL do `start` como a fonte envia (offset `-06:00` preservado): o prefixo `YYYY-MM-DD`. */
const dayOf = (iso: string): string => iso.slice(0, 10);

interface ShiftsRequest {
  query: Record<string, string>;
}

function createFakeAnaCare(received: ShiftsRequest[]): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authenticated = (req.headers.cookie ?? '').includes(SESSION_COOKIE);
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      // Login de formulário Django: GET entrega o csrftoken, POST válido responde 302 + sessionid.
      if (url.pathname === '/users/admin/login/') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `${CSRF_COOKIE}; Path=/` });
          res.end('<form></form>');
          return;
        }
        const form = new URLSearchParams(body);
        const csrfOk = form.get('csrfmiddlewaretoken') === 'csrf-falso-e2e036' && (req.headers.cookie ?? '').includes(CSRF_COOKIE);
        const credOk = form.get('username') === 'usuario-falso' && form.get('password') === 'senha-falsa';
        if (csrfOk && credOk) {
          res.writeHead(302, { Location: '/admin/', 'Set-Cookie': `${SESSION_COOKIE}; Path=/` });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<form>credencial rejeitada</form>');
        return;
      }

      if (!authenticated) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'sem sessao' }));
        return;
      }

      // Painel HTML de contas (diretório da Enlite): ativos 9001 (tem turnos) e terminados 9002 (sem turnos).
      if (url.pathname === '/admin/accounts/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<a href="/admin/accounts/9001/change/">9001</a>');
        return;
      }
      if (url.pathname === '/admin/accounts/terminated_services') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<a href="/admin/accounts/9002/change/">9002</a>');
        return;
      }

      if (url.pathname === '/api/shifts/') {
        const q = Object.fromEntries(url.searchParams.entries());
        received.push({ query: q });

        // Semântica MEDIDA em 01/10/2026: dia local do `start`, `max_date` EXCLUSIVO.
        let rows = SHIFTS.filter((s) => {
          const day = dayOf(s.start);
          if (q.min_date && day < q.min_date) return false;
          if (q.max_date && day >= q.max_date) return false;
          return true;
        });
        // Filtros que o cliente manda: `patient` e `reservation_id` (o servidor real respeita os dois).
        if (q.patient) rows = rows.filter(() => q.patient === PATIENT_ID);
        if (q.reservation_id) rows = rows.filter((s) => String(s.reservation) === q.reservation_id);

        const page = Number(q.page ?? 1);
        const pageSize = Number(q.page_size ?? 100);
        const slice = rows.slice((page - 1) * pageSize, page * pageSize);
        const hasNext = page * pageSize < rows.length;
        const nextParams = new URLSearchParams(url.searchParams);
        nextParams.set('page', String(page + 1));
        const host = req.headers.host;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          count: rows.length,
          next: hasNext ? `http://${host}/api/shifts/?${nextParams.toString()}` : null,
          previous: null,
          results: slice.map(rawShift),
        }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'not found' }));
    });
  });
}

// ─── Suite ───────────────────────────────────────────────────────────────────────────────────

describe('spec 036 CA-3 — o último dia do mês entra na lista e no detalhe (Ana Care falso de sessão, cliente/sync/banco/HTTP reais)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  let fakeServer: http.Server;
  const received: ShiftsRequest[] = [];
  let snapshotDiretorioAnterior: number | null = null;

  const U = { completo: 'ach-036-completo' };
  const GRUPO = 'ACH 036 Completo';
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function chamar(metodo: string, caminho: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(U.completo), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM anacare_patient_month_provider WHERE source = $1 AND ana_care_patient_id = $2`, [SOURCE, PATIENT_ID]);
    await pool.query(`DELETE FROM anacare_patient_month WHERE source = $1 AND ana_care_patient_id = $2`, [SOURCE, PATIENT_ID]);
    await pool.query(`DELETE FROM anacare_sync_run WHERE source = $1 AND period_month = $2::date`, [SOURCE, `${MONTH}-01`]);
    await limparIamFixtures(pool, { uids: [U.completo], grupos: [GRUPO] });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    // O alarme de queda do diretório grava `anacare_directory_snapshot` (linha única): guarda o valor
    // anterior para devolver o banco como estava (outras suítes dependem da linha-base).
    const snap = await pool.query(`SELECT last_total_count FROM anacare_directory_snapshot WHERE id = 1`);
    snapshotDiretorioAnterior = snap.rowCount ? Number(snap.rows[0].last_total_count) : null;
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
       VALUES ($1, 'ach-036-completo@e2e.local', 'Validador Sintético QA', 'admin', 'ACTIVE', true, $2)`,
      [U.completo, TENANT_E2E],
    );
    await garantirCelula(pool, { resource: 'anacare_hours', action: 'read', category: 'Pacientes' });
    await garantirCelula(pool, { resource: 'anacare_hours', action: 'validate', category: 'Pacientes' });
    await grupoComCelulas(pool, {
      nome: GRUPO,
      uid: U.completo,
      celulas: [['anacare_hours', 'read'], ['anacare_hours', 'validate']],
    });

    // Servidor do Ana Care falso, porta efêmera.
    fakeServer = createFakeAnaCare(received);
    await new Promise<void>((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
    const porta = (fakeServer.address() as AddressInfo).port;

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    // FONTE REAL, apontada ao servidor falso (injeção por env: AnaCareSyncDependenciesFactory + AnaCareSessionClient).
    setEnv('ANACARE_HOURS_SOURCE', 'real');
    setEnv('ANACARE_BASE_URL', `http://127.0.0.1:${porta}`);
    setEnv('ANACARE_USERNAME', 'usuario-falso');
    setEnv('ANACARE_PASS', 'senha-falsa');
    // 1ª rodada sem histórico: o runner é fail-closed sem piso absoluto (AnaCareDirectoryFirstRunNotConfiguredError).
    setEnv('ANACARE_DIRECTORY_MIN_ABSOLUTE', '1');

    // `sharedDeps`/`sharedRunner` são ESTÁTICOS: se outra suíte do mesmo worker já os resolveu (fake),
    // este arquivo herdaria a fonte errada. Zera antes de o primeiro request resolver de novo.
    const anacareHours = await import('@modules/anacare-hours');
    anacareHours.AnaCareHoursSyncController.resetSharedRunnerForTests();

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) => {
        express.use('/api/admin', anacareHours.createAnaCareHoursRoutes(new anacareHours.AnaCareHoursController(), auth, permissions));
        express.use('/api/admin', anacareHours.createAnaCareHoursSyncAdminRoutes(new anacareHours.AnaCareHoursSyncController(), auth, permissions));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const anacareHours = await import('@modules/anacare-hours');
    anacareHours.AnaCareHoursSyncController.resetSharedRunnerForTests();
    await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    if (snapshotDiretorioAnterior === null) {
      await pool.query(`DELETE FROM anacare_directory_snapshot WHERE id = 1`);
    } else {
      await pool.query(`UPDATE anacare_directory_snapshot SET last_total_count = $1 WHERE id = 1`, [snapshotDiretorioAnterior]);
    }
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('sync de 2026-09 pela rota HTTP: lê 3 turnos do Ana Care falso (30/09 incluído, 31/08 e 01/10 fora)', async () => {
    const res = await chamar('POST', '/api/admin/anacare-hours/sync', { month: MONTH });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nextCursor).toBeNull(); // terminou a lista de reservas
    expect(res.body.shiftsRead).toBe(3);
    expect(res.body.shiftsWritten).toBeGreaterThan(0);
  }, 60000);

  it('(a) a LISTA de 2026-09 mostra o paciente com 3 turnos e as horas dos 3 (8h + 8h + 12h)', async () => {
    const res = await chamar('GET', `/api/admin/anacare-hours/months/${MONTH}`);
    expect(res.status).toBe(200);
    const paciente = (res.body.data.patients as any[]).find((p) => p.anaCareId === PATIENT_ID);
    expect(paciente).toBeDefined();
    // Se `max_date` voltasse a ser o último dia do mês, o 30/09 sairia e aqui haveria 1 turno (15/09).
    expect(paciente.shiftsCount).toBe(3);
    expect(paciente.hoursActualSum).toBe(28);
    expect(paciente.providersCount).toBe(1);
  });

  it('(b) o DETALHE do paciente em 2026-09 traz os turnos de 30/09 (os dois) e não traz 31/08 nem 01/10', async () => {
    const res = await chamar('GET', `/api/admin/anacare-hours/months/${MONTH}/patients/${PATIENT_ID}`);
    expect(res.status).toBe(200);
    const turnos: any[] = res.body.data.providers.flatMap((p: any) => p.shifts);
    const ids = turnos.map((t) => t.anaCareShiftId).sort();
    expect(ids).toEqual(IDS_SETEMBRO);
    for (const fora of IDS_FORA) expect(ids).not.toContain(fora);

    const dias30 = turnos.filter((t) => t.date === '2026-09-30').map((t) => t.anaCareShiftId).sort();
    expect(dias30).toEqual(['910003', '910004']); // diurno e noturno (22:00 → 01/10 10:00) ancorados no dia em que começam
    expect(turnos.find((t) => t.anaCareShiftId === '910004')?.scheduledEnd).toBe('2026-10-01T10:00:00-06:00');
  });

  it('(c) sanidade: o Ana Care falso recebeu GETs em /api/shifts/ e TODOS pediram max_date=2026-10-01 (exclusivo)', () => {
    // Registro das queries recebidas, para o relato de quem rodar (contagem zero seria falha).
    // eslint-disable-next-line no-console
    console.log('[e2e036] queries recebidas em /api/shifts/:', JSON.stringify(received.map((r) => r.query)));

    expect(received.length).toBeGreaterThanOrEqual(1);
    for (const r of received) {
      expect(r.query.min_date).toBe('2026-09-01');
      expect(r.query.max_date).toBe('2026-10-01');
    }
    // As duas rotas de leitura foram exercitadas: o sync (por reserva) e o detalhe (por paciente).
    expect(received.some((r) => r.query.reservation_id === '9001')).toBe(true);
    expect(received.some((r) => r.query.patient === PATIENT_ID)).toBe(true);
  });
});
