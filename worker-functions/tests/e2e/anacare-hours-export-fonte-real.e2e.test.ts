/**
 * Spec 032 (F1, T1.9) — exportação das horas com a FONTE REAL (`ANACARE_HOURS_SOURCE=real`):
 * `AnaCareSessionClient` e `AnaCareShiftsSourceReal` de verdade, Postgres real, rotas HTTP reais com
 * o engine de permissão ligado. O que é falso é só o Ana Care: um servidor HTTP no processo do jest
 * (login CSRF + 302 com `sessionid`, `/api/shifts/` paginado) que IMPLEMENTA a semântica MEDIDA em
 * 01/10/2026: `min_date <= dia_local(start) < max_date`, `max_date` EXCLUSIVO. Cópia estrutural de
 * `anacare-hours-ultimo-dia-do-mes.e2e.test.ts`; SEM `sync` (o export lê ao vivo, não precisa do retrato).
 *
 * Honestidade: o Ana Care real não roda no CI; isto prova que o NOSSO cliente pede a janela certa a
 * um servidor que se comporta como o medido. A prova no Ana Care de verdade é a conferência da F5.
 *
 * O Fake (`anacare-hours-export.e2e.test.ts`) não tem nome nem turno de meia-noite — aqui sim:
 *   (iii) COM `patient_identity:read` + `worker_contact:read` o NOME aparece (cabeçalho, Analítico e
 *         nome do arquivo); SEM elas sai `Sin vínculo · ID <id>` nos três;
 *   (v)   turno 30/09 22:00 → 01/10 10:00 conta no dia em que COMEÇA (e não aparece em 01/10);
 *   (vi)  `hasta=2026-09-30` ⇒ o servidor recebeu `max_date=2026-10-01` em TODOS os GET de `/api/shifts/`;
 *   fonte fora do ar (5xx) ⇒ erro, nenhum xlsx.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';
import * as XLSX from 'xlsx';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const PATIENT_ID = '7001';
const NURSE_ID = '8001';
const ENLITE_AGENCY = 116;
const SESSION_COOKIE = 'sessionid=sessao-falsa-e2e032';
const CSRF_COOKIE = 'csrftoken=csrf-falso-e2e032';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEADER_ROWS = 6;
const NOME_PACIENTE = 'Paciente Sintetico QA';
const NOME_PRESTADOR = 'Prestador Sintetico QA';

// ─── O Ana Care falso ────────────────────────────────────────────────────────────────────────

interface FakeShift {
  id: number;
  start: string;
  end: string;
  month: string;
}

/** UM paciente do universo Enlite (agency 116) e UM prestador (o nome exibido é `first_name` + `surname`, ver `minimizeShiftDTO`); `start`/`end` com offset `-06:00` como a fonte envia. */
const SHIFTS: FakeShift[] = [
  { id: 910001, start: '2026-08-31T08:00:00-06:00', end: '2026-08-31T16:00:00-06:00', month: '2026-08' },
  { id: 910002, start: '2026-09-15T08:00:00-06:00', end: '2026-09-15T16:00:00-06:00', month: '2026-09' },
  { id: 910003, start: '2026-09-30T08:00:00-06:00', end: '2026-09-30T16:00:00-06:00', month: '2026-09' },
  { id: 910004, start: '2026-09-30T22:00:00-06:00', end: '2026-10-01T10:00:00-06:00', month: '2026-10' }, // noturno cruzando a meia-noite
  { id: 910005, start: '2026-10-01T08:00:00-06:00', end: '2026-10-01T16:00:00-06:00', month: '2026-10' },
  { id: 910006, start: '2026-10-02T08:00:00-06:00', end: '2026-10-02T16:00:00-06:00', month: '2026-10' },
];

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
    patient: { id: Number(PATIENT_ID), agency: ENLITE_AGENCY, identification_type: null, identification_number: null, first_name: 'Paciente Sintetico', last_name: '', surname: 'QA' },
    nurse: { id: Number(NURSE_ID), agency: ENLITE_AGENCY, first_name: 'Prestador Sintetico', last_name: '', surname: 'QA' },
  };
}

const dayOf = (iso: string): string => iso.slice(0, 10);

interface ShiftsRequest {
  query: Record<string, string>;
}

function createFakeAnaCare(received: ShiftsRequest[], estado: { falhar: boolean }): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authenticated = (req.headers.cookie ?? '').includes(SESSION_COOKIE);
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      if (url.pathname === '/users/admin/login/') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `${CSRF_COOKIE}; Path=/` });
          res.end('<form></form>');
          return;
        }
        const form = new URLSearchParams(body);
        const csrfOk = form.get('csrfmiddlewaretoken') === 'csrf-falso-e2e032' && (req.headers.cookie ?? '').includes(CSRF_COOKIE);
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

      if (url.pathname === '/api/shifts/') {
        const q = Object.fromEntries(url.searchParams.entries());
        received.push({ query: q });
        if (estado.falhar) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'erro interno simulado' }));
          return;
        }
        // Semântica MEDIDA em 01/10/2026: dia local do `start`, `max_date` EXCLUSIVO.
        let rows = SHIFTS.filter((s) => {
          const day = dayOf(s.start);
          if (q.min_date && day < q.min_date) return false;
          if (q.max_date && day >= q.max_date) return false;
          return true;
        });
        if (q.patient) rows = rows.filter(() => q.patient === PATIENT_ID);

        const page = Number(q.page ?? 1);
        const pageSize = Number(q.page_size ?? 100);
        const slice = rows.slice((page - 1) * pageSize, page * pageSize);
        const hasNext = page * pageSize < rows.length;
        const nextParams = new URLSearchParams(url.searchParams);
        nextParams.set('page', String(page + 1));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          count: rows.length,
          next: hasNext ? `http://${req.headers.host}/api/shifts/?${nextParams.toString()}` : null,
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

describe('spec 032 F1 — exportação com a FONTE REAL (Ana Care falso de sessão, cliente/banco/HTTP reais)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  let fakeServer: http.Server;
  const received: ShiftsRequest[] = [];
  const estado = { falhar: false };

  const U = { comNome: 'exp-032r-com-nome', semNome: 'exp-032r-sem-nome' };
  const GRUPOS = { comNome: 'EXP 032R Com Nome', semNome: 'EXP 032R Sem Nome' };
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function baixar(uid: string, desde: string, hasta: string): Promise<{ status: number; headers: Headers; buffer: Buffer }> {
    const res = await fetch(`${app.url}/api/admin/anacare-hours/patients/${PATIENT_ID}/export?desde=${desde}&hasta=${hasta}`, {
      headers: { Authorization: tokenMock(uid) },
    });
    return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  }

  function abas(buffer: Buffer): { sintetico: (string | number)[][]; analitico: (string | number)[][] } {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const rows = (n: string) => XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[n], { header: 1, defval: '' });
    return { sintetico: rows('Sintético'), analitico: rows('Analítico') };
  }
  const turnos = (rows: (string | number)[][]) => rows.slice(HEADER_ROWS + 1).filter((r) => r[0] !== 'Total');

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'exp-032r-com-nome@e2e.local', 'Financeiro Sintético QA', 'admin', 'ACTIVE', true, $3),
         ($2, 'exp-032r-sem-nome@e2e.local', 'Financeira Sintética QA', 'admin', 'ACTIVE', true, $3)`,
      [U.comNome, U.semNome, TENANT_E2E],
    );
    for (const [resource, action, category] of [
      ['anacare_hours', 'read', 'Pacientes'],
      ['anacare_hours', 'export', 'Pacientes'],
      ['patient_identity', 'read', 'Pacientes'],
      ['worker_contact', 'read', 'Prestadores'],
    ] as const) {
      await garantirCelula(pool, { resource, action, category });
    }
    await grupoComCelulas(pool, {
      nome: GRUPOS.comNome,
      uid: U.comNome,
      celulas: [['anacare_hours', 'read'], ['anacare_hours', 'export'], ['patient_identity', 'read'], ['worker_contact', 'read']],
    });
    await grupoComCelulas(pool, { nome: GRUPOS.semNome, uid: U.semNome, celulas: [['anacare_hours', 'read'], ['anacare_hours', 'export']] });

    fakeServer = createFakeAnaCare(received, estado);
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

    const anacareHours = await import('@modules/anacare-hours');
    anacareHours.AnaCareHoursSyncController.resetSharedRunnerForTests();

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', anacareHours.createAnaCareHoursRoutes(new anacareHours.AnaCareHoursController(), auth, permissions)),
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
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('(iii) COM patient_identity:read + worker_contact:read: o NOME aparece no cabeçalho, no Analítico e no nome do arquivo', async () => {
    const res = await baixar(U.comNome, '2026-09-01', '2026-09-30');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(XLSX_MIME);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Paciente_Sintetico_QA-2026-09-01-2026-09-30.xlsx"');
    const { sintetico, analitico } = abas(res.buffer);
    expect(sintetico[0].slice(0, 2)).toEqual(['Paciente', NOME_PACIENTE]);
    expect(analitico[0].slice(0, 2)).toEqual(['Paciente', NOME_PACIENTE]);
    expect(turnos(analitico).map((r) => r[1])).toEqual([NOME_PRESTADOR, NOME_PRESTADOR, NOME_PRESTADOR]);
    expect(turnos(sintetico)[0][0]).toBe(NOME_PRESTADOR);
  });

  it('(iii) SEM as células de nome: "Sin vínculo · ID <id>" no cabeçalho, no Analítico e no nome do arquivo — e nenhum nome em lugar nenhum do arquivo', async () => {
    const res = await baixar(U.semNome, '2026-09-01', '2026-09-30');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Sin_vinculo_ID_${PATIENT_ID}-2026-09-01-2026-09-30.xlsx"`);
    const { sintetico, analitico } = abas(res.buffer);
    expect(sintetico[0].slice(0, 2)).toEqual(['Paciente', `Sin vínculo · ID ${PATIENT_ID}`]);
    expect(analitico[0].slice(0, 2)).toEqual(['Paciente', `Sin vínculo · ID ${PATIENT_ID}`]);
    expect(turnos(analitico).map((r) => r[1])).toEqual([`Sin vínculo · ID ${NURSE_ID}`, `Sin vínculo · ID ${NURSE_ID}`, `Sin vínculo · ID ${NURSE_ID}`]);
    const tudo = JSON.stringify([sintetico, analitico]) + (res.headers.get('content-disposition') ?? '');
    expect(tudo).not.toMatch(/Paciente Sintetico|Prestador Sintetico|Sintetico/);
  });

  it('o mês inteiro traz só os 3 turnos de setembro (15/09 e os 2 de 30/09; 31/08 e 01/10 ficam fora) — 8h + 8h + 12h', async () => {
    const { sintetico, analitico } = abas((await baixar(U.comNome, '2026-09-01', '2026-09-30')).buffer);
    expect(turnos(analitico).map((r) => r[0])).toEqual(['15/09/2026', '30/09/2026', '30/09/2026']);
    expect(Number(sintetico.slice(HEADER_ROWS + 1).find((r) => r[0] === 'Total')![2])).toBe(28);
  });

  it('(v) desde=hasta=2026-09-30 traz os 2 turnos de 30/09, o noturno (22:00 → 10:00 do dia seguinte) ancorado no dia em que COMEÇA', async () => {
    const { analitico } = abas((await baixar(U.comNome, '2026-09-30', '2026-09-30')).buffer);
    const linhas = turnos(analitico);
    expect(linhas).toHaveLength(2);
    expect(linhas.map((r) => r[0])).toEqual(['30/09/2026', '30/09/2026']);
    const noturno = linhas.find((r) => r[2] === '22:00')!;
    expect(noturno).toBeDefined();
    expect(noturno[3]).toBe('10:00 (+1 día)');
    expect(Number(noturno[7])).toBe(12);
  });

  it('(v) desde=hasta=2026-10-01 NÃO traz o noturno de 30/09 — só o turno de 01/10', async () => {
    const { analitico } = abas((await baixar(U.comNome, '2026-10-01', '2026-10-01')).buffer);
    const linhas = turnos(analitico);
    expect(linhas).toHaveLength(1);
    expect(linhas[0][0]).toBe('01/10/2026');
    expect(linhas[0][2]).toBe('08:00');
    expect(linhas.some((r) => r[2] === '22:00')).toBe(false);
  });

  it('(vi) hasta=2026-09-30 ⇒ o Ana Care falso recebeu max_date=2026-10-01 em TODOS os GET de /api/shifts/ (Hasta inclusivo → fim exclusivo)', async () => {
    received.length = 0;
    const res = await baixar(U.comNome, '2026-09-01', '2026-09-30');
    expect(res.status).toBe(200);
    // eslint-disable-next-line no-console
    console.log('[e2e032 (vi)] queries recebidas em /api/shifts/:', JSON.stringify(received.map((r) => r.query)));

    expect(received.length).toBeGreaterThanOrEqual(1); // contagem zero é falha
    for (const r of received) {
      expect(r.query.min_date).toBe('2026-09-01');
      expect(r.query.max_date).toBe('2026-10-01');
      expect(r.query.patient).toBe(PATIENT_ID);
    }
  });

  it('fonte fora do ar (5xx): resposta de erro i18n-able, NENHUM xlsx e nenhum Content-Disposition de arquivo', async () => {
    estado.falhar = true;
    try {
      const res = await baixar(U.comNome, '2026-09-01', '2026-09-30');
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.headers.get('content-type')).not.toBe(XLSX_MIME);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(() => XLSX.read(res.buffer, { type: 'buffer' }).SheetNames).not.toContain('Sintético');
    } finally {
      estado.falhar = false;
    }
  }, 90000);
});
