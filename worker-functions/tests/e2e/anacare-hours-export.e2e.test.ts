/**
 * Spec 032 (F1, T1.8) — exportação das horas do Ana Care para o financeiro, com o ENGINE DE
 * PERMISSÃO LIGADO (família `admin.patients`), HTTP real, banco real, adapter FALSO
 * (`ANACARE_HOURS_SOURCE=fake`, massa sintética, a MESMA da stage).
 *
 * O que ESTE arquivo prova (o Fake não tem nome de paciente nem turno de meia-noite — isso é do
 * `anacare-hours-export-fonte-real.e2e.test.ts`, com cliente real contra servidor HTTP embutido):
 *   (i)   soma da aba Sintético = soma da aba Analítico = `totalHours` do mesmo período, calculada
 *         AQUI a partir de `FakeAnaCareShiftsSource.generateMonth` filtrado (não do builder);
 *   (ii)  403 sem `anacare_hours:export` (só `read` não basta) e 200 com;
 *   (iv)  UMA linha em `resource_access_log` (`anacare_patient`, id da fonte, ação enumerada,
 *         operador = ator) e NENHUMA coluna com nome/`Sin vínculo`;
 *   cabeçalho `Sin vínculo · ID AC-PAT-0` e nome do arquivo `Sin_vinculo_ID_ACPAT0-…xlsx`;
 *   o turno do dia do Hasta (30/09, `FAKE-2026-09-0-1-4`) entra, e Hasta=29/09 o tira;
 *   400 para 63 dias; período sem turnos devolve o arquivo "Sin turnos en el período" (total 0) e
 *   a trilha É gravada.
 */
import { Pool } from 'pg';
import * as XLSX from 'xlsx';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const PATIENT = 'AC-PAT-0';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HEADER_ROWS = 6; // 5 linhas de cabeçalho + título da aba; a linha 7 é o cabeçalho da tabela

describe('spec 032 F1 — exportação xlsx das horas (engine ligado, banco real, adapter falso)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = { exporta: 'exp-032-exporta', soLeitura: 'exp-032-so-leitura' };
  const GRUPOS = { exporta: 'EXP 032 Exporta', soLeitura: 'EXP 032 So Leitura' };
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  const urlExport = (patientId: string, desde: string, hasta: string): string =>
    `/api/admin/anacare-hours/patients/${patientId}/export?desde=${desde}&hasta=${hasta}`;

  async function baixar(caminho: string, uid: string): Promise<{ status: number; headers: Headers; buffer: Buffer }> {
    const res = await fetch(`${app.url}${caminho}`, { headers: { Authorization: tokenMock(uid) } });
    return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  }

  function abas(buffer: Buffer): { nomes: string[]; sintetico: (string | number)[][]; analitico: (string | number)[][] } {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const rows = (n: string) => XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[n], { header: 1, defval: '' });
    return { nomes: wb.SheetNames, sintetico: rows('Sintético'), analitico: rows('Analítico') };
  }

  const corpo = (rows: (string | number)[][]) => rows.slice(HEADER_ROWS + 1);
  const semTotal = (rows: (string | number)[][]) => corpo(rows).filter((r) => r[0] !== 'Total');

  /** `totalHours` independente do builder: horas REAIS (check-in→checkout, 2 casas) dos turnos do paciente no período. */
  async function totalEsperado(desde: string, hasta: string): Promise<{ total: number; turnos: number }> {
    const { FakeAnaCareShiftsSource } = await import('@modules/anacare-hours/infrastructure/FakeAnaCareShiftsSource');
    const turnos = FakeAnaCareShiftsSource.generateMonth('2026-09').filter((s) => s.anaCarePatientId === PATIENT && s.date >= desde && s.date <= hasta);
    const horas = turnos.map((s) => (s.actualStart && s.actualEnd ? Math.round(((new Date(s.actualEnd).getTime() - new Date(s.actualStart).getTime()) / 3_600_000) * 100) / 100 : 0));
    return { total: Math.round(horas.reduce((a, b) => a + b, 0) * 100) / 100, turnos: turnos.length };
  }

  /** A trilha grava DEPOIS do `finish` da resposta — espera a linha aparecer (até ~5 s). */
  async function linhasDeTrilha(uid: string, action: string): Promise<Array<Record<string, unknown>>> {
    for (let i = 0; i < 50; i += 1) {
      const r = await pool.query(`SELECT * FROM resource_access_log WHERE operator_uid = $1 AND action = $2`, [uid, action]);
      if (r.rowCount) return r.rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return [];
  }

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'exp-032-exporta@e2e.local', 'Financeiro Sintético QA', 'admin', 'ACTIVE', true, $3),
         ($2, 'exp-032-so-leitura@e2e.local', 'Leitora Sintética QA', 'admin', 'ACTIVE', true, $3)`,
      [U.exporta, U.soLeitura, TENANT_E2E],
    );
    for (const acao of ['read', 'export']) await garantirCelula(pool, { resource: 'anacare_hours', action: acao, category: 'Pacientes' });
    await grupoComCelulas(pool, { nome: GRUPOS.exporta, uid: U.exporta, celulas: [['anacare_hours', 'read'], ['anacare_hours', 'export']] });
    await grupoComCelulas(pool, { nome: GRUPOS.soLeitura, uid: U.soLeitura, celulas: [['anacare_hours', 'read']] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('ANACARE_HOURS_SOURCE', 'fake');

    const anacareHours = await import('@modules/anacare-hours');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', anacareHours.createAnaCareHoursRoutes(new anacareHours.AnaCareHoursController(), auth, permissions)),
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('(i) AC-PAT-0 em 2026-09: soma do Sintético = soma do Analítico = totalHours calculado pelo teste; 2 abas; Content-Type xlsx', async () => {
    const res = await baixar(urlExport(PATIENT, '2026-09-01', '2026-09-30'), U.exporta);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(XLSX_MIME);

    const { nomes, sintetico, analitico } = abas(res.buffer);
    expect(nomes).toEqual(['Sintético', 'Analítico']);

    const esperado = await totalEsperado('2026-09-01', '2026-09-30');
    const somaSintetico = Math.round(semTotal(sintetico).reduce((a, r) => a + Number(r[2]), 0) * 100) / 100;
    const somaAnalitico = Math.round(semTotal(analitico).reduce((a, r) => a + Number(r[7]), 0) * 100) / 100;
    // eslint-disable-next-line no-console
    console.log(`[e2e032 (i)] sintetico=${somaSintetico} analitico=${somaAnalitico} totalHours=${esperado.total} turnos=${esperado.turnos}`);

    expect(esperado.turnos).toBe(10); // contagem zero é falha: AC-PAT-0 tem 10 turnos em setembro
    expect(esperado.total).toBeGreaterThan(0);
    expect(somaSintetico).toBe(esperado.total);
    expect(somaAnalitico).toBe(esperado.total);
    // A linha Total do Sintético confere com as linhas por prestador.
    const total = corpo(sintetico).find((r) => r[0] === 'Total')!;
    expect(Number(total[1])).toBe(esperado.turnos);
    expect(Number(total[2])).toBe(esperado.total);
    expect(semTotal(analitico)).toHaveLength(esperado.turnos);
  });

  it('(ii) sem anacare_hours:export → 403 (só read não basta); com ela → 200', async () => {
    const negado = await baixar(urlExport(PATIENT, '2026-09-01', '2026-09-30'), U.soLeitura);
    expect(negado.status).toBe(403);
    expect(negado.headers.get('content-type')).not.toBe(XLSX_MIME);
    const ok = await baixar(urlExport(PATIENT, '2026-09-01', '2026-09-30'), U.exporta);
    expect(ok.status).toBe(200);
  });

  it('(iv) trilha: 1 linha em resource_access_log (anacare_patient, id da fonte, ação enumerada, operador = ator), sem nome nenhum; 403 não grava', async () => {
    const acao = 'export_xlsx:ambos:2026-09-02:2026-09-04';
    const negado = await baixar(urlExport(PATIENT, '2026-09-02', '2026-09-04'), U.soLeitura);
    expect(negado.status).toBe(403);
    const res = await baixar(urlExport(PATIENT, '2026-09-02', '2026-09-04'), U.exporta);
    expect(res.status).toBe(200);

    const linhas = await linhasDeTrilha(U.exporta, acao);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ resource_type: 'anacare_patient', resource_id: PATIENT, action: acao, operator_uid: U.exporta });
    // Nenhuma coluna carrega nome nem o rótulo do arquivo.
    const tudo = JSON.stringify(linhas[0]);
    expect(tudo).not.toContain('Sin vínculo');
    expect(tudo).not.toMatch(/Paciente|Prestador|Sintético|Sintetico/);
    // O 403 não deixa linha (o positivo acima já esperou a gravação assíncrona; aqui basta 1 consulta).
    const doNegado = await pool.query(`SELECT 1 FROM resource_access_log WHERE operator_uid = $1`, [U.soLeitura]);
    expect(doNegado.rowCount).toBe(0);
  });

  it('sem patient_identity:read o cabeçalho é "Sin vínculo · ID AC-PAT-0" e o nome do arquivo usa o MESMO rótulo (ASCII)', async () => {
    const res = await baixar(urlExport(PATIENT, '2026-09-01', '2026-09-30'), U.exporta);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Sin_vinculo_ID_ACPAT0-2026-09-01-2026-09-30.xlsx"');
    expect(res.headers.get('x-export-filename')).toBe('Sin_vinculo_ID_ACPAT0-2026-09-01-2026-09-30.xlsx');
    const { sintetico, analitico } = abas(res.buffer);
    expect(sintetico[0].slice(0, 2)).toEqual(['Paciente', 'Sin vínculo · ID AC-PAT-0']);
    expect(analitico[0].slice(0, 2)).toEqual(['Paciente', 'Sin vínculo · ID AC-PAT-0']);
    expect(sintetico[4][0]).toBe('Documento confidencial');
  });

  it('o turno do dia do Hasta (30/09, FAKE-2026-09-0-1-4) entra com Hasta=30/09 e sai com Hasta=29/09', async () => {
    const com = abas((await baixar(urlExport(PATIENT, '2026-09-01', '2026-09-30'), U.exporta)).buffer);
    const sem = abas((await baixar(urlExport(PATIENT, '2026-09-01', '2026-09-29'), U.exporta)).buffer);
    expect(semTotal(com.analitico).map((r) => r[0])).toContain('30/09/2026');
    expect(semTotal(com.analitico)).toHaveLength(10);
    expect(semTotal(sem.analitico).map((r) => r[0])).not.toContain('30/09/2026');
    expect(semTotal(sem.analitico)).toHaveLength(9);
  });

  it('400 para 63 dias (62 passa) — nunca arquivo', async () => {
    const longo = await baixar(urlExport(PATIENT, '2026-09-01', '2026-11-02'), U.exporta);
    expect(longo.status).toBe(400);
    expect(longo.headers.get('content-type')).not.toBe(XLSX_MIME);
    const limite = await baixar(urlExport(PATIENT, '2026-09-01', '2026-11-01'), U.exporta);
    expect(limite.status).toBe(200);
  });

  it('período sem turnos (AC-PAT-0 em 10..20/09): 200 com "Sin turnos en el período", total 0, e a trilha É gravada', async () => {
    const acao = 'export_xlsx:ambos:2026-09-10:2026-09-20';
    const res = await baixar(urlExport(PATIENT, '2026-09-10', '2026-09-20'), U.exporta);
    expect(res.status).toBe(200);
    const { sintetico, analitico } = abas(res.buffer);
    expect(corpo(sintetico)[0][0]).toBe('Sin turnos en el período');
    expect(corpo(analitico)[0][0]).toBe('Sin turnos en el período');
    expect(corpo(sintetico).find((r) => r[0] === 'Total')!.slice(1, 5)).toEqual([0, 0, 0, 0]);
    expect(corpo(analitico).find((r) => r[0] === 'Total')![7]).toBe(0);
    expect(res.headers.get('content-disposition')).toContain('Sin_vinculo_ID_ACPAT0-2026-09-10-2026-09-20.xlsx');
    expect(await linhasDeTrilha(U.exporta, acao)).toHaveLength(1);
  });
});
