/**
 * spec 018, PR-2 (`lex` #4, D-A) — contatos externos sem vínculo familiar e marca de emergência,
 * sob o engine de permissão (HTTP real, banco real, KMS passthrough do modo de teste). Molde:
 * `patient-coverage-emergency-contacts.e2e.test.ts` (PR-1). O que se prova:
 *   L4-9  o telefone NUNCA está em claro no banco (`phone_encrypted` ≠ o número mandado);
 *   L4-8  sem `patient_family:read` o campo sai `null` e `redacted.family = true`;
 *   D-A#1 no máximo 1 marca de emergência (responsável OU externo, nunca os dois);
 *   D-A#3 marcar exige contato ATIVO e com telefone (422 EMERGENCY_CONTACT_REQUIRES_PHONE);
 *   D-A#4 desativar o contato marcado LIMPA a marca na mesma transação (emergencyMarkCleared);
 *   SUP-40 apagar o telefone de um contato MARCADO é bloqueado (422), com marca intacta;
 *   FR-002 remover é `active=false`, NUNCA DELETE;
 *   relation fechada (400), corpo `.strict()` (400 em chave a mais), escrita exige `patient_family:write` (403).
 */
import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('spec 018 PR-2 — contatos externos + marca de emergência: API sob engine (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee018002-0c00-0002-0002-000000000001';
  const OUTRO_PACIENTE = 'ee018002-0c00-0002-0002-000000000099';
  const U = { completa: 'pr2-completa', semFamilia: 'pr2-sem-familia' };
  const GRUPOS = { completa: 'PR2 Completa', semFamilia: 'PR2 Sem familia' };
  // PR-8b (A3, ADR-2/SUP-30): as rotas de `patient_family` (responsibles/external-contacts/
  // emergency-contact) não declaram mais `write` — `create` no POST, `update` no PATCH/
  // deactivate/PUT/DELETE (adminPatientsRoutes.ts:320-369).
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient', 'read'], ['patient_family', 'read'], ['patient_family', 'create'], ['patient_family', 'update'],
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

  // PR-8b (A3, achado A2): as células de CELULAS são do catálogo compartilhado (`create`/`update`
  // nascem seedadas pela migration 435 para os 23 recursos splitados) — apagar `iam.permissions`
  // no cleanup derrubava outras suítes. `limparIamFixtures` já cobre o que este arquivo é DONO.
  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PATIENT, OUTRO_PACIENTE]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'pr2-completa@e2e.local', 'Completa', 'admin', 'ACTIVE', true, $3),
         ($2, 'pr2-sem-familia@e2e.local', 'Sem familia', 'admin', 'ACTIVE', true, $3)`,
      [U.completa, U.semFamilia, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) {
      await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    }
    await grupoComCelulas(pool, { nome: GRUPOS.completa, uid: U.completa, celulas: [['patient', 'read'], ['patient_family', 'read'], ['patient_family', 'create'], ['patient_family', 'update']] });
    await grupoComCelulas(pool, { nome: GRUPOS.semFamilia, uid: U.semFamilia, celulas: [['patient', 'read']] });
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-pr2-a', 'Paciente', 'Sintético', 'AR', true),
         ($2, 'e2e-pr2-b', 'Outro', 'Paciente', 'AR', true)`,
      [PATIENT, OUTRO_PACIENTE],
    );

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const caseModule = await import('@modules/case');
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

  const EXT_ROWS = () => `/api/admin/patients/${PATIENT}/external-contacts`;
  const EXT_ROW = (id: string) => `/api/admin/patients/${PATIENT}/external-contacts/${id}`;
  const EXT_DEACTIVATE = (id: string) => `/api/admin/patients/${PATIENT}/external-contacts/${id}/deactivate`;
  const EMERGENCY = () => `/api/admin/patients/${PATIENT}/emergency-contact`;
  const RESP_ROWS = () => `/api/admin/patients/${PATIENT}/responsibles`;
  const DETAIL = () => `/api/admin/patients/${PATIENT}`;

  const linhasAtivas = async () => (await pool.query<{ id: string; relation: string; name: string; phone_encrypted: string | null; active: boolean }>(
    `SELECT id, relation, name, phone_encrypted, active FROM patient_external_contacts WHERE patient_id = $1 AND active ORDER BY sort_order`, [PATIENT],
  )).rows;
  const todasAsLinhas = async () => (await pool.query<{ id: string; active: boolean }>(
    `SELECT id, active FROM patient_external_contacts WHERE patient_id = $1 ORDER BY sort_order`, [PATIENT],
  )).rows;
  const marcaAtual = async () => (await pool.query<{ emergency_responsible_id: string | null; emergency_external_contact_id: string | null }>(
    `SELECT emergency_responsible_id, emergency_external_contact_id FROM patients WHERE id = $1`, [PATIENT],
  )).rows[0];

  const idsCriados: Record<string, string> = {};
  let responsavelId: string;

  it('1. POST por linha, 2 vezes → 201 cada; telefone CIFRADO no banco, país forçado do paciente', async () => {
    const c1 = await chamar('POST', EXT_ROWS(), U.completa, { relation: 'TEACHER', name: 'Prof. Gómez', phone: '11-5555-0001' });
    expect(c1.status).toBe(201);
    idsCriados.TEACHER = c1.body.data.id;
    const c2 = await chamar('POST', EXT_ROWS(), U.completa, { relation: 'NEIGHBOR', name: 'Vecina Sintética' });
    expect(c2.status).toBe(201);
    idsCriados.NEIGHBOR = c2.body.data.id;

    const rows = await linhasAtivas();
    expect(rows.map((r) => [r.relation, r.name])).toEqual([['TEACHER', 'Prof. Gómez'], ['NEIGHBOR', 'Vecina Sintética']]);
    const teacher = rows.find((r) => r.relation === 'TEACHER')!;
    expect(teacher.phone_encrypted).not.toBeNull();
    expect(teacher.phone_encrypted).not.toContain('5555-0001');
    const vecina = rows.find((r) => r.relation === 'NEIGHBOR')!;
    expect(vecina.phone_encrypted).toBeNull(); // telefone é opcional
  });

  it('2. leitura por célula: completa vê os contatos; SEM patient_family vê null + redacted', async () => {
    const completa = await chamar('GET', DETAIL(), U.completa);
    expect(completa.status).toBe(200);
    expect(completa.body.data.externalContacts.map((c: any) => [c.relation, c.name, c.phone])).toEqual([
      ['TEACHER', 'Prof. Gómez', '11-5555-0001'],
      ['NEIGHBOR', 'Vecina Sintética', null],
    ]);
    expect(completa.body.data.redacted ?? {}).not.toHaveProperty('family');

    const semFamilia = await chamar('GET', DETAIL(), U.semFamilia);
    expect(semFamilia.status).toBe(200);
    expect(semFamilia.body.data.externalContacts).toBeNull();
    expect(semFamilia.body.data.redacted).toHaveProperty('family', true);
    expect(JSON.stringify(semFamilia.body)).not.toContain('Prof. Gómez');
  });

  it('3. escrita: sem `patient_family:write` → 403 e o banco não muda; relation fora do enum → 400; chave a mais → 400', async () => {
    const proibido = await chamar('POST', EXT_ROWS(), U.semFamilia, { relation: 'TEACHER', name: 'x' });
    expect(proibido.status).toBe(403);
    expect(await linhasAtivas()).toHaveLength(2);
    const relacaoRuim = await chamar('POST', EXT_ROWS(), U.completa, { relation: 'THERAPIST', name: 'x' });
    expect(relacaoRuim.status).toBe(400);
    const chaveAMais = await chamar('POST', EXT_ROWS(), U.completa, { relation: 'TEACHER', name: 'x', documentNumber: '123' });
    expect(chaveAMais.status).toBe(400);
    expect(await linhasAtivas()).toHaveLength(2);
  });

  it('4. PATCH parcial edita só o campo mandado; id de OUTRO paciente → 404', async () => {
    const editar = await chamar('PATCH', EXT_ROW(idsCriados.NEIGHBOR), U.completa, { name: 'Vecina Renomeada' });
    expect(editar.status).toBe(200);
    const rows = await linhasAtivas();
    expect(rows.find((r) => r.id === idsCriados.NEIGHBOR)!.name).toBe('Vecina Renomeada');
    expect(rows.find((r) => r.id === idsCriados.TEACHER)!.name).toBe('Prof. Gómez'); // intacto

    const noOutroPaciente = await chamar('PATCH', `/api/admin/patients/${OUTRO_PACIENTE}/external-contacts/${idsCriados.TEACHER}`, U.completa, { name: 'x' });
    expect(noOutroPaciente.status).toBe(404);
  });

  it('5. marca de emergência: D-A#3 recusa contato SEM telefone (422); aceita o que tem telefone (200)', async () => {
    const semTelefone = await chamar('PUT', EMERGENCY(), U.completa, { kind: 'EXTERNAL', id: idsCriados.NEIGHBOR });
    expect(semTelefone.status).toBe(422);
    expect(semTelefone.body.code).toBe('EMERGENCY_CONTACT_REQUIRES_PHONE');
    expect(await marcaAtual()).toMatchObject({ emergency_responsible_id: null, emergency_external_contact_id: null });

    const comTelefone = await chamar('PUT', EMERGENCY(), U.completa, { kind: 'EXTERNAL', id: idsCriados.TEACHER });
    expect(comTelefone.status).toBe(200);
    expect(comTelefone.body.data.emergencyContactRef).toEqual({ kind: 'EXTERNAL', id: idsCriados.TEACHER });
    expect(await marcaAtual()).toMatchObject({ emergency_external_contact_id: idsCriados.TEACHER });

    const detail = await chamar('GET', DETAIL(), U.completa);
    expect(detail.body.data.emergencyContactRef).toEqual({ kind: 'EXTERNAL', id: idsCriados.TEACHER });
  });

  it('6. SUP-40 — apagar o telefone do contato MARCADO é bloqueado (422); a marca continua intacta', async () => {
    const apagar = await chamar('PATCH', EXT_ROW(idsCriados.TEACHER), U.completa, { phone: null });
    expect(apagar.status).toBe(422);
    expect(apagar.body.code).toBe('EMERGENCY_CONTACT_REQUIRES_PHONE');
    expect(await marcaAtual()).toMatchObject({ emergency_external_contact_id: idsCriados.TEACHER });
    const rows = await linhasAtivas();
    expect(rows.find((r) => r.id === idsCriados.TEACHER)!.phone_encrypted).not.toBeNull();
  });

  it('7. D-A#1 — marcar um RESPONSIBLE troca a marca (limpa a coluna do externo, nunca as duas preenchidas)', async () => {
    const respCriado = await chamar('POST', RESP_ROWS(), U.completa, { firstName: 'Resp', lastName: 'Sintético', phone: '11-4444-0001' });
    expect(respCriado.status).toBe(201);
    responsavelId = respCriado.body.data.id;

    const trocar = await chamar('PUT', EMERGENCY(), U.completa, { kind: 'RESPONSIBLE', id: responsavelId });
    expect(trocar.status).toBe(200);
    const marca = await marcaAtual();
    expect(marca.emergency_responsible_id).toBe(responsavelId);
    expect(marca.emergency_external_contact_id).toBeNull(); // a marca anterior (externo) foi limpa
  });

  it('8. D-A#4 — desativar o contato externo MARCADO limpa a marca na mesma transação (emergencyMarkCleared)', async () => {
    // Remarca no externo (TEACHER) para testar a limpeza-por-desativação NELE.
    await chamar('PUT', EMERGENCY(), U.completa, { kind: 'EXTERNAL', id: idsCriados.TEACHER });
    expect((await marcaAtual()).emergency_external_contact_id).toBe(idsCriados.TEACHER);

    const desativar = await chamar('POST', EXT_DEACTIVATE(idsCriados.TEACHER), U.completa);
    expect(desativar.status).toBe(200);
    expect(desativar.body.data).toEqual({ id: idsCriados.TEACHER, active: false, emergencyMarkCleared: true });
    expect(await marcaAtual()).toMatchObject({ emergency_external_contact_id: null });

    const detail = await chamar('GET', DETAIL(), U.completa);
    expect(detail.body.data.emergencyContactRef).toBeNull();
    expect(detail.body.data.externalContacts.map((c: any) => c.id)).not.toContain(idsCriados.TEACHER); // sumiu da FICHA
  });

  it('9. FR-002 — desativar é `active=false`, NUNCA DELETE — a linha continua no banco', async () => {
    const todas = await todasAsLinhas();
    expect(todas.map((r) => r.id)).toContain(idsCriados.TEACHER);
    expect(todas.find((r) => r.id === idsCriados.TEACHER)!.active).toBe(false);
    // Desativar de novo → 409 (já inativa).
    expect((await chamar('POST', EXT_DEACTIVATE(idsCriados.TEACHER), U.completa)).status).toBe(409);
  });

  it('10. DELETE /emergency-contact desmarca (idempotente mesmo sem marca vigente)', async () => {
    await chamar('PUT', EMERGENCY(), U.completa, { kind: 'RESPONSIBLE', id: responsavelId });
    const desmarcar = await chamar('DELETE', EMERGENCY(), U.completa);
    expect(desmarcar.status).toBe(200);
    expect(desmarcar.body.data).toEqual({ emergencyContactRef: null });
    expect(await marcaAtual()).toMatchObject({ emergency_responsible_id: null, emergency_external_contact_id: null });
    // De novo, sem nada marcado: ainda 200.
    expect((await chamar('DELETE', EMERGENCY(), U.completa)).status).toBe(200);
  });

  it('11. PUT /emergency-contact: 404 quando o contato não é do paciente ou está inativo', async () => {
    const deOutroPaciente = await chamar('PUT', `/api/admin/patients/${OUTRO_PACIENTE}/emergency-contact`, U.completa, { kind: 'RESPONSIBLE', id: responsavelId });
    expect(deOutroPaciente.status).toBe(404);
    const inativo = await chamar('PUT', EMERGENCY(), U.completa, { kind: 'EXTERNAL', id: idsCriados.TEACHER }); // já desativado no teste 8
    expect(inativo.status).toBe(404);
  });

  it('12. sem `patient_family:write` → 403 em PUT/DELETE emergency-contact', async () => {
    expect((await chamar('PUT', EMERGENCY(), U.semFamilia, { kind: 'RESPONSIBLE', id: responsavelId })).status).toBe(403);
    expect((await chamar('DELETE', EMERGENCY(), U.semFamilia)).status).toBe(403);
  });
});
