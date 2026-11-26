/**
 * A vaga mostra o estado do paciente, lido na hora; o ciclo de vida tem um dono (estado-automatico-do-paciente, F2, D3) @integration
 *
 * Pela borda, com banco real e sem mock: app REAL (cadeia de middlewares, controllers, rotas de paciente e de vaga, página pública) com o
 * engine de permissão LIGADO (ver `helpers/vagaEstadoPacienteApp.ts`), atores em grupos com EXATAMENTE as células de cada cenário.
 *   (i)   foguete (`activate-recruitment`) → `GET /vacancies` e `GET /vacancies/:id` trazem `patient_status = SEARCHING` e `lifecycle = rascunho`;
 *   (ii)  `UPDATE patients SET status` por SQL → a vaga relida traz o valor novo; `job_postings.updated_at` e a trilha da vaga ficam IGUAIS;
 *         `job_postings` não tem coluna `%patient%status%` (a cópia nunca existiu);
 *   (iii) linha com `status = 'SEARCHING_REPLACEMENT'` e `is_draft = false` → `lifecycle = aberta`;
 *   (iv)  ator sem `patient:read` → `patient_status = null` + `redacted.patient` (lista, ficha, card do paciente); filtro por estado → 403;
 *   (v)   vaga sem paciente → SEM a chave `patient_status`;
 *   (vi)  ataque `PUT /vacancies/:id { status: 'SEARCHING_REPLACEMENT' }` (e os outros 3 legados) → 400 e `patients.status` intacto; "Reanudar"
 *         de vaga legada em pausa grava SEARCHING (200) e a vaga volta a `aberta`;
 *   (vii) página pública → `lifecycle` e NENHUMA chave `patient_status`.
 *
 * Outbound mapeado: o foguete e as rotas de vaga só fazem SELECT/INSERT/UPDATE em Postgres; a vaga nasce rascunho e sem `talentum_project_id`
 * (nenhuma propagação à Talentum), e nenhum caminho aqui chama Twilio/WhatsApp/Ana Care/Google/Short.io (`tryEnsureShortLink` só roda no POST de vaga,
 * que este arquivo não chama). Fixtures sintéticas (sobrenome " QA"), nenhum texto clínico.
 */
import { Pool } from 'pg';
import type { AppDeFamilia } from './helpers/permissionFamilyHarness';
import { atorComCelulas, chamar, fecharAppVaga, limparAtores, subirAppVaga } from './helpers/vagaEstadoPacienteApp';
import { semearFaixas } from './helpers/seedFaixaDoServico';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const TAG = 'vaga-estado-e2e-';
const HORARIO = [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }];
const CASO_BASE = 95300;

const A = {
  completo: { uid: 'qa-vaga-estado-completo', nome: 'QA vaga-estado completo' },
  semPaciente: { uid: 'qa-vaga-estado-sem-paciente-read', nome: 'QA vaga-estado sem patient:read' },
};
const ATORES = Object.values(A);
const CELULAS_COMPLETO: Array<[string, string]> = [
  ['vacancy', 'read'], ['vacancy', 'update'], ['patient', 'read'], ['patient_services', 'read'], ['patient_services', 'update'],
];
const CELULAS_SEM_PATIENT: Array<[string, string]> = [['vacancy', 'read'], ['vacancy', 'update']];

describe('A vaga mostra o estado do paciente (D3) @integration', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  let caso = CASO_BASE;

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM job_postings WHERE title LIKE $1 OR patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $2)`, [`${TAG}%`, `${TAG}%`]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TAG}%`]);
  }

  async function novoPaciente(tag: string, status: string): Promise<{ patientId: string; caseNumber: number }> {
    const caseNumber = caso++;
    const { rows: [p] } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, insurance_informed, case_number)
       VALUES ($1, 'Vaga', 'Estado QA', 'AR', $2, 'Particular', $3) RETURNING id`,
      [`${TAG}${tag}`, status, caseNumber],
    );
    return { patientId: p.id, caseNumber };
  }

  /** Vaga por SQL (as linhas de hoje, inclusive as com valor legado). */
  async function novaVaga(patientId: string | null, caseNumber: number, status: string, isDraft: boolean, titulo: string): Promise<string> {
    const { rows: [v] } = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, country, status, is_draft, patient_id, case_number, case_ordinal)
       VALUES ($1, 'desc', 'AR', $2, $3, $4, $5, 1) RETURNING id`,
      [`${TAG}${titulo}`, status, isDraft, patientId, caseNumber],
    );
    return v.id;
  }

  const lista = async (uid: string, caseNumber: number, extra = ''): Promise<{ status: number; body: any; linha?: any }> => {
    const r = await chamar(app, 'GET', `/api/admin/vacancies?search=${caseNumber}${extra}`, uid);
    return { ...r, linha: (r.body.data ?? []).find((v: { caseNumber: number }) => v.caseNumber === caseNumber) };
  };
  const ficha = (uid: string, id: string) => chamar(app, 'GET', `/api/admin/vacancies/${id}`, uid);
  const statusDoPaciente = async (id: string): Promise<string> => (await pool.query<{ status: string }>('SELECT status FROM patients WHERE id = $1', [id])).rows[0].status;
  const statusDaVaga = async (id: string): Promise<string> => (await pool.query<{ status: string }>('SELECT status FROM job_postings WHERE id = $1', [id])).rows[0].status;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await limparAtores(pool, ATORES);
    await atorComCelulas(pool, A.completo.uid, A.completo.nome, CELULAS_COMPLETO);
    await atorComCelulas(pool, A.semPaciente.uid, A.semPaciente.nome, CELULAS_SEM_PATIENT);
    app = await subirAppVaga(DATABASE_URL);
  }, 60000);

  afterAll(async () => {
    await limpar();
    await limparAtores(pool, ATORES);
    await fecharAppVaga(app);
    await pool.end();
  });

  it('(i) FELIZ: o foguete cria a vaga em rascunho e a lista e a ficha trazem patient_status = SEARCHING, lifecycle = rascunho', async () => {
    const { patientId, caseNumber } = await novoPaciente('foguete', 'ADMISSION');
    await seedPatientDiagnosis(pool, patientId);
    const { rows: [end] } = await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1, 'Calle Vaga 1', 1) RETURNING id`, [patientId]);
    const { rows: [srv] } = await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services
         (patient_id, service_code, active, country, created_by, updated_by, address_id, required_professions, required_sex, required_experience, work_schedule, payment_day)
       VALUES ($1, 'AT', true, 'AR', 'vaga-estado-e2e', 'vaga-estado-e2e', $2, ARRAY['AT'], 'BOTH', 'EXP-E2E', 'part-time', 'DIA-E2E') RETURNING id`,
      [patientId, end.id]);
    await semearFaixas(pool, srv.id, HORARIO, 'vaga-estado-e2e');

    const r = await chamar(app, 'POST', `/api/admin/patients/${patientId}/contracted-services/${srv.id}/activate-recruitment`, A.completo.uid, {});
    expect(r.status).toBe(201);
    const vagaId = r.body.data.vacancyId as string;
    expect(await statusDoPaciente(patientId)).toBe('SEARCHING');

    const naLista = await lista(A.completo.uid, caseNumber);
    expect(naLista.status).toBe(200);
    expect(naLista.linha).toBeDefined(); // contagem zero é falha: a vaga do foguete TEM de estar na lista
    expect(naLista.linha).toMatchObject({ id: vagaId, patient_status: 'SEARCHING', lifecycle: 'rascunho', patient_id: patientId });
    const naFicha = await ficha(A.completo.uid, vagaId);
    expect(naFicha.status).toBe(200);
    expect(naFicha.body.data).toMatchObject({ patient_status: 'SEARCHING', lifecycle: 'rascunho', patient_id: patientId });
    expect(naFicha.body.data).not.toHaveProperty('redacted');
  });

  it('(ii) o estado do paciente muda por SQL e a vaga acompanha SEM escrita nela; nenhuma coluna de job_postings guarda o estado', async () => {
    const { patientId, caseNumber } = await novoPaciente('acompanha', 'SEARCHING');
    const vagaId = await novaVaga(patientId, caseNumber, 'SEARCHING', false, 'acompanha');
    const antesVaga = (await pool.query<{ updated_at: Date }>('SELECT updated_at FROM job_postings WHERE id = $1', [vagaId])).rows[0].updated_at;
    const antesAuditoria = Number((await pool.query('SELECT COUNT(*) AS n FROM job_posting_audit_log WHERE job_posting_id = $1', [vagaId])).rows[0].n);

    expect((await lista(A.completo.uid, caseNumber)).linha.patient_status).toBe('SEARCHING');
    await pool.query(`UPDATE patients SET status = 'REPLACEMENT' WHERE id = $1`, [patientId]);

    expect((await lista(A.completo.uid, caseNumber)).linha.patient_status).toBe('REPLACEMENT');
    expect((await ficha(A.completo.uid, vagaId)).body.data.patient_status).toBe('REPLACEMENT');
    const depoisVaga = (await pool.query<{ updated_at: Date }>('SELECT updated_at FROM job_postings WHERE id = $1', [vagaId])).rows[0].updated_at;
    expect(depoisVaga.getTime()).toBe(antesVaga.getTime());
    expect(Number((await pool.query('SELECT COUNT(*) AS n FROM job_posting_audit_log WHERE job_posting_id = $1', [vagaId])).rows[0].n)).toBe(antesAuditoria);

    // teste estrutural: a cópia nunca existiu (controle positivo: a mesma query acha `status` em job_postings)
    const colunas = (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'job_postings'`)).rows.map((c) => c.column_name);
    expect(colunas).toContain('status');
    expect(colunas.filter((c) => /patient.*status|status.*patient/i.test(c))).toEqual([]);
  });

  it('(iii) linha antiga com status legado SEARCHING_REPLACEMENT publicada → lifecycle = aberta (lista e ficha)', async () => {
    const { patientId, caseNumber } = await novoPaciente('legado', 'REPLACEMENT');
    const vagaId = await novaVaga(patientId, caseNumber, 'SEARCHING_REPLACEMENT', false, 'legado');
    expect((await lista(A.completo.uid, caseNumber)).linha).toMatchObject({ id: vagaId, lifecycle: 'aberta', statusRaw: 'SEARCHING_REPLACEMENT' });
    expect((await ficha(A.completo.uid, vagaId)).body.data).toMatchObject({ lifecycle: 'aberta', status: 'SEARCHING_REPLACEMENT' });

    // o filtro "Ciclo de vida" usa o SQL gerado da mesma tabela: aberta acha o legado; baja acha a baixada (que a lista esconde por padrão)
    expect((await lista(A.completo.uid, caseNumber, '&lifecycle=aberta')).linha?.id).toBe(vagaId);
    expect((await lista(A.completo.uid, caseNumber, '&lifecycle=pausada')).linha).toBeUndefined();
    const { caseNumber: casoBaja, patientId: pBaja } = await novoPaciente('baja', 'ACTIVE');
    const baixada = await novaVaga(pBaja, casoBaja, 'DE_BAJA', false, 'baixada');
    expect((await lista(A.completo.uid, casoBaja)).linha).toBeUndefined();
    expect((await lista(A.completo.uid, casoBaja, '&lifecycle=baja')).linha).toMatchObject({ id: baixada, lifecycle: 'baja' });
  });

  it('(iv) ator sem patient:read: patient_status null + redacted.patient na lista, na ficha e no card do paciente; filtro por estado → 403', async () => {
    const { patientId, caseNumber } = await novoPaciente('redigido', 'SEARCHING');
    const vagaId = await novaVaga(patientId, caseNumber, 'SEARCHING', false, 'redigido');

    const l = await lista(A.semPaciente.uid, caseNumber);
    expect(l.status).toBe(200);
    expect(l.linha).toMatchObject({ patient_status: null, redacted: { patient: true }, lifecycle: 'aberta' });
    expect(JSON.stringify(l.linha)).not.toContain('"patient_status":"SEARCHING"'); // o valor não vaza em nenhum lugar da linha
    const f = await ficha(A.semPaciente.uid, vagaId);
    expect(f.body.data).toMatchObject({ patient_status: null, redacted: { patient: true } });
    // controle positivo: o MESMO dado, com a célula, sai
    expect((await lista(A.completo.uid, caseNumber)).linha.patient_status).toBe('SEARCHING');

    // o card "vagas do paciente" é gateado pela célula da vaga: o ator só com `vacancy:read` o lê, e o estado sai redigido
    const card = await chamar(app, 'GET', `/api/admin/patients/${patientId}/vacancies`, A.semPaciente.uid);
    if (card.status === 200) {
      expect(card.body.data[0]).toMatchObject({ patientStatus: null, redacted: { patient: true } });
    } else {
      expect(card.status).toBe(403); // a rota do paciente exige patient:read — a recusa também não vaza o estado
    }
    const cardCompleto = await chamar(app, 'GET', `/api/admin/patients/${patientId}/vacancies`, A.completo.uid);
    expect(cardCompleto.status).toBe(200);
    expect(cardCompleto.body.data[0]).toMatchObject({ patientStatus: 'SEARCHING', lifecycle: 'aberta' });

    // filtrar por estado do paciente sem a célula é oráculo: 403 nomeando o campo; com a célula, 200 e só as vagas daquele estado
    const recusado = await chamar(app, 'GET', `/api/admin/vacancies?search=${caseNumber}&patient_status=SEARCHING`, A.semPaciente.uid);
    expect(recusado.status).toBe(403);
    expect(recusado.body.details).toEqual({ field: 'patientStatus', cell: 'patient:read' });
    const permitido = await lista(A.completo.uid, caseNumber, '&patient_status=SEARCHING');
    expect(permitido.linha?.id).toBe(vagaId);
    expect((await lista(A.completo.uid, caseNumber, '&patient_status=ACTIVE')).linha).toBeUndefined();
  });

  it('(v) vaga sem paciente → sem a chave patient_status (e patient_id null), com ou sem a célula', async () => {
    const caseNumber = caso++;
    const vagaId = await novaVaga(null, caseNumber, 'SEARCHING', false, 'sem-paciente');
    for (const uid of [A.completo.uid, A.semPaciente.uid]) {
      // sem paciente não há `caseNumber` (vem do paciente): acha a linha pelo id
      const r = await chamar(app, 'GET', `/api/admin/vacancies?search=${caseNumber}`, uid);
      const linha = (r.body.data ?? []).find((v: { id: string }) => v.id === vagaId);
      expect(linha).toBeDefined();
      expect(linha).not.toHaveProperty('patient_status');
      expect(linha).not.toHaveProperty('redacted');
      expect(linha.patient_id).toBeNull();
      expect(linha.lifecycle).toBe('aberta');
    }
  });

  it('(vi) ATAQUE: PUT status legado → 400 e o paciente intacto; "Reanudar" de pausa que veio do legado grava SEARCHING e a vaga volta a aberta', async () => {
    const { patientId, caseNumber } = await novoPaciente('ataque', 'SEARCHING');
    const vagaId = await novaVaga(patientId, caseNumber, 'SEARCHING', false, 'ataque');

    for (const legado of ['SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'ACTIVE', 'PENDING_ACTIVATION']) {
      const r = await chamar(app, 'PUT', `/api/admin/vacancies/${vagaId}`, A.completo.uid, { status: legado });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VACANCY_STATUS_NOT_LIFECYCLE');
      expect(r.body.messages.es).toMatch(/flujo automático/);
      expect(r.body.messages['pt-BR']).toMatch(/fluxo automático/);
      expect(await statusDoPaciente(patientId)).toBe('SEARCHING');
      expect(await statusDaVaga(vagaId)).toBe('SEARCHING');
    }
    expect(Number((await pool.query(`SELECT COUNT(*) AS n FROM patient_status_history WHERE patient_id = $1 AND change_source = 'admin_panel'`, [patientId])).rows[0].n)).toBe(0);

    // controle positivo do MESMO ator/rota: o valor do ciclo de vida passa
    expect((await chamar(app, 'PUT', `/api/admin/vacancies/${vagaId}`, A.completo.uid, { status: 'ON_HOLD' })).status).toBe(200);
    // Reanudar de vaga legada: a pausa guardou SEARCHING_REPLACEMENT (linha antiga) e o back devolve o valor de escrita
    await pool.query(`UPDATE job_postings SET status_before_hold = 'SEARCHING_REPLACEMENT' WHERE id = $1`, [vagaId]);
    const pausada = await ficha(A.completo.uid, vagaId);
    expect(pausada.body.data).toMatchObject({ status: 'ON_HOLD', lifecycle: 'pausada', resumeStatus: 'SEARCHING' });
    const retomada = await chamar(app, 'PUT', `/api/admin/vacancies/${vagaId}`, A.completo.uid, { status: pausada.body.data.resumeStatus });
    expect(retomada.status).toBe(200);
    expect((await ficha(A.completo.uid, vagaId)).body.data).toMatchObject({ status: 'SEARCHING', lifecycle: 'aberta' });
    expect(await statusDoPaciente(patientId)).toBe('SEARCHING'); // o paciente nunca foi tocado
  });

  it('(vii) a página pública mostra SÓ o ciclo de vida: lifecycle sim, patient_status nunca', async () => {
    const { patientId, caseNumber } = await novoPaciente('publica', 'REPLACEMENT');
    const vagaId = await novaVaga(patientId, caseNumber, 'SEARCHING_REPLACEMENT', false, 'publica');
    const r = await chamar(app, 'GET', `/api/vacancies/${vagaId}`, A.completo.uid);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: vagaId, lifecycle: 'aberta' });
    expect(r.body.data).not.toHaveProperty('patient_status');
    expect(r.body.data).not.toHaveProperty('patientStatus');
    expect(r.body.data).not.toHaveProperty('redacted');
    expect(JSON.stringify(r.body)).not.toContain('patient_status');
  });
});
