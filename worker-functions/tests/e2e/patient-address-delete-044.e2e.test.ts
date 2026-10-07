/**
 * patient-address-delete-044.e2e.test.ts @integration — spec 044, D4 (remover Localización).
 *
 * API real + Postgres real (migrations 500/501 já aplicadas no stack). Molde de wiring:
 * `patient-address-principal-tipo.e2e.test.ts` (token mock COM `country`, grupo ABAC semeado nas tabelas `iam.*`).
 *
 *   A4   DELETE com vaga FECHADA apontando            → 409 ADDRESS_IN_USE, linha continua
 *   A4b  DELETE com vaga SOFT-DELETED apontando       → 409 (deleted_at não libera a FK 149)
 *   A5   DELETE com serviço INATIVO apontando         → 409
 *   A6   DELETE sem referência                        → 204 e a linha some
 *   A7   Principal com outro ativo → 409 PRIMARY_WITH_OTHERS; Principal sozinho → 204
 *   A9   DELETE aceito grava exatamente 1 linha em patient_address_audit_log (ator, created_at, patient_id,
 *        address_id, address_type, neighborhood)
 *   A10  a linha NÃO tem as chaves address_formatted/address_raw e NENHUM valor do jsonb é igual ao texto semeado
 *   A15  sem a célula patient_address:delete → 403 (a linha continua)
 *
 * Endereços de ficção. O texto semeado é conferido em CLARO contra a linha de auditoria só para provar a ausência.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { garantirCelula } from './helpers/permissionFamilyHarness';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT_E2E = '00000000-0000-0000-0000-000000000001';
const ADMIN_UID = 'addr-delete-044-admin';
const SEM_CELULA_UID = 'addr-delete-044-sem-celula';
const PREFIXO = 'addr-delete-044-e2e-';
const TEXTO_SEMEADO = 'Calle Falsa 123, Ciudad Ficticia 044';
const ZONA = 'Barrio Ficticio 044';

/** Mock token COM `country` (nenhum helper do backend inclui; ver cabeçalho do molde). */
function tokenComPais(uid: string): { headers: { Authorization: string } } {
  const data = Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role: 'admin', country: 'AR' })).toString('base64');
  return { headers: { Authorization: `Bearer mock_${data}` } };
}

describe('DELETE /api/admin/patients/:patientId/addresses/:addressId (spec 044) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: { headers: { Authorization: string } };
  let asSemCelula: { headers: { Authorization: string } };
  const grupos: string[] = [];
  const celulasCriadas: Array<[string, string]> = [];
  let seq = 0;

  /** Cria um paciente novo com N endereços; devolve ids. O 1º é o Principal (is_default). */
  async function pacienteComEnderecos(n: number): Promise<{ patientId: string; addressIds: string[] }> {
    const patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'Delete', 'Cuarenta', 'AR', 'ACTIVE') RETURNING id`,
      [`${PREFIXO}${++seq}-${Date.now()}`],
    )).rows[0].id;
    const addressIds: string[] = [];
    for (let i = 0; i < n; i++) {
      addressIds.push((await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, address_type, address_formatted, address_raw, neighborhood, is_default, display_order, country)
         VALUES ($1, 'casa_madre', $2, $2, $3, $4, $5, 'AR') RETURNING id`,
        [patientId, TEXTO_SEMEADO, ZONA, i === 0, i + 1],
      )).rows[0].id);
    }
    return { patientId, addressIds };
  }
  const existe = async (addressId: string): Promise<boolean> =>
    (await pool.query(`SELECT 1 FROM patient_addresses WHERE id = $1`, [addressId])).rowCount === 1;
  const del = (patientId: string, addressId: string, who = asAdmin) =>
    api.delete(`/api/admin/patients/${patientId}/addresses/${addressId}`, who);

  async function criarGrupo(uid: string, nome: string, celulas: Array<[string, string]>): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
       VALUES ($1, $2, $3, 'admin', true, 'ACTIVE', $4) ON CONFLICT (firebase_uid) DO NOTHING`,
      [uid, `${uid}@e2e.local`, `E2E ${uid}`, TENANT_E2E],
    );
    const grupoId = (await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e — nao mexer manual') RETURNING id`,
      [TENANT_E2E, nome],
    )).rows[0].id;
    grupos.push(grupoId);
    await pool.query(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ($1, 'AR', $2, 'e2e setup')`, [grupoId, uid]);
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [uid, grupoId, TENANT_E2E]);
    for (const [resource, action] of celulas) {
      const inserted = await pool.query(
        `INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = $2 AND action = $3`,
        [grupoId, resource, action],
      );
      if (inserted.rowCount === 0) throw new Error(`célula ${resource}:${action} não existe em iam.permissions`);
    }
  }

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = tokenComPais(ADMIN_UID);
    asSemCelula = tokenComPais(SEM_CELULA_UID);
    pool = new Pool({ connectionString: DATABASE_URL });
    // vaga tem FK RESTRICT para o endereço (149): sai antes do paciente (a cascata apagaria o endereço primeiro).
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${PREFIXO}%')`);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE '${PREFIXO}%'`);
    for (const [resource, action] of [['patient_address', 'delete'], ['patient_address', 'update']] as const) {
      const { criada } = await garantirCelula(pool, { resource, action, category: 'Pacientes' });
      if (criada) celulasCriadas.push([resource, action]);
    }
    await criarGrupo(ADMIN_UID, 'E2E addr-delete-044', [['patient_address', 'delete']]);
    // A15: quem edita endereço (update) mas NÃO tem delete não pode remover.
    await criarGrupo(SEM_CELULA_UID, 'E2E addr-delete-044 sem delete', [['patient_address', 'update']]);
  });

  afterAll(async () => {
    // vaga tem FK RESTRICT para o endereço (149): sai antes do paciente (a cascata apagaria o endereço primeiro).
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${PREFIXO}%')`);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE '${PREFIXO}%'`); // cascata leva endereços, vagas, serviços e auditoria
    for (const grupoId of grupos) {
      await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id IN ($1, $2)`, [ADMIN_UID, SEM_CELULA_UID]);
      await pool.query(`DELETE FROM resource_access_log WHERE operator_uid IN ($1, $2)`, [ADMIN_UID, SEM_CELULA_UID]);
      await pool.query(`DELETE FROM iam.permission_group_changes WHERE group_id = $1`, [grupoId]);
      await pool.query(`DELETE FROM iam.user_groups WHERE group_id = $1`, [grupoId]);
      await pool.query(`DELETE FROM iam.group_permissions WHERE group_id = $1`, [grupoId]);
      await pool.query(`DELETE FROM iam.group_country_scopes WHERE group_id = $1`, [grupoId]);
      await pool.query(`DELETE FROM iam.permission_groups WHERE id = $1`, [grupoId]);
    }
    await pool.query(`DELETE FROM users WHERE firebase_uid IN ($1, $2)`, [ADMIN_UID, SEM_CELULA_UID]);
    for (const [resource, action] of celulasCriadas) {
      await pool.query(`DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`, [resource, action]);
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
    await pool.end();
  });

  it('A6 — sem nenhuma referência: 204 e a linha some', async () => {
    const { patientId, addressIds } = await pacienteComEnderecos(2);
    const r = await del(patientId, addressIds[1]);
    expect(r.status).toBe(204);
    expect(await existe(addressIds[1])).toBe(false);
    expect(await existe(addressIds[0])).toBe(true);
  }, 30000);

  it('A4 — vaga FECHADA apontando: 409 ADDRESS_IN_USE com contagem, e a linha continua', async () => {
    const { patientId, addressIds } = await pacienteComEnderecos(2);
    await pool.query(
      `INSERT INTO job_postings (title, patient_id, patient_address_id, is_draft, status) VALUES ('e2e 044 vaga fechada', $1, $2, false, 'CLOSED')`,
      [patientId, addressIds[1]],
    );
    const r = await del(patientId, addressIds[1]);
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ success: false, error: 'ADDRESS_IN_USE', details: { vacancies: 1, services: 0 } });
    expect(await existe(addressIds[1])).toBe(true);
  }, 30000);

  it('A4b — vaga SOFT-DELETED apontando: 409 (deleted_at não libera a FK 149)', async () => {
    const { patientId, addressIds } = await pacienteComEnderecos(2);
    await pool.query(
      `INSERT INTO job_postings (title, patient_id, patient_address_id, is_draft, status, deleted_at) VALUES ('e2e 044 vaga apagada', $1, $2, false, 'CLOSED', NOW())`,
      [patientId, addressIds[1]],
    );
    const r = await del(patientId, addressIds[1]);
    expect(r.status).toBe(409);
    expect(r.data.details).toEqual({ vacancies: 1, services: 0 });
    expect(await existe(addressIds[1])).toBe(true);
  }, 30000);

  it('A5 — serviço contratado INATIVO apontando: 409', async () => {
    const { patientId, addressIds } = await pacienteComEnderecos(2);
    await pool.query(
      `INSERT INTO patient_contracted_services (patient_id, service_code, active, address_id, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', false, $2, 'e2e-044', 'e2e-044')`,
      [patientId, addressIds[1]],
    );
    const r = await del(patientId, addressIds[1]);
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ success: false, error: 'ADDRESS_IN_USE', details: { vacancies: 0, services: 1 } });
    expect(await existe(addressIds[1])).toBe(true);
  }, 30000);

  it('A7 — Principal com OUTRO endereço ativo: 409 PRIMARY_WITH_OTHERS; Principal SOZINHO: 204', async () => {
    const dois = await pacienteComEnderecos(2);
    const r1 = await del(dois.patientId, dois.addressIds[0]); // [0] é o Principal
    expect(r1.status).toBe(409);
    expect(r1.data).toEqual({ success: false, error: 'PRIMARY_WITH_OTHERS' });
    expect(await existe(dois.addressIds[0])).toBe(true);

    const sozinho = await pacienteComEnderecos(1);
    const r2 = await del(sozinho.patientId, sozinho.addressIds[0]);
    expect(r2.status).toBe(204);
    expect(await existe(sozinho.addressIds[0])).toBe(false);
  }, 30000);

  it('404 — endereço de OUTRO paciente não é apagado pela rota deste', async () => {
    const a = await pacienteComEnderecos(1);
    const b = await pacienteComEnderecos(2);
    const r = await del(a.patientId, b.addressIds[1]);
    expect(r.status).toBe(404);
    expect(await existe(b.addressIds[1])).toBe(true);
  }, 30000);

  it('A9/A10 — DELETE aceito grava exatamente 1 linha de auditoria, sem texto de endereço', async () => {
    const { patientId, addressIds } = await pacienteComEnderecos(2);
    const antes = await pool.query(`SELECT 1 FROM patient_address_audit_log WHERE patient_id = $1`, [patientId]);
    expect(antes.rowCount).toBe(0);

    expect((await del(patientId, addressIds[1])).status).toBe(204);

    const { rows } = await pool.query(
      `SELECT patient_id, event_type, field_name, changes, actor_user_id, actor_type, created_at FROM patient_address_audit_log WHERE patient_id = $1`,
      [patientId],
    );
    expect(rows).toHaveLength(1); // controle: a query ACHA a linha, então o "0" abaixo não é "não olhei"
    const linha = rows[0];
    expect(linha.patient_id).toBe(patientId);
    expect(linha.event_type).toBe('DELETED');
    expect(linha.actor_user_id).toBe(ADMIN_UID);
    expect(linha.actor_type).toBe('HUMAN');
    expect(linha.created_at).toBeInstanceOf(Date);
    expect(linha.changes).toEqual({
      before: { address_id: addressIds[1], address_type: 'casa_madre', neighborhood: ZONA },
      after: null,
    });

    // A10: nenhuma chave de texto e nenhum valor igual ao texto semeado, em nenhuma coluna da linha.
    const bruto = JSON.stringify(linha);
    expect(bruto).not.toContain('address_formatted');
    expect(bruto).not.toContain('address_raw');
    expect(bruto).not.toContain(TEXTO_SEMEADO);
    const valores = Object.values(linha.changes.before as Record<string, unknown>);
    expect(valores).not.toContain(TEXTO_SEMEADO);
  }, 30000);

  it('A9 — DELETE recusado NÃO grava auditoria', async () => {
    const { patientId, addressIds } = await pacienteComEnderecos(2);
    expect((await del(patientId, addressIds[0])).status).toBe(409); // Principal com outro
    const { rowCount } = await pool.query(`SELECT 1 FROM patient_address_audit_log WHERE patient_id = $1`, [patientId]);
    expect(rowCount).toBe(0);
  }, 30000);

  it('A15 — quem tem patient_address:update mas NÃO patient_address:delete leva 403 e a linha continua', async () => {
    const { patientId, addressIds } = await pacienteComEnderecos(2);
    const r = await del(patientId, addressIds[1], asSemCelula);
    expect(r.status).toBe(403);
    expect(await existe(addressIds[1])).toBe(true);
  }, 30000);
});
