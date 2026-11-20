/**
 * Spec 092 (F2, T203, CA-3/CA-5) — as 3 rotas do prestador do informe da guarda, PELA BORDA HTTP (app real, banco real, sem mock de repositório).
 *
 * CA-3: PUT 201 / 200 / 409 daily_report_conflict / 409 daily_report_exists / 422 × os 9 códigos do contrato (+ 400 e 401/403).
 * CA-5: o texto-espião `NARRATIVA-ESPIA-092` NÃO aparece no log da API (0 ocorrências), com CONTROLE POSITIVO: o mesmo log tem o `reportId` do
 *       informe aceito (≥ 1) — prova que o captador enxerga o que a API escreve. A sabotagem (logar a narrativa) vira ≥ 1 (registrada na evidência).
 *
 * Log da API: `E2E_API_LOG_FILE` (stack local rodando em processo) ou `docker logs` do container `api` (CI). Dado 100% sintético.
 */
import axios, { AxiosResponse } from 'axios';
import { readFileSync } from 'fs';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { apiContainerLogs } from './helpers/apiContainer';
import { catalogoItens, inserirPti, semearGuarda, limparGuarda, segundaAnterior, hojeAr, type CatalogoItens, type Guarda } from './helpers/seedDailyReport092';
import { occurrenceIdOf } from '../../src/modules/case/infrastructure/WorkerItineraryReader';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ESPIA = 'NARRATIVA-ESPIA-092';
const TAG = 'e2e092-api';

const bearer = (uid: string) =>
  `Bearer mock_${Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role: 'worker', country: 'AR' })).toString('base64')}`;
const http = axios.create({ baseURL: API_URL, validateStatus: () => true });
const as = (uid: string) => ({ headers: { Authorization: bearer(uid) } });

function apiLog(): string {
  return process.env.E2E_API_LOG_FILE ? readFileSync(process.env.E2E_API_LOG_FILE, 'utf8') : apiContainerLogs();
}
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('informe da guarda — rotas do prestador pela borda HTTP (spec 092) @integration', () => {
  let pool: Pool;
  let cat: CatalogoItens;
  let a: Guarda; // fluxo principal
  let ptiA: string;
  let occA: string;
  let b: Guarda; // matriz de 422
  let ptiB: string;
  let occB: string;
  let occBClosed: string; // guarda de 2 semanas atrás: fora da janela de aceite
  let ptiOutroServico: string;
  let occAnul: string; // guardas de pacientes sem PTI vigente: só ANULADA / só VENCIDA
  let ptiAnulada: string;
  let occVenc: string;
  let ptiVencida: string;
  let dd: Guarda; // PTI vigente + relato null (offline-first)
  let occDd: string;
  let anul: Guarda;
  let venc: Guarda;

  const answersOk = () => [
    { objectiveId: cat.objAut, scaleCode: 'AUT', optionCode: 'no_lo_hizo', reasonCode: 'rechazo' },
    { objectiveId: cat.objSn, scaleCode: 'SN', optionCode: 'si' },
    { objectiveId: cat.objCnt, scaleCode: 'CNT', countValue: 3 },
    { activityId: cat.actSn, scaleCode: 'SN', optionCode: 'no' },
  ];
  const body = (occurrenceId: string, ptiVersionId: string | null, over: Record<string, unknown> = {}) => ({
    occurrenceId, ptiVersionId, narrative: ESPIA, narrativeSource: 'TYPED', deviceSubmittedAt: new Date().toISOString(), appVersion: '1.0.0', answers: answersOk(), ...over,
  });
  const put = (uid: string, id: string, b2: unknown): Promise<AxiosResponse> => http.put(`/api/workers/me/daily-reports/${id}`, b2, as(uid));

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    await limparGuarda(pool, TAG);
    cat = await catalogoItens(pool);
    const hoje = await hojeAr(pool);
    const itens = { objectiveIds: [cat.objAut, cat.objSn, cat.objCnt, cat.objOm, cat.objSemPergunta], activityIds: [cat.actSn, cat.actSemEscala] };

    a = await semearGuarda(pool, `${TAG}-a`);
    ptiA = await inserirPti(pool, { patientId: a.patientId, serviceId: a.serviceId, start: '2026-01-01', end: '2027-12-31', ...itens });
    // 2º serviço do MESMO paciente, com PTI mais novo e só 1 objetivo: nunca pode vazar para a guarda do 1º serviço
    const s2 = await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, country, created_by, updated_by) VALUES ($1, 'AT', 'AR', $2, $2) RETURNING id`, [a.patientId, TAG]);
    await inserirPti(pool, { patientId: a.patientId, serviceId: s2.rows[0].id, start: '2026-01-01', end: '2027-12-31', objectiveIds: [cat.objSemPergunta], activityIds: [cat.actSn], major: 2, createdAt: new Date(Date.now() + 60_000).toISOString() });
    occA = occurrenceIdOf(a.slotSegId, a.onDate, a.workerId);

    b = await semearGuarda(pool, `${TAG}-b`);
    ptiB = await inserirPti(pool, { patientId: b.patientId, serviceId: b.serviceId, start: '2026-01-01', end: '2027-12-31', ...itens });
    occB = occurrenceIdOf(b.slotSegId, b.onDate, b.workerId);
    const fechada = await segundaAnterior(pool, hoje, 2);
    occBClosed = occurrenceIdOf(b.slotSegId, fechada, b.workerId);
    // PTI de OUTRO paciente/serviço (para pti_version_mismatch)
    ptiOutroServico = await inserirPti(pool, { patientId: a.patientId, serviceId: s2.rows[0].id, start: '2026-02-01', end: '2027-12-31', major: 3, objectiveIds: [cat.objSn], activityIds: [cat.actSn] });

    dd = await semearGuarda(pool, `${TAG}-dd`);
    await inserirPti(pool, { patientId: dd.patientId, serviceId: dd.serviceId, start: '2026-01-01', end: '2027-12-31', ...itens });
    occDd = occurrenceIdOf(dd.slotSegId, dd.onDate, dd.workerId);
    anul = await semearGuarda(pool, `${TAG}-anul`);
    ptiAnulada = await inserirPti(pool, { patientId: anul.patientId, serviceId: anul.serviceId, start: '2026-01-01', end: '2027-12-31', annulled: true, ...itens });
    occAnul = occurrenceIdOf(anul.slotSegId, anul.onDate, anul.workerId);
    venc = await semearGuarda(pool, `${TAG}-venc`);
    ptiVencida = await inserirPti(pool, { patientId: venc.patientId, serviceId: venc.serviceId, start: '2025-01-01', end: '2025-12-31', ...itens });
    occVenc = occurrenceIdOf(venc.slotSegId, venc.onDate, venc.workerId);
  });
  afterAll(async () => {
    await limparGuarda(pool, TAG);
    await pool.end();
  });

  describe('GET /api/workers/me/daily-report-scales', () => {
    it('401 sem token; 200 com as 18 escalas, ETag, e 304 com If-None-Match', async () => {
      expect((await http.get('/api/workers/me/daily-report-scales')).status).toBe(401);
      const r = await http.get('/api/workers/me/daily-report-scales', as(a.authUid));
      expect(r.status).toBe(200);
      expect(r.data.scales).toHaveLength(18);
      const aut = r.data.scales.find((s: { code: string }) => s.code === 'AUT');
      expect(aut.options.find((o: { code: string }) => o.code === 'no_lo_hizo')).toMatchObject({ asksReason: true });
      expect(aut.reasons).toHaveLength(5);
      expect(r.headers.etag).toBe(`"${r.data.version}"`);
      const again = await http.get('/api/workers/me/daily-report-scales', { headers: { ...as(a.authUid).headers, 'If-None-Match': r.headers.etag } });
      expect(again.status).toBe(304);
    });
  });

  describe('GET /api/workers/me/daily-report-templates', () => {
    it('molde da guarda: PTI do SERVIÇO da guarda (não o mais novo do outro serviço), sem OM/legado, atividade sem escala vira SN, sem dado do paciente', async () => {
      const r = await http.get(`/api/workers/me/daily-report-templates?from=${a.onDate}&to=${a.onDate}`, as(a.authUid));
      expect(r.status).toBe(200);
      expect(r.data.items).toHaveLength(1);
      const t = r.data.items[0];
      expect(t.occurrenceId).toBe(occA);
      expect(t.ptiVersionId).toBe(ptiA);
      expect(t.objectives.map((o: { id: string }) => o.id).sort()).toEqual([cat.objAut, cat.objSn, cat.objCnt].sort());
      expect(t.activities.map((x: { id: string; scaleCode: string }) => [x.id, x.scaleCode]).sort()).toEqual([[cat.actSemEscala, 'SN'], [cat.actSn, 'SN']].sort());
      expect(Date.parse(t.dueAt)).toBeGreaterThan(Date.parse(`${a.onDate}T00:00:00Z`));
      const wire = JSON.stringify(r.data);
      for (const proibido of ['patient_id', 'patientId', 'diagnos', 'clinical_context', 'general_objective', a.patientId]) expect(wire).not.toContain(proibido);
    });
    it('400 em janela inválida (from > to, mais de 9 dias, formato); outro prestador não vê a guarda dele', async () => {
      expect((await http.get(`/api/workers/me/daily-report-templates?from=${a.onDate}&to=2020-01-01`, as(a.authUid))).status).toBe(400);
      expect((await http.get(`/api/workers/me/daily-report-templates?from=2026-01-01&to=2026-02-01`, as(a.authUid))).status).toBe(400);
      expect((await http.get(`/api/workers/me/daily-report-templates?from=ontem&to=hoje`, as(a.authUid))).status).toBe(400);
      const alheio = await http.get(`/api/workers/me/daily-report-templates?from=${a.onDate}&to=${a.onDate}`, as(b.authUid));
      expect(alheio.data.items.map((i: { occurrenceId: string }) => i.occurrenceId)).not.toContain(occA);
    });
  });

  describe('PUT /api/workers/me/daily-reports/:id — fluxo feliz e idempotência', () => {
    const id = uuidv4();
    it('401 sem token; 400 com corpo inválido (só caminhos, nunca o valor); 403 conta desativada', async () => {
      expect((await http.put(`/api/workers/me/daily-reports/${id}`, body(occA, ptiA))).status).toBe(401);
      const ruim = await put(a.authUid, id, { ...body(occA, ptiA), narrative: '   ', narrativeSource: ESPIA });
      expect(ruim.status).toBe(400);
      expect(ruim.data.details).toEqual(expect.arrayContaining(['narrative', 'narrativeSource']));
      expect(JSON.stringify(ruim.data)).not.toContain(ESPIA);
      expect((await put(a.authUid, 'nao-e-uuid', body(occA, ptiA))).status).toBe(400);
      const inativo = `${TAG}-disabled`;
      await pool.query(`INSERT INTO workers (auth_uid, email, country, status, occupation) VALUES ($1, $2, 'AR', 'DISABLED', 'AT')`, [inativo, `${inativo}@e2e.local`]);
      const r = await put(inativo, id, body(occA, ptiA));
      expect([r.status, r.data.code]).toEqual([403, 'ACCOUNT_INACTIVE']);
    });
    it('201 cria; o banco tem 1 informe e 4 respostas, e a nota sai por join (DC-6)', async () => {
      const r = await put(a.authUid, id, body(occA, ptiA));
      expect([r.status, r.data]).toEqual([201, { id }]);
      const n = await pool.query(`SELECT (SELECT count(*) FROM daily_reports WHERE id = $1)::int AS r, (SELECT count(*) FROM daily_report_answers WHERE report_id = $1)::int AS a`, [id]);
      expect(n.rows[0]).toEqual({ r: 1, a: 4 });
      const rep = await pool.query(`SELECT worker_id, slot_id, to_char(on_date, 'YYYY-MM-DD') AS d, pti_version_id FROM daily_reports WHERE id = $1`, [id]);
      expect(rep.rows[0]).toEqual({ worker_id: a.workerId, slot_id: a.slotSegId, d: a.onDate, pti_version_id: ptiA });
    });
    it('200 no retry idêntico (nada duplica)', async () => {
      const igual = body(occA, ptiA);
      const first = await http.get(`/api/workers/me/daily-report-scales`, as(a.authUid));
      expect(first.status).toBe(200);
      const original = (await pool.query(`SELECT device_submitted_at, app_version, narrative_source FROM daily_reports WHERE id = $1`, [id])).rows[0];
      const r = await put(a.authUid, id, { ...igual, deviceSubmittedAt: original.device_submitted_at.toISOString(), appVersion: original.app_version, narrativeSource: original.narrative_source });
      expect([r.status, r.data]).toEqual([200, { id }]);
      expect(Number((await pool.query(`SELECT count(*) AS n FROM daily_reports WHERE worker_id = $1`, [a.workerId])).rows[0].n)).toBe(1);
    });
    it('409 daily_report_conflict: mesmo id, narrativa diferente', async () => {
      const r = await put(a.authUid, id, { ...body(occA, ptiA), narrative: `${ESPIA} outra` });
      expect([r.status, r.data.code]).toEqual([409, 'daily_report_conflict']);
      expect(JSON.stringify(r.data)).not.toContain(ESPIA);
    });
    it('409 daily_report_exists: outro id para a mesma guarda', async () => {
      const r = await put(a.authUid, uuidv4(), body(occA, ptiA));
      expect([r.status, r.data.code]).toEqual([409, 'daily_report_exists']);
    });
  });

  describe('PUT — os 9 códigos 422 (corpo nunca ecoa narrativa nem respostas)', () => {
    const codeOf = async (occ: string, pti: string | null, over: Record<string, unknown> = {}) => {
      const r = await put(b.authUid, uuidv4(), body(occ, pti, over));
      expect(JSON.stringify(r.data)).not.toContain(ESPIA);
      return [r.status, r.data.code];
    };
    it('occurrence_unknown: guarda inexistente e guarda de OUTRO prestador', async () => {
      expect(await codeOf(uuidv4(), ptiB)).toEqual([422, 'occurrence_unknown']);
      expect(await codeOf(occA, ptiB)).toEqual([422, 'occurrence_unknown']);
    });
    it('daily_report_window_closed: guarda de 2 semanas atrás (prazo + 7 dias vencido)', async () => {
      expect(await codeOf(occBClosed, ptiB)).toEqual([422, 'daily_report_window_closed']);
    });
    it('pti_version_mismatch: versão inexistente e versão de OUTRO serviço', async () => {
      expect(await codeOf(occB, uuidv4())).toEqual([422, 'pti_version_mismatch']);
      expect(await codeOf(occB, ptiOutroServico)).toEqual([422, 'pti_version_mismatch']);
    });
    it('pti_version_mismatch pela vigência: PTI ANULADO e PTI VENCIDO (endDate < data) não valem; sem vigente, só relato (null) passa', async () => {
      const tenta = async (g: Guarda, occ: string, pti: string | null, answers: unknown[]) => {
        const r = await put(g.authUid, uuidv4(), body(occ, pti, { answers }));
        expect(JSON.stringify(r.data)).not.toContain(ESPIA);
        return [r.status, r.data.code];
      };
      expect(await tenta(anul, occAnul, ptiAnulada, answersOk())).toEqual([422, 'pti_version_mismatch']);
      expect(await tenta(venc, occVenc, ptiVencida, answersOk())).toEqual([422, 'pti_version_mismatch']);
      expect((await tenta(anul, occAnul, null, []))[0]).toBe(201); // controle: sem vigente, relato puro é aceito
      expect((await tenta(venc, occVenc, null, []))[0]).toBe(201);
    });
    it('DC-4 offline-first: ptiVersionId null com PTI VIGENTE → 201 só relato (sem respostas)', async () => {
      const r = await put(dd.authUid, uuidv4(), body(occDd, null, { answers: [] }));
      expect(r.status).toBe(201);
      expect((await pool.query(`SELECT pti_version_id FROM daily_reports WHERE worker_id = $1`, [dd.workerId])).rows[0].pti_version_id).toBeNull();
    });
    it('item_not_in_pti: objetivo OM, objetivo legado e atividade fora do PTI', async () => {
      expect(await codeOf(occB, ptiB, { answers: [...answersOk(), { objectiveId: cat.objOm, scaleCode: 'OM', optionCode: 'x' }] })).toEqual([422, 'item_not_in_pti']);
      expect(await codeOf(occB, ptiB, { answers: [...answersOk(), { objectiveId: cat.objSemPergunta, scaleCode: 'SN', optionCode: 'si' }] })).toEqual([422, 'item_not_in_pti']);
      expect(await codeOf(occB, null)).toEqual([422, 'item_not_in_pti']); // null + respostas: relato não carrega resposta, mesmo com PTI vigente
    });
    it('scale_mismatch, option_unknown, reason_required, reason_not_allowed', async () => {
      const trocar = (i: number, over: Record<string, unknown>) => answersOk().map((x, k) => (k === i ? { ...x, ...over } : x));
      expect(await codeOf(occB, ptiB, { answers: trocar(1, { scaleCode: 'AUT' }) })).toEqual([422, 'scale_mismatch']);
      expect(await codeOf(occB, ptiB, { answers: trocar(1, { optionCode: 'talvez' }) })).toEqual([422, 'option_unknown']);
      expect(await codeOf(occB, ptiB, { answers: trocar(0, { reasonCode: undefined }) })).toEqual([422, 'reason_required']);
      expect(await codeOf(occB, ptiB, { answers: trocar(0, { optionCode: 'solo' }) })).toEqual([422, 'reason_not_allowed']);
    });
    it('objective_answer_missing: objetivo do molde sem resposta (DC-8)', async () => {
      expect(await codeOf(occB, ptiB, { answers: answersOk().slice(0, 2) })).toEqual([422, 'objective_answer_missing']);
    });
    it('controle positivo: o MESMO corpo válido passa (os 422 acima são pela regra, não por corpo quebrado) e DC-4 aceita só relatório', async () => {
      expect((await put(b.authUid, uuidv4(), body(occB, ptiB))).status).toBe(201);
      const c = await semearGuarda(pool, `${TAG}-c`);
      const r = await put(c.authUid, uuidv4(), body(occurrenceIdOf(c.slotSegId, c.onDate, c.workerId), null, { answers: [] }));
      expect(r.status).toBe(201);
      expect((await pool.query(`SELECT pti_version_id FROM daily_reports WHERE worker_id = $1`, [c.workerId])).rows[0].pti_version_id).toBeNull();
    });
  });

  describe('log (CA-5)', () => {
    it('0 ocorrências de NARRATIVA-ESPIA-092 no log da API depois de 201/200/400/409/422; controle positivo: o reportId aceito aparece (≥ 1)', async () => {
      const log = apiLog();
      const aceito = (await pool.query<{ id: string }>(`SELECT id FROM daily_reports WHERE worker_id = $1`, [a.workerId])).rows[0].id;
      expect(count(log, aceito)).toBeGreaterThanOrEqual(1); // controle: o captador enxerga o que a API escreve
      expect(count(log, 'daily_report_received')).toBeGreaterThanOrEqual(1);
      expect(count(log, ESPIA)).toBe(0);
    });
  });
});
