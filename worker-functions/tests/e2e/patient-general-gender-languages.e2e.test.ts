/**
 * spec 018 PR-3 (Emenda 13/09, migration 425) — gênero e idiomas do paciente sob o engine de
 * permissão (HTTP real, banco real, KMS passthrough do modo de teste). Molde:
 * `patient-external-contacts-and-emergency-mark.e2e.test.ts` (PR-2).
 *
 * O que se prova:
 *   L2b-3  NULL ("não perguntado") ≠ PREFER_NOT_TO_SAY (resposta explícita) — roundtrip real.
 *   L2b-5  gender_encrypted no banco NUNCA é o texto claro (cifrado com KMS).
 *   CONDIÇÃO 7  PATCH /general {gender,languages} não grava NADA em
 *               patient_field_overrides_audit — com sabotagem: inserir manualmente uma linha
 *               com field_name='gender' prova que a query do teste ACUSARIA se o código
 *               algum dia passasse a gravar ali (vermelho), e a ausência de qualquer INSERT no
 *               caminho de produção mantém a contagem real em 0 (verde).
 *   ator sem patient_identity:write → 403, nada gravado.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('spec 018 PR-3 — gênero/idiomas do paciente: API sob engine (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee018003-0c00-0003-0003-000000000001';
  const U = { completa: 'pr3-completa', semIdentidade: 'pr3-sem-identidade' };
  const GRUPOS = { completa: 'PR3 Completa', semIdentidade: 'PR3 Sem identidade' };
  // PR-8b (A3, ADR-2/SUP-30): `PATCH /patients/:id/general` só declara `patient_identity:update`
  // agora (adminPatientsRoutes.ts:305, `PATIENT_SECTION_CELL`) — nunca `write`.
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient', 'read'], ['patient_identity', 'read'], ['patient_identity', 'update'],
  ];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => { envAnterior[k] = process.env[k]; process.env[k] = v; };

  async function chamar(metodo: string, caminho: string, uid: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(uid), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // PR-8b (A3, achado A2): `patient_identity:update` é célula do catálogo compartilhado (seedada
  // pela migration 435) — não é apagada no cleanup. `limparIamFixtures` cobre o que este arquivo
  // é DONO (grupos/usuários/`group_permissions`).
  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM patient_field_overrides_audit WHERE patient_id = $1`, [PATIENT]);
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'pr3-completa@e2e.local', 'Completa', 'admin', 'ACTIVE', true, $3),
         ($2, 'pr3-sem-identidade@e2e.local', 'Sem identidade', 'admin', 'ACTIVE', true, $3)`,
      [U.completa, U.semIdentidade, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) {
      await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    }
    await grupoComCelulas(pool, { nome: GRUPOS.completa, uid: U.completa, celulas: [['patient', 'read'], ['patient_identity', 'read'], ['patient_identity', 'update']] });
    await grupoComCelulas(pool, { nome: GRUPOS.semIdentidade, uid: U.semIdentidade, celulas: [['patient', 'read']] });
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-pr3-a', 'Paciente', 'Sintético', 'AR', true)`,
      [PATIENT],
    );

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const caseModule = await import('@modules/case');
    const { AdminPatientDiagnosesController } = await import('@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController');
    const { AdminTerminologySearchController } = await import('@modules/terminology/interfaces/controllers/AdminTerminologySearchController');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use(
          '/api/admin',
          caseModule.createAdminPatientsRoutes(
            new caseModule.AdminPatientsController(),
            auth,
            permissions,
            new caseModule.AdminPatientChatIdsController(),
            new caseModule.AdminPatientChatRolesController(),
            new caseModule.AdminPatientsMapController(),
            new caseModule.AdminPatientAddressesController(),
            new caseModule.AdminInsuranceProvidersController(),
            new caseModule.AdminPatientContractedServicesController(),
            new AdminPatientDiagnosesController(),
            new AdminTerminologySearchController(),
          ),
        ),
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const GENERAL = () => `/api/admin/patients/${PATIENT}/general`;
  const DETAIL = () => `/api/admin/patients/${PATIENT}`;
  const rawColumns = async () => (await pool.query<{ gender_encrypted: string | null; languages_encrypted: string | null }>(
    `SELECT gender_encrypted, languages_encrypted FROM patients WHERE id = $1`, [PATIENT],
  )).rows[0];
  const auditCount = async () => Number((await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM patient_field_overrides_audit WHERE patient_id = $1 AND field_name IN ('gender', 'languages')`, [PATIENT],
  )).rows[0].n);

  it('1. PATCH gender=PREFER_NOT_TO_SAY (KMS): coluna cifrada (L2b-5), GET devolve o valor (L2b-3, ≠ null)', async () => {
    const w = await chamar('PATCH', GENERAL(), U.completa, { gender: 'PREFER_NOT_TO_SAY' });
    expect(w.status).toBe(200);
    const row = await rawColumns();
    expect(row.gender_encrypted).not.toBeNull();
    expect(row.gender_encrypted).not.toBe('PREFER_NOT_TO_SAY'); // nunca texto claro (L2b-5)
    const r = await chamar('GET', DETAIL(), U.completa);
    expect(r.status).toBe(200);
    expect(r.body.data.gender).toBe('PREFER_NOT_TO_SAY');
  });

  it('2. PATCH gender=null explícito (limpar) → GET devolve null — DISTINTO de PREFER_NOT_TO_SAY (L2b-3)', async () => {
    const w = await chamar('PATCH', GENERAL(), U.completa, { gender: null });
    expect(w.status).toBe(200);
    const r = await chamar('GET', DETAIL(), U.completa);
    expect(r.body.data.gender).toBeNull();
    // prova que os dois estados são DIFERENTES na mesma linha, não um artefato do fixture:
    const w2 = await chamar('PATCH', GENERAL(), U.completa, { gender: 'PREFER_NOT_TO_SAY' });
    expect(w2.status).toBe(200);
    const r2 = await chamar('GET', DETAIL(), U.completa);
    expect(r2.body.data.gender).toBe('PREFER_NOT_TO_SAY');
    expect(r2.body.data.gender).not.toBeNull();
  });

  it('3. PATCH languages=[pt,es] (KMS, L2b-5/L2c-3): coluna cifrada, GET devolve a lista; languages=null limpa', async () => {
    const w = await chamar('PATCH', GENERAL(), U.completa, { languages: ['pt', 'es'] });
    expect(w.status).toBe(200);
    const row = await rawColumns();
    expect(row.languages_encrypted).not.toBeNull();
    expect(row.languages_encrypted).not.toContain('pt'); // nunca texto claro
    const r = await chamar('GET', DETAIL(), U.completa);
    expect(r.body.data.languages).toEqual(['pt', 'es']);
    const w2 = await chamar('PATCH', GENERAL(), U.completa, { languages: null });
    expect(w2.status).toBe(200);
    const r2 = await chamar('GET', DETAIL(), U.completa);
    expect(r2.body.data.languages).toBeNull();
  });

  it('4. CONDIÇÃO 7: PATCH gender/languages NUNCA grava em patient_field_overrides_audit (sabotagem prova a régua)', async () => {
    expect(await auditCount()).toBe(0);
    const w = await chamar('PATCH', GENERAL(), U.completa, { gender: 'MALE', languages: ['en'] });
    expect(w.status).toBe(200);
    // Caminho de produção real: 0 depois de gravar de verdade.
    expect(await auditCount()).toBe(0);
    // Sabotagem: se o código UM DIA passar a auditar aqui, a query abaixo pegaria — prova que a
    // régua não está sempre-verde por acidente (ela DISTINGUE 0 de >0 na mesma tabela/paciente).
    await pool.query(
      `INSERT INTO patient_field_overrides_audit (patient_id, field_name, old_value, new_value, source, actor_id)
       VALUES ($1, 'gender', null, 'MALE', 'sabotagem-e2e', 'sabotagem-e2e')`,
      [PATIENT],
    );
    expect(await auditCount()).toBe(1); // vermelho simulado: a régua ACUSA quando existe linha
    await pool.query(`DELETE FROM patient_field_overrides_audit WHERE patient_id = $1 AND source = 'sabotagem-e2e'`, [PATIENT]);
    expect(await auditCount()).toBe(0); // volta ao estado real de produção
  });

  it('5. ator SEM patient_identity:write → 403, nada gravado (coluna e trilha inalteradas)', async () => {
    const antes = await rawColumns();
    const w = await chamar('PATCH', GENERAL(), U.semIdentidade, { gender: 'NON_BINARY' });
    expect(w.status).toBe(403);
    const depois = await rawColumns();
    expect(depois).toEqual(antes);
    expect(await auditCount()).toBe(0);
  });

  it('6. valor fora do enum fechado (categoria proibida ou digitação livre) → 400, nada gravado', async () => {
    const antes = await rawColumns();
    const w = await chamar('PATCH', GENERAL(), U.completa, { gender: 'CATOLICO' });
    expect(w.status).toBe(400);
    const depois = await rawColumns();
    expect(depois).toEqual(antes);
  });

  it('7. idioma fora da lista fechada pt/es/en → 400, nada gravado (L2c-2)', async () => {
    const antes = await rawColumns();
    const w = await chamar('PATCH', GENERAL(), U.completa, { languages: ['fr'] });
    expect(w.status).toBe(400);
    const depois = await rawColumns();
    expect(depois).toEqual(antes);
  });
});

/**
 * CONDIÇÃO 9 / L2c-4: gender/languages do PACIENTE não propagam a PDF, vaga, Talentum ou rota
 * pública nesta emenda. Prova por grep — os módulos que montam esses artefatos não referenciam
 * os campos novos.
 *
 * Escopo ampliado (gate revisao-pr, item G): Talentum mora em `src/modules/integration` (sync,
 * webhook, descrição), não só em `src/modules/matching`; o PDF do projeto terapêutico e a rota
 * pública de leads moram em `src/modules/case/interfaces` (`AdminTherapeuticProjectsController`,
 * `PublicLeadsController`); o PDF em SI (o template renderizado) mora no FRONTEND
 * (`enlite-frontend/.../therapeuticProject/pdf/`), lido aqui pelo mesmo molde de
 * `relationshipParity.contract.test.ts` (leitura crua entre pacotes).
 *
 * Regra de exclusão EXPLÍCITA (pedida no item G): `\bw\.gender\b`/`\bw\.languages\b` (alias de
 * linha de WORKER, ex. `w.gender_encrypted AS "genderEnc"` em queries de prestador) NÃO conta —
 * é outro titular, outra categoria, já legitimamente coletada desde as migrations 008/023. Só
 * `patient.gender`/`patient.languages`/`genderEncrypted`/`languagesEncrypted` SOLTOS (sem prefixo
 * `w.`) contam como achado.
 */
describe('spec 018 PR-3 CONDIÇÃO 9 / L2c-4 — gender/languages fora de PDF/vaga/Talentum/rotas públicas', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const FRONTEND_ROOT = path.resolve(__dirname, '../../../enlite-frontend');

  it('AdminPatientView (lista/kanban) não expõe gender/languages fora do container identity da FICHA — LIST_FIELDS não os contém', () => {
    const containerSrc = readFileSync(path.join(ROOT, 'src/modules/case/application/patientContainerAccess.ts'), 'utf8');
    const listFieldsBlock = containerSrc.slice(containerSrc.indexOf('const LIST_FIELDS'), containerSrc.indexOf('/** Que containers'));
    expect(listFieldsBlock).not.toMatch(/'gender'/);
    expect(listFieldsBlock).not.toMatch(/'languages'/);
  });

  /** Acusa `patient.gender`/`patient.languages`/`genderEncrypted`/`languagesEncrypted` — MAS NÃO `w.gender`/`w.languages` (worker, fora de escopo, regra explícita do item G). */
  function referenciaProibida(src: string): boolean {
    if (/\bw\.gender\w*\b|\bw\.languages\w*\b/.test(src)) {
      // linha(s) de worker presentes — remove-as antes de checar o resto, para não mascarar um
      // achado real de paciente que exista no MESMO arquivo.
      src = src.replace(/^.*\bw\.(gender|languages)\w*\b.*$/gm, '');
    }
    return /patient\.gender\b|patient\.languages\b|\bgenderEncrypted\b|\blanguagesEncrypted\b/.test(src);
  }

  function walkDir(root: string, dir: string, achados: string[]): void {
    for (const entry of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${entry}`;
      const full = path.join(root, rel);
      if (statSync(full).isDirectory()) { walkDir(root, rel, achados); continue; }
      if (!/\.(ts|tsx)$/.test(entry) || entry.includes('.test.') || entry.includes('.spec.')) continue;
      const src = readFileSync(full, 'utf8');
      if (referenciaProibida(src)) achados.push(rel);
    }
  }

  it('nenhum módulo de matching/vaga/Talentum (backend) referencia gender/languages do paciente (workers `w.` excluídos)', () => {
    const achados: string[] = [];
    for (const d of ['src/modules/matching', 'src/modules/integration']) walkDir(ROOT, d, achados);
    expect(achados).toEqual([]);
  });

  it('rotas/controllers públicos e o PDF do projeto terapêutico (backend) não referenciam gender/languages do paciente', () => {
    const alvos = [
      'src/modules/case/interfaces/controllers/PublicLeadsController.ts',
      'src/modules/case/interfaces/validators/publicLeadSchema.ts',
      'src/modules/case/interfaces/controllers/AdminTherapeuticProjectsController.ts',
      'src/modules/case/interfaces/routes/adminTherapeuticProjectsRoutes.ts',
      'src/modules/case/application/therapeuticProjectAccess.ts',
      'src/modules/case/domain/TherapeuticProject.ts',
      'src/modules/diagnosis/interfaces/DiagnosisPublicView.ts',
    ];
    const achados = alvos.filter((rel) => referenciaProibida(readFileSync(path.join(ROOT, rel), 'utf8')));
    expect(achados).toEqual([]);
  });

  it('o PDF do projeto terapêutico (frontend, o template REAL renderizado) não referencia gender/languages do paciente', () => {
    const achados: string[] = [];
    walkDir(FRONTEND_ROOT, 'src/presentation/components/features/admin/PatientDetail/therapeuticProject/pdf', achados);
    expect(achados).toEqual([]);
  });

  it('sabotagem: um arquivo com `patient.gender` solto (sem prefixo `w.`) É pego pela mesma função', () => {
    expect(referenciaProibida('const x = patient.gender;')).toBe(true);
    expect(referenciaProibida('const y = w.gender_encrypted;')).toBe(false); // worker: excluído por regra explícita
  });
});
