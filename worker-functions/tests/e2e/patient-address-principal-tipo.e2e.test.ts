/**
 * patient-address-principal-tipo.e2e.test.ts @integration — spec 019 (D310 item c), tasks 5.3/5.4.
 *
 * API real + Postgres real (migrations 433/434 já aplicadas no stack). Prova de ponta a ponta,
 * sem mock, contra o stack Docker isolado do projeto `019e2e`:
 *
 *   5.3 feliz — troca de principal por PATCH: banco nunca com 0 nem 2 principais ativos.
 *   5.3 alt1 — endereço novo sem principal existente (POST sem is_default) nasce principal.
 *   5.3 alt2 — CONCORRÊNCIA real: N rodadas de duas requisições HTTP simultâneas marcando
 *              principais diferentes — uma vence (200), a outra recebe 409 tratado (nunca 500),
 *              e o banco termina cada rodada com exatamente 1 principal ativo.
 *   5.4 feliz — PATCH com address_type + is_default persiste e sobrevive a um GET novo
 *              (`/api/admin/patients/:id`, campo `addresses[].addressType`/`isPrimary`).
 *   5.4 alt1 — address_type_other com 41 caracteres → 400 do servidor (não do zod isolado).
 *
 * Molde de concorrência: tests/e2e/t5-diagnosis-concurrency.e2e.test.ts (Pool do pg,
 * Promise.allSettled, contagem no banco após cada rodada).
 *
 * ⚠️ Engine ABAC LIGADO (sessão 019-abac, 12/09/2026): a suíte original confiava no papel
 * `admin` sozinho (`untilEnforced`/bypass de papel) para passar pelas rotas de endereço. Com
 * `PERMISSION_ENGINE_ENABLED=true` e `patient`/`patient_address` fora de `untilEnforced`, o
 * papel deixa de bastar — o `perm.require` do controller (`adminPatientsRoutes.ts`) exige a
 * CÉLULA de verdade. O `beforeAll` abaixo semeia o staff `admin` num grupo com país AR e
 * concede `patient:read` + `patient_address:read/write` diretamente nas tabelas `iam.*` (mesmo
 * padrão do `abac-stack-helper.ts` do frontend) — sem isso toda chamada `asAdmin` vira 403.
 *
 * ⚠️ SEGUNDO achado, medido pelo log da API ("[abac] staff sem claim de país válido —
 * consultas protegidas retornam zero linhas"): nem `tests/e2e/helpers/staffAuth.ts` nem
 * `tests/e2e/helpers/permissionFamilyHarness.ts` (os dois helpers de mock-token do backend)
 * incluem `country` no token — o `MockAuthMiddleware` só lê o que o token trouxer, então SEM
 * país o request autentica mas toda query com policy de país (a rota de endereço é uma) devolve
 * zero linhas por trás de um 403/404 silencioso. Nenhum dos dois é reaproveitável aqui sem
 * mudar sua assinatura pública (usada por outras suítes) — o token abaixo é construído INLINE,
 * mesmo formato `mock_<base64>`, só que com `country` incluso (molde: `tokenFor`/`MockUser` do
 * `abac-stack-helper.ts` do frontend).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ROUNDS = 10;
const TENANT_E2E = '00000000-0000-0000-0000-000000000001';
const ADMIN_UID = 'addr-principal-admin';

/** Mock token COM `country` — nenhum helper existente do backend cobre isto (ver cabeçalho). */
function tokenComPais(uid: string, role: string, country: string): { headers: { Authorization: string } } {
  const data = Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role, country })).toString('base64');
  return { headers: { Authorization: `Bearer mock_${data}` } };
}

describe('Endereço PRINCIPAL + TIPO por parentesco (spec 019) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let patientId = '';

  const countActivePrincipals = async (pid: string): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM patient_addresses WHERE patient_id = $1 AND is_default AND archived_at IS NULL`,
      [pid],
    );
    return Number(rows[0].n);
  };

  let grupoId = '';

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = tokenComPais(ADMIN_UID, 'admin', 'AR');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'addr-principal-e2e-%'`);
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('addr-principal-e2e-1', 'Principal', 'Tipo', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;

    // Engine ABAC ligado: sem grupo+célula, `asAdmin` (papel `admin`, sem grupo) leva 403 em
    // toda rota de patient/patient_address. Seed idempotente — `ON CONFLICT DO NOTHING`.
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
       VALUES ('addr-principal-admin', 'addr-principal-admin@e2e.local', 'E2E addr-principal-admin', 'admin', true, 'ACTIVE', $1)
       ON CONFLICT (firebase_uid) DO NOTHING`,
      [TENANT_E2E],
    );
    grupoId = (await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description)
       VALUES ($1, 'E2E addr-principal-tipo', 'e2e — nao mexer manual') RETURNING id`,
      [TENANT_E2E],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
       VALUES ($1, 'AR', 'addr-principal-admin', 'e2e setup')`,
      [grupoId],
    );
    await pool.query(
      `INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('addr-principal-admin', $1, $2)`,
      [grupoId, TENANT_E2E],
    );
    for (const [resource, action] of [['patient', 'read'], ['patient_address', 'read'], ['patient_address', 'write']]) {
      const inserted = await pool.query<{ permission_id: string }>(
        `INSERT INTO iam.group_permissions (group_id, permission_id)
         SELECT $1, id FROM iam.permissions WHERE resource = $2 AND action = $3
         RETURNING permission_id`,
        [grupoId, resource, action],
      );
      if (inserted.rowCount === 0) throw new Error(`célula ${resource}:${action} não existe em iam.permissions`);
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patient_addresses WHERE patient_id = $1`, [patientId]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'addr-principal-e2e-%'`);
    if (grupoId) {
      await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = 'addr-principal-admin'`);
      await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = 'addr-principal-admin'`);
      await pool.query(`DELETE FROM iam.permission_group_changes WHERE group_id = $1`, [grupoId]);
      await pool.query(`DELETE FROM iam.user_groups WHERE group_id = $1`, [grupoId]);
      await pool.query(`DELETE FROM iam.group_permissions WHERE group_id = $1`, [grupoId]);
      await pool.query(`DELETE FROM iam.group_country_scopes WHERE group_id = $1`, [grupoId]);
      await pool.query(`DELETE FROM iam.permission_groups WHERE id = $1`, [grupoId]);
    }
    await pool.query(`DELETE FROM users WHERE firebase_uid = 'addr-principal-admin'`);
    await pool.end();
  });

  it('5.3 alt1 — endereço novo sem principal existente (POST sem is_default) nasce principal', async () => {
    const r = await api.post(`/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Rua Principal 1, Buenos Aires' }, asAdmin);
    expect(r.status).toBe(201);
    expect(r.data.data.is_default).toBe(true);
    expect(await countActivePrincipals(patientId)).toBe(1);
  });

  it('5.3 alt1(b) — um segundo endereço criado sem is_default NÃO nasce principal (já existe um)', async () => {
    const r = await api.post(`/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Rua Secundaria 2, Buenos Aires' }, asAdmin);
    expect(r.status).toBe(201);
    expect(r.data.data.is_default).toBe(false);
    expect(await countActivePrincipals(patientId)).toBe(1);
  });

  it('5.3 feliz — PATCH troca o principal atomicamente: nunca 0 nem 2 principais', async () => {
    const g0 = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    const [addrA, addrB] = g0.data.data.addresses as Array<{ id: string; isPrimary: boolean }>;
    expect(addrA.isPrimary).toBe(true);
    expect(addrB.isPrimary).toBe(false);

    const r = await api.patch(`/api/admin/patients/${patientId}/addresses/${addrB.id}`, { is_default: true }, asAdmin);
    expect(r.status).toBe(200);
    expect(await countActivePrincipals(patientId)).toBe(1);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM patient_addresses WHERE patient_id = $1 AND is_default AND archived_at IS NULL`, [patientId],
    );
    expect(rows[0].id).toBe(addrB.id);
  }, 30000);

  it('5.3 alt2 — CONCORRÊNCIA real: 2 requisições HTTP simultâneas marcando principais diferentes, N rodadas', async () => {
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    const [addrA, addrB] = g.data.data.addresses as Array<{ id: string }>;
    const statuses: number[] = [];
    const errosDeRede: string[] = [];

    for (let i = 0; i < ROUNDS; i++) {
      const req = (addressId: string) =>
        api.patch(`/api/admin/patients/${patientId}/addresses/${addressId}`, { is_default: true }, asAdmin);

      const resultados = await Promise.allSettled([req(addrA.id), req(addrB.id)]);
      const rodadaStatuses: number[] = [];
      for (const r of resultados) {
        if (r.status === 'rejected') {
          errosDeRede.push(String((r as PromiseRejectedResult).reason));
        } else {
          const status = (r as PromiseFulfilledResult<{ status: number }>).value.status;
          statuses.push(status);
          rodadaStatuses.push(status);
        }
      }
      // Invariante do banco, checado a CADA rodada: nunca 0, nunca 2 principais ativos (spec 019
      // linhas 103-104/113-114 — a garantia DURA é "nunca 0 ou 2 principais" / "ao final,
      // exatamente 1 principal ativo"; não "sempre 1×200 e 1×409").
      expect(await countActivePrincipals(patientId)).toBe(1);
      // Nunca as duas falham: cada rodada tem sempre pelo menos um PATCH bem-sucedido — se
      // ambos falhassem (0 vitórias), nenhum dos dois cliques do usuário teria efeito, o que
      // violaria a troca atômica da spec.
      expect(rodadaStatuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    }

    // 0 erro de rede/exceção crua escapando do axios.
    expect(errosDeRede).toEqual([]);
    // 0 HTTP 500 em toda a corrida (2 * ROUNDS respostas).
    expect(statuses.filter((s) => s === 500)).toEqual([]);
    expect(statuses).toHaveLength(2 * ROUNDS);
    // Toda resposta é 200 (vitória, inclusive reafirmação idempotente de quem já era principal)
    // ou 409 (perda tratada pelo índice único/lock) — nunca outra coisa.
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    // Pelo menos 1 vitória por rodada já é verificado acima; aqui confirmamos que 409 SÓ ocorre
    // quando de fato houve disputa pelo mesmo slot (nunca mais 409 do que rodadas — isso
    // indicaria as duas falhando na mesma rodada, o que a asserção por rodada já barra).
    const count409 = statuses.filter((s) => s === 409).length;
    expect(count409).toBeLessThanOrEqual(ROUNDS);
  }, 60000);

  it('5.4 feliz — PATCH com address_type persiste e sobrevive a um GET novo', async () => {
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    const [addrA] = g.data.data.addresses as Array<{ id: string }>;

    const patch = await api.patch(`/api/admin/patients/${patientId}/addresses/${addrA.id}`,
      { address_type: 'casa_madre' }, asAdmin);
    expect(patch.status).toBe(200);

    const reload = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    const reloaded = (reload.data.data.addresses as Array<{ id: string; addressType: string | null }>)
      .find((a) => a.id === addrA.id);
    expect(reloaded?.addressType).toBe('casa_madre');

    // Sobre "Otro": address_type_other só é aceito junto de address_type: "otro".
    const otro = await api.patch(`/api/admin/patients/${patientId}/addresses/${addrA.id}`,
      { address_type: 'otro', address_type_other: 'Casa de una tía cercana' }, asAdmin);
    expect(otro.status).toBe(200);
    const reload2 = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    const reloaded2 = (reload2.data.data.addresses as Array<{ id: string; addressType: string | null; addressTypeOther?: string | null }>)
      .find((a) => a.id === addrA.id);
    expect(reloaded2?.addressType).toBe('otro');
    // K9: address_type_other também sobrevive ao reload — não só o enum.
    expect(reloaded2?.addressTypeOther).toBe('Casa de una tía cercana');
  });

  it('5.3 alt3 — PATCH is_default:false → 400 e o principal continua o mesmo (override 12/09: desmarcar só marcando OUTRO)', async () => {
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    const [addrA, addrB] = g.data.data.addresses as Array<{ id: string; isPrimary: boolean }>;
    const principalAntes = addrA.isPrimary ? addrA.id : addrB.id;

    const r = await api.patch(`/api/admin/patients/${patientId}/addresses/${principalAntes}`,
      { is_default: false }, asAdmin);
    expect(r.status).toBe(400);
    expect(await countActivePrincipals(patientId)).toBe(1);

    const reload = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    const stillPrimary = (reload.data.data.addresses as Array<{ id: string; isPrimary: boolean }>)
      .find((a) => a.id === principalAntes);
    expect(stillPrimary?.isPrimary).toBe(true);
  });

  it('5.4 alt1 — address_type_other com 41 caracteres → 400 do servidor (não do zod isolado)', async () => {
    const g = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    const [addrA] = g.data.data.addresses as Array<{ id: string }>;
    const tooLong = 'a'.repeat(41);
    const r = await api.patch(`/api/admin/patients/${patientId}/addresses/${addrA.id}`,
      { address_type: 'otro', address_type_other: tooLong }, asAdmin);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.data)).not.toContain(tooLong);

    // Confirma que o banco NÃO gravou o texto longo (o 400 é do servidor, não só do cliente).
    const { rows } = await pool.query<{ address_type_other: string | null }>(
      `SELECT address_type_other FROM patient_addresses WHERE id = $1`, [addrA.id],
    );
    expect(rows[0].address_type_other).not.toBe(tooLong);
  });

  // K5 (spec 019): dois POSTs concorrentes para um paciente SEM nenhum principal ativo — os dois
  // podem calcular `isDefault=true` (nenhum enxergou o principal do outro ainda) antes do INSERT;
  // o índice único parcial recusa o segundo, que deve responder 409 tratado (nunca 500), e o banco
  // termina com exatamente 1 principal. NÃO executado nesta rodada (stack Docker completa — ver
  // controle de RAM do dispatch).
  it('K5 — POST concorrente: dois "+ Nuevo" simultâneos num paciente sem principal, um vence com 201, o outro 409', async () => {
    const p2 = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('addr-principal-e2e-concurrent-post', 'Concurrent', 'Post', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
    try {
      const post = (formatted: string) =>
        api.post(`/api/admin/patients/${p2}/addresses`, { address_formatted: formatted }, asAdmin);

      const resultados = await Promise.allSettled([
        post('Rua Concorrente A, Buenos Aires'),
        post('Rua Concorrente B, Buenos Aires'),
      ]);

      const statuses = resultados.map((r) =>
        r.status === 'fulfilled' ? (r as PromiseFulfilledResult<{ status: number }>).value.status : -1);
      expect(statuses).not.toContain(-1); // 0 erro de rede/exceção crua escapando do axios
      expect(statuses.filter((s) => s === 500)).toEqual([]);
      // Um 201 (o vencedor) + um 409 (o perdedor tratado) — nunca os dois 201.
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(1);
      expect(await countActivePrincipals(p2)).toBe(1);
    } finally {
      await pool.query(`DELETE FROM patient_addresses WHERE patient_id = $1`, [p2]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [p2]);
    }
  }, 30000);
});
