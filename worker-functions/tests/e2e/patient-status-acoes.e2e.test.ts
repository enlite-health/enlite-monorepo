/**
 * patient-status-acoes.e2e.test.ts @integration — F3 (estado-automatico-do-paciente, D5/D9): as ações dos estados humanos
 * (pausar, suspender, dar alta, dar baja, retomar, reativar) PELA BORDA: HTTP real (`POST|GET /patients/:id/status-actions`, engine de
 * permissão LIGADO) + Postgres real, sem mock. A prova é o que ficou no banco (`patients.status` e a trilha `patient_status_history`),
 * nunca só o código HTTP.
 *
 * Outbound mapeado (teste nunca toca canal real): o caminho das ações só faz SELECT/UPDATE em Postgres (lock do paciente, FSM,
 * completude, alocação, trilha por trigger). Nenhum Twilio, WhatsApp, Periskope, Talentum, Ana Care, Google ou Short.io é chamado — a
 * mudança para Alta/Baja NÃO dispara aviso nenhum (o escritor de estado não enfileira mensagem). Fixtures sintéticas (sobrenome " QA"),
 * nenhum texto clínico: a "nota" semeada é um marcador sintético e o teste prova que ele nunca volta na resposta.
 *
 * Contradição medida (LISTA da change): "retomar/reativar com itinerário cobrindo tudo → ACTIVE" (spec) e "trava de alocação viva
 * vale" (D5/D9) não coexistem — cobrir horas EXIGE alocação viva. Vence a trava (regra dura nomeada); o ACTIVE/REPLACEMENT derivado é
 * provado nos unitários (`resolverRetomada`, `PatientStatusActionUseCase`) e aqui fica provado que o 422 acontece e nada muda.
 */
import { Pool } from 'pg';
import type { AppDeFamilia } from './helpers/permissionFamilyHarness';
import { atorComCelulas, chamar, fecharApp058a, limparAtores, subirApp058a, type Celula } from './helpers/contrato058aApp';
import { DATABASE_URL } from './helpers/contrato058aDb';
import { alocar, criarCandidato, criarCenario, hojeOp, limparB, mais, novoPool, PREFIXO_058B } from './helpers/itinerario058bDb';

const COM = { uid: 'qa-f3-com-celulas', nome: 'QAF3 Com celulas' };
const SEM = { uid: 'qa-f3-sem-celulas', nome: 'QAF3 Sem celulas' };
const LEITORA = { uid: 'qa-f3-leitora', nome: 'QAF3 Leitora' };
const CELULAS_SEM: Celula[] = [['patient', 'update'], ['patient', 'read']];
const CELULAS_COM: Celula[] = [
  ...CELULAS_SEM, ['patient_clinical', 'read'],
  ['patient_status', 'move_to_on_hold'], ['patient_status', 'move_to_suspended'], ['patient_status', 'move_to_alta'], ['patient_status', 'move_to_discharged'],
];
const NOTA_SINTETICA = 'marcador-sintetico-da-nota-f3';
const AS_5_SETAS: Array<[string, string]> = [
  ['ON_HOLD', 'REPLACEMENT'], ['SUSPENDED', 'SEARCHING'], ['SUSPENDED', 'REPLACEMENT'], ['DISCHARGED', 'SEARCHING'], ['DISCHARGED', 'REPLACEMENT'],
];

describe('F3 — ações dos estados humanos pela borda (HTTP real, banco real, engine ligado) @integration', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  let seq = 0;

  const limparTudo = async (): Promise<void> => {
    const pac = `${PREFIXO_058B}-%`;
    await pool.query(`DELETE FROM patient_status_history WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [pac]);
    await pool.query(`DELETE FROM patient_itinerary_assembly WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [pac]);
    await limparB(pool);
  };

  beforeAll(async () => {
    pool = novoPool();
    await limparTudo();
    await limparAtores(pool, [COM, SEM, LEITORA]);
    await atorComCelulas(pool, COM.uid, COM.nome, CELULAS_COM);
    await atorComCelulas(pool, SEM.uid, SEM.nome, CELULAS_SEM);
    await atorComCelulas(pool, LEITORA.uid, LEITORA.nome, [['patient', 'read']]);
    app = await subirApp058a(DATABASE_URL);
  }, 60000);

  afterAll(async () => {
    await limparTudo();
    await limparAtores(pool, [COM, SEM, LEITORA]);
    await fecharApp058a(app);
    await pool.end();
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  /** Paciente SEM itinerário (nenhum serviço, nenhuma montagem) no estado dado — para "sem itinerário → SEARCHING". */
  async function pacienteSemItinerario(status: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'F3', 'Sem Itinerario QA', 'AR', $2) RETURNING id`,
      [`${PREFIXO_058B}-f3-${Date.now().toString(36)}${seq++}`, status]);
    return r.rows[0].id;
  }
  /** Paciente com itinerário MONTADO (serviço, vaga viva, 2 faixas, assembly) e zero alocação, no estado dado. */
  async function pacienteMontadoSemAlocacao(status: string): Promise<string> {
    const c = await criarCenario(pool, { faixas: 2 });
    await pool.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, 'qa-f3', 'AR')`, [c.patientId]);
    await pool.query(`UPDATE patients SET status = $2 WHERE id = $1`, [c.patientId, status]);
    return c.patientId;
  }
  /** Paciente com itinerário montado e TODAS as faixas cobertas (alocação viva), no estado dado. */
  async function pacienteCobertoComAlocacao(status: string): Promise<string> {
    const c = await criarCenario(pool, { faixas: 2 });
    const cand = await criarCandidato(pool, c);
    const hoje = await hojeOp(pool);
    for (const faixa of c.faixas) await alocar(pool, faixa, cand, await mais(pool, hoje, -3), null);
    await pool.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, 'qa-f3', 'AR')`, [c.patientId]);
    await pool.query(`UPDATE patients SET status = $2 WHERE id = $1`, [c.patientId, status]);
    return c.patientId;
  }
  const acao = (uid: string, id: string, body: unknown) => chamar(app, 'POST', `/api/admin/patients/${id}/status-actions`, uid, body);
  const lista = (uid: string, id: string) => chamar(app, 'GET', `/api/admin/patients/${id}/status-actions`, uid);
  const estado = async (id: string) => (await pool.query<{ status: string; reason: string | null; note: string | null; trilha: number }>(
    `SELECT p.status, p.on_hold_reason AS reason, p.on_hold_note AS note, (SELECT count(*)::int FROM patient_status_history WHERE patient_id = p.id) AS trilha
       FROM patients p WHERE p.id = $1`, [id])).rows[0];
  const ultima = async (id: string) => (await pool.query<{ old_value: string | null; new_value: string; change_source: string; reason: string | null }>(
    `SELECT old_value, new_value, change_source, reason FROM patient_status_history WHERE patient_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [id])).rows[0];

  // ── migration ──────────────────────────────────────────────────────────────
  it('MIGRATION 595: as 5 setas de retomada/reativação existem no catálogo da FSM', async () => {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_status_transitions WHERE (from_status, to_status) IN (${AS_5_SETAS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',')})`,
      AS_5_SETAS.flat());
    expect(r.rows[0].n).toBe(5);
  });

  // ── as 4 ações do painel ───────────────────────────────────────────────────
  it.each([
    ['pausar', 'ON_HOLD', { onHoldReason: 'SCHOOL' }],
    ['suspender', 'SUSPENDED', {}],
    ['dar_alta', 'ALTA', {}],
    ['dar_baja', 'DISCHARGED', {}],
  ] as const)('FELIZ %s: ACTIVE → %s, trilha admin_panel (de ACTIVE para o destino), 1 linha a mais', async (nome, destino, extra) => {
    const id = await pacienteSemItinerario('ACTIVE');
    const antes = await estado(id);
    const r = await acao(SEM.uid, id, { action: nome, ...extra });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id, action: nome, from: 'ACTIVE', status: destino });
    const depois = await estado(id);
    expect(depois.status).toBe(destino);
    expect(depois.trilha).toBe(antes.trilha + 1);
    expect(await ultima(id)).toMatchObject({ old_value: 'ACTIVE', new_value: destino, change_source: 'admin_panel' });
  });

  it('pausar SEM motivo → 422 ON_HOLD_REASON_REQUIRED; estado e trilha não mudam', async () => {
    const id = await pacienteSemItinerario('ACTIVE');
    const antes = await estado(id);
    const r = await acao(SEM.uid, id, { action: 'pausar' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ON_HOLD_REASON_REQUIRED');
    expect(await estado(id)).toEqual(antes);
  });

  it('ação com alocação viva → 422 PATIENT_STATUS_LOCKED_BY_ALLOCATION (só a contagem, sem nome); nada muda — nas 4 ações do painel', async () => {
    const id = await pacienteCobertoComAlocacao('ACTIVE');
    const antes = await estado(id);
    for (const corpo of [{ action: 'pausar', onHoldReason: 'SCHOOL' }, { action: 'suspender' }, { action: 'dar_alta' }, { action: 'dar_baja' }]) {
      const r = await acao(SEM.uid, id, corpo);
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ success: false, code: 'PATIENT_STATUS_LOCKED_BY_ALLOCATION', details: { allocations: 2 } });
      expect(JSON.stringify(r.body)).not.toMatch(/QA058|e2e\.local|Paciente QA/);
    }
    expect(await estado(id)).toEqual(antes);
  });

  it('ação fora do fluxo SEM a célula do destino → 403; COM a célula → 200 e a trilha grava admin_panel_override', async () => {
    const id = await pacienteSemItinerario('REPLACEMENT'); // REPLACEMENT → ON_HOLD não tem seta na FSM
    const antes = await estado(id);
    const negada = await acao(SEM.uid, id, { action: 'pausar', onHoldReason: 'INSURER' });
    expect(negada.status).toBe(403);
    expect(negada.body).toMatchObject({ code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED', details: { from: 'REPLACEMENT', to: 'ON_HOLD', cell: 'patient_status:move_to_on_hold' } });
    expect(await estado(id)).toEqual(antes);
    const ok = await acao(COM.uid, id, { action: 'pausar', onHoldReason: 'INSURER' });
    expect(ok.status).toBe(200);
    expect((await estado(id)).status).toBe('ON_HOLD');
    expect(await ultima(id)).toMatchObject({ old_value: 'REPLACEMENT', new_value: 'ON_HOLD', change_source: 'admin_panel_override' });
  });

  it('onHoldNote no corpo sem patient_clinical:read → 403 e nada muda; a nota nunca volta na resposta de quem a escreve', async () => {
    const id = await pacienteSemItinerario('ACTIVE');
    const antes = await estado(id);
    const r = await acao(SEM.uid, id, { action: 'pausar', onHoldReason: 'SCHOOL', onHoldNote: NOTA_SINTETICA });
    expect(r.status).toBe(403);
    expect(await estado(id)).toEqual(antes);
    const ok = await acao(COM.uid, id, { action: 'pausar', onHoldReason: 'SCHOOL', onHoldNote: NOTA_SINTETICA });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain(NOTA_SINTETICA);
    expect((await estado(id)).note).toBe(NOTA_SINTETICA); // gravada só no lugar dela (coluna), nunca na trilha
    expect(JSON.stringify(await pool.query(`SELECT * FROM patient_status_history WHERE patient_id = $1`, [id]).then((x) => x.rows))).not.toContain(NOTA_SINTETICA);
  });

  // ── retomar ────────────────────────────────────────────────────────────────
  it('retomar de ON_HOLD com itinerário montado e zero cobertura → SEARCHING (regra de horas), trilha `resume`', async () => {
    const id = await pacienteMontadoSemAlocacao('ON_HOLD');
    const antes = await estado(id);
    const r = await acao(SEM.uid, id, { action: 'retomar' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id, action: 'retomar', from: 'ON_HOLD', status: 'SEARCHING' });
    expect((await estado(id)).trilha).toBe(antes.trilha + 1);
    expect(await ultima(id)).toMatchObject({ old_value: 'ON_HOLD', new_value: 'SEARCHING', change_source: 'resume' });
  });

  it('S1 retomar SEM itinerário → SEARCHING mesmo se o estado anterior à pausa era ACTIVE (a trilha prova o ACTIVE; ela não decide)', async () => {
    const id = await pacienteSemItinerario('ACTIVE');
    expect((await acao(SEM.uid, id, { action: 'pausar', onHoldReason: 'SCHOOL' })).status).toBe(200);
    expect(await ultima(id)).toMatchObject({ old_value: 'ACTIVE', new_value: 'ON_HOLD' }); // o anterior ERA ACTIVE
    const r = await acao(SEM.uid, id, { action: 'retomar' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('SEARCHING');
    expect((await estado(id)).status).toBe('SEARCHING');
    expect(await ultima(id)).toMatchObject({ old_value: 'ON_HOLD', new_value: 'SEARCHING', change_source: 'resume' });
  });

  it('retomar de SUSPENDED SEM motivo de saída → 422 SUSPENSION_EXIT_REASON_REQUIRED (nada muda); COM motivo → SEARCHING e o motivo na trilha', async () => {
    const id = await pacienteSemItinerario('ACTIVE');
    expect((await acao(SEM.uid, id, { action: 'suspender' })).status).toBe(200);
    const antes = await estado(id);
    const sem = await acao(SEM.uid, id, { action: 'retomar' });
    expect(sem.status).toBe(422);
    expect(sem.body.code).toBe('SUSPENSION_EXIT_REASON_REQUIRED');
    expect(await estado(id)).toEqual(antes);
    const com = await acao(SEM.uid, id, { action: 'retomar', suspensionExitReason: 'RESUMED_SERVICE' });
    expect(com.status).toBe(200);
    expect(await ultima(id)).toMatchObject({ old_value: 'SUSPENDED', new_value: 'SEARCHING', change_source: 'resume', reason: 'RESUMED_SERVICE' });
  });

  it('S3 retomar de SUSPENDED com itinerário montado (zero cobertura) → SEARCHING pela seta SUSPENDED → SEARCHING', async () => {
    const id = await pacienteMontadoSemAlocacao('SUSPENDED');
    const r = await acao(SEM.uid, id, { action: 'retomar', suspensionExitReason: 'FAMILY_REQUESTED' });
    expect(r.status).toBe(200);
    expect((await estado(id)).status).toBe('SEARCHING');
  });

  it('retomar com o paciente ACTIVE (ou em Baja) → 422 PATIENT_STATUS_ACTION_NOT_AVAILABLE; nada muda', async () => {
    for (const status of ['ACTIVE', 'DISCHARGED']) {
      const id = await pacienteSemItinerario(status);
      const antes = await estado(id);
      const r = await acao(SEM.uid, id, { action: 'retomar' });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'PATIENT_STATUS_ACTION_NOT_AVAILABLE', details: { action: 'retomar', from: status } });
      expect(await estado(id)).toEqual(antes);
    }
  });

  it('retomar com itinerário cobrindo tudo (alocação viva) → 422 LOCKED_BY_ALLOCATION: vence a trava D530; estado intacto', async () => {
    const id = await pacienteCobertoComAlocacao('ON_HOLD');
    const antes = await estado(id);
    const r = await acao(SEM.uid, id, { action: 'retomar' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PATIENT_STATUS_LOCKED_BY_ALLOCATION');
    expect(await estado(id)).toEqual(antes);
  });

  it('a nota de ON_HOLD sai LIMPA ao retomar (regra C7.1-e): motivo e nota nulos; a nota nunca na resposta nem na trilha', async () => {
    const id = await pacienteMontadoSemAlocacao('ON_HOLD');
    await pool.query(`UPDATE patients SET on_hold_reason = 'SCHOOL', on_hold_note = $2 WHERE id = $1`, [id, NOTA_SINTETICA]);
    expect((await estado(id)).note).toBe(NOTA_SINTETICA); // controle: o cenário é real
    const r = await acao(SEM.uid, id, { action: 'retomar' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(NOTA_SINTETICA);
    const depois = await estado(id);
    expect(depois).toMatchObject({ status: 'SEARCHING', note: null, reason: null });
  });

  // ── reativar (D9) ──────────────────────────────────────────────────────────
  it('S5 reativar SEM itinerário → SEARCHING mesmo se o estado anterior à baja era ACTIVE; trilha `resume`', async () => {
    const id = await pacienteSemItinerario('ACTIVE');
    expect((await acao(SEM.uid, id, { action: 'dar_baja' })).status).toBe(200);
    expect(await ultima(id)).toMatchObject({ old_value: 'ACTIVE', new_value: 'DISCHARGED' }); // o anterior ERA ACTIVE
    const r = await acao(SEM.uid, id, { action: 'reativar' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id, action: 'reativar', from: 'DISCHARGED', status: 'SEARCHING' });
    expect((await estado(id)).status).toBe('SEARCHING');
    expect(await ultima(id)).toMatchObject({ old_value: 'DISCHARGED', new_value: 'SEARCHING', change_source: 'resume' });
  });

  it('reativar com itinerário montado e zero cobertura → SEARCHING (regra de horas), trilha `resume`', async () => {
    const id = await pacienteMontadoSemAlocacao('DISCHARGED');
    const r = await acao(SEM.uid, id, { action: 'reativar' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('SEARCHING');
    expect(await ultima(id)).toMatchObject({ old_value: 'DISCHARGED', new_value: 'SEARCHING', change_source: 'resume' });
  });

  it('reativar com o paciente fora de Baja → 422 e o estado não muda', async () => {
    const id = await pacienteSemItinerario('ACTIVE');
    const antes = await estado(id);
    const r = await acao(SEM.uid, id, { action: 'reativar' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PATIENT_STATUS_ACTION_NOT_AVAILABLE');
    expect(await estado(id)).toEqual(antes);
  });

  it('reativar com alocação viva (itinerário cobrindo tudo) → 422 PATIENT_STATUS_LOCKED_BY_ALLOCATION; estado intacto', async () => {
    const id = await pacienteCobertoComAlocacao('DISCHARGED');
    const antes = await estado(id);
    const r = await acao(SEM.uid, id, { action: 'reativar' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'PATIENT_STATUS_LOCKED_BY_ALLOCATION', details: { allocations: 2 } });
    expect(await estado(id)).toEqual(antes);
  });

  it('S5 reativar NÃO escolhe destino: `destino`/`status`/`changeSource` no corpo → 400 e o estado não muda', async () => {
    const id = await pacienteSemItinerario('DISCHARGED');
    const antes = await estado(id);
    for (const extra of [{ destino: 'ACTIVE' }, { status: 'ACTIVE' }, { changeSource: 'kanban' }]) {
      const r = await acao(SEM.uid, id, { action: 'reativar', ...extra });
      expect(r.status).toBe(400);
      expect(await estado(id)).toEqual(antes);
    }
    // controle: o mesmo pedido SEM a chave extra funciona e vai ao estado DERIVADO (SEARCHING), nunca ao ACTIVE imposto
    expect((await acao(SEM.uid, id, { action: 'reativar' })).status).toBe(200);
    expect((await estado(id)).status).toBe('SEARCHING');
  });

  // ── a lista (mesma avaliação da escrita) ───────────────────────────────────
  it('GET status-actions: ACTIVE oferece as 4 do painel; ON_HOLD oferece retomar com o destino RE-DERIVADO; DISCHARGED oferece reativar', async () => {
    const ativo = await lista(SEM.uid, await pacienteSemItinerario('ACTIVE'));
    expect(ativo.status).toBe(200);
    expect(ativo.body.data.actions.map((a: { acao: string }) => a.acao)).toEqual(['pausar', 'suspender', 'dar_alta', 'dar_baja']);
    const espera = (await lista(SEM.uid, await pacienteSemItinerario('ON_HOLD'))).body.data.actions;
    expect(espera.find((a: { acao: string }) => a.acao === 'retomar')).toMatchObject({ destino: 'SEARCHING', via: 'fluxo', exige: [] });
    const suspenso = (await lista(SEM.uid, await pacienteSemItinerario('SUSPENDED'))).body.data.actions;
    expect(suspenso.find((a: { acao: string }) => a.acao === 'retomar').exige).toEqual(['suspensionExitReason']);
    const baja = (await lista(SEM.uid, await pacienteSemItinerario('DISCHARGED'))).body.data.actions;
    expect(baja.find((a: { acao: string }) => a.acao === 'reativar')).toMatchObject({ destino: 'SEARCHING', exige: [] });
    expect(baja.some((a: { acao: string }) => a.acao === 'retomar')).toBe(false);
  });

  it('S4 GET status-actions com alocação viva: TODA ação sai bloqueada por ACTIVE_ALLOCATION', async () => {
    const id = await pacienteCobertoComAlocacao('ON_HOLD');
    const r = await lista(SEM.uid, id);
    const acoes = r.body.data.actions as Array<{ acao: string; blockedBy?: string[] }>;
    expect(acoes.length).toBeGreaterThan(0);
    expect(acoes.every((a) => JSON.stringify(a.blockedBy) === '["ACTIVE_ALLOCATION"]')).toBe(true);
  });

  it('a lista não oferece o que a escrita negaria: sem a célula, `pausar` de REPLACEMENT não aparece (e o POST dá 403); com a célula, aparece como `permissao`', async () => {
    const id = await pacienteSemItinerario('REPLACEMENT');
    const sem = (await lista(SEM.uid, id)).body.data.actions.map((a: { acao: string }) => a.acao);
    expect(sem).not.toContain('pausar');
    expect((await acao(SEM.uid, id, { action: 'pausar', onHoldReason: 'SCHOOL' })).status).toBe(403);
    const com = (await lista(COM.uid, id)).body.data.actions;
    expect(com.find((a: { acao: string }) => a.acao === 'pausar')).toMatchObject({ via: 'permissao', exige: ['onHoldReason'] });
  });

  it('GET e POST exigem patient:update: conta só-leitura → 403 e nada muda; paciente inexistente → 404', async () => {
    const id = await pacienteSemItinerario('ACTIVE');
    const antes = await estado(id);
    expect((await lista(LEITORA.uid, id)).status).toBe(403);
    expect((await acao(LEITORA.uid, id, { action: 'suspender' })).status).toBe(403);
    expect(await estado(id)).toEqual(antes);
    expect((await acao(SEM.uid, '00000000-0000-4000-8000-000000000000', { action: 'suspender' })).status).toBe(404);
  });
});
