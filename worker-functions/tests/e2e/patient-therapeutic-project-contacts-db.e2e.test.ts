/**
 * Spec 018 PR-7 — `patient_therapeutic_project_contacts` (migration 429), no BANCO REAL.
 *
 * O que cada teste prova (contrato do bloco A3, checklists/lex-pr7.md C1/C10/C11):
 *   C1. `country` não resolvível é RECUSADO — o NOT NULL é backstop independente do trigger
 *       (etapa 1/3), a coluna é NOT NULL de fato (etapa 2/3, information_schema), e o CHECK
 *       AR/BR recusa qualquer outro valor (etapa 3/3), mesmo molde do lex C1 (416/422).
 *   C4. Desmarcar a emergência de um contato EXTERNO referenciado por uma versão e depois
 *       anonimizar (telefone → NULL → nome → '[contacto anonimizado]' → active=false) passa
 *       sem ser barrado pela FK/trigger da 429 — a ligação (mesmo id) e a versão continuam de
 *       pé. Controle: zerar o telefone ANTES de desmarcar é recusado (SUP-40, 23514) — prova
 *       que o teste está de fato vendo o trigger da 423, não um caminho morto.
 *   Imutabilidade da 429: UPDATE e DELETE direto na ligação são recusados (ptpc_imutavel,
 *       55000); só o CASCADE da purga do paciente apaga a linha (retenção, adendo OP-18).
 */
import { Pool, PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('429 — ligação versão→contato do projeto terapêutico (banco real)', () => {
  let admin: Pool;
  const IDS = {
    patient: 'ee429000-0a00-0001-0001-000000000001',
  };

  const snapshot = (label: string) => JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', label }]);
  const diag = JSON.stringify([{ uri: 'http://id.who.int/icd/entity/1', code: '8B11', title: 'Sintético' }]);

  async function insertVersion(major: number, minor = 0): Promise<{ id: string }> {
    const s = await admin.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', 'e2e-429-uid', 'e2e-429-uid') RETURNING id`,
      [IDS.patient],
    );
    const res = await admin.query<{ id: string }>(
      `INSERT INTO patient_therapeutic_projects
         (patient_id, major, minor, contracted_service_id, diagnoses, clinical_context, general_objective,
          specific_objectives, activities, pathology_types, start_date, end_date, created_by)
       VALUES ($1, $2, $3, $4, $5, 'contexto sintético e2e', 'objetivo sintético e2e', $6, $7, $8, '2026-09-01', '2026-12-31', 'e2e-429-uid')
       RETURNING id`,
      [IDS.patient, major, minor, s.rows[0].id, diag, snapshot('obj'), snapshot('act'), snapshot('pat')],
    );
    return res.rows[0];
  }

  async function insertExternalContact(opts: { phone?: string | null } = {}): Promise<string> {
    const res = await admin.query<{ id: string }>(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, created_by)
       VALUES ($1, 'NEIGHBOR', 'Contato Sintético 429', $2, 'e2e-429-uid') RETURNING id`,
      [IDS.patient, opts.phone === undefined ? 'cifrado-sintetico' : opts.phone],
    );
    return res.rows[0].id;
  }

  async function cleanup(): Promise<void> {
    await admin.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await cleanup();
    await admin.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, 'e2e-429-a', 'Paciente', 'Sintético', 'AR')`,
      [IDS.patient],
    );
  });

  afterAll(async () => {
    await cleanup();
    await admin.end();
  });

  it('C1. país não resolvível é recusado; coluna NOT NULL de fato; CHECK AR/BR recusa "US"', async () => {
    // etapa 2/3: a coluna é NOT NULL de verdade (information_schema), não só "na prática".
    const col = await admin.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'patient_therapeutic_project_contacts' AND column_name = 'country'`,
    );
    expect(col.rows[0]?.is_nullable).toBe('NO');

    // etapa 1/3 como BACKSTOP: com os triggers desligados (session_replication_role=replica),
    // um patient_id que não corresponde a NENHUM paciente (o trigger que copia patients.country
    // não teria o que copiar) ainda assim não entra — o NOT NULL pega sozinho. Tudo dentro de
    // uma transação que só faz ROLLBACK, para não deixar rastro nem depender de FK desligada.
    const client: PoolClient = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = replica`);
      await expect(
        client.query(
          `INSERT INTO patient_therapeutic_project_contacts
             (version_id, patient_id, contact_kind, external_contact_id, sort_order)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'EXTERNAL', gen_random_uuid(), 0)`,
        ),
      ).rejects.toMatchObject({ code: '23502' }); // not_null_violation
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // etapa 3/3: com o caminho real (paciente, versão e contato existentes e válidos), um
    // country explícito fora de AR/BR é recusado pelo CHECK — o trigger só preenche quando
    // country vem NULL, e aqui ele vem preenchido de propósito.
    const contactId = await insertExternalContact();
    const version = await insertVersion(1);
    await expect(
      admin.query(
        `INSERT INTO patient_therapeutic_project_contacts
           (version_id, patient_id, contact_kind, external_contact_id, sort_order, country)
         VALUES ($1, $2, 'EXTERNAL', $3, 0, 'US')`,
        [version.id, IDS.patient, contactId],
      ),
    ).rejects.toThrow(/ptpc_country_check/);
  });

  it('C4. desmarcar emergência + anonimizar não é barrado pela 429; controle: telefone antes de desmarcar é recusado (SUP-40)', async () => {
    const contactId = await insertExternalContact({ phone: 'telefone-cifrado-429' });
    await admin.query(`UPDATE patients SET emergency_external_contact_id = $1 WHERE id = $2`, [contactId, IDS.patient]);

    const version = await insertVersion(2);
    const ptpc = await admin.query<{ id: string }>(
      `INSERT INTO patient_therapeutic_project_contacts
         (version_id, patient_id, contact_kind, external_contact_id, sort_order)
       VALUES ($1, $2, 'EXTERNAL', $3, 0) RETURNING id`,
      [version.id, IDS.patient, contactId],
    );
    const ptpcId = ptpc.rows[0].id;

    // Controle (SUP-40): zerar o telefone ENQUANTO marcado de emergência é recusado — prova que
    // o teste está vendo de fato o trigger da 423, e não um caminho que nunca dispara.
    await expect(
      admin.query(`UPDATE patient_external_contacts SET phone_encrypted = NULL WHERE id = $1`, [contactId]),
    ).rejects.toMatchObject({ code: '23514' });

    // 1. desmarcar emergência
    await admin.query(`UPDATE patients SET emergency_external_contact_id = NULL WHERE id = $1`, [IDS.patient]);

    // 2. agora o telefone pode ser zerado
    await admin.query(`UPDATE patient_external_contacts SET phone_encrypted = NULL WHERE id = $1`, [contactId]);

    // 3. nome anonimizado
    await admin.query(`UPDATE patient_external_contacts SET name = '[contacto anonimizado]' WHERE id = $1`, [contactId]);

    // 4. desativado
    await admin.query(
      `UPDATE patient_external_contacts SET active = false, deactivated_at = NOW(), deactivated_by = 'e2e-429-uid' WHERE id = $1`,
      [contactId],
    );

    // Nenhum passo acima foi barrado pela FK/trigger da 429: a ligação continua com o MESMO id,
    // apontando pro MESMO contato, dentro da MESMA versão.
    const row = await admin.query<{ id: string; version_id: string; external_contact_id: string }>(
      `SELECT id, version_id, external_contact_id FROM patient_therapeutic_project_contacts WHERE id = $1`,
      [ptpcId],
    );
    expect(row.rows[0]).toEqual({ id: ptpcId, version_id: version.id, external_contact_id: contactId });

    const contact = await admin.query<{ name: string; phone_encrypted: string | null; active: boolean }>(
      `SELECT name, phone_encrypted, active FROM patient_external_contacts WHERE id = $1`,
      [contactId],
    );
    expect(contact.rows[0]).toEqual({ name: '[contacto anonimizado]', phone_encrypted: null, active: false });
  });

  it('Imutabilidade da 429: UPDATE e DELETE direto na ligação são recusados; só o CASCADE da purga do paciente apaga', async () => {
    const contactId = await insertExternalContact();
    const version = await insertVersion(3);
    const ptpc = await admin.query<{ id: string }>(
      `INSERT INTO patient_therapeutic_project_contacts
         (version_id, patient_id, contact_kind, external_contact_id, sort_order)
       VALUES ($1, $2, 'EXTERNAL', $3, 0) RETURNING id`,
      [version.id, IDS.patient, contactId],
    );
    const ptpcId = ptpc.rows[0].id;

    await expect(
      admin.query(`UPDATE patient_therapeutic_project_contacts SET sort_order = 9 WHERE id = $1`, [ptpcId]),
    ).rejects.toThrow(/ptpc_imutavel/);

    await expect(
      admin.query(`DELETE FROM patient_therapeutic_project_contacts WHERE id = $1`, [ptpcId]),
    ).rejects.toThrow(/ptpc_imutavel/);

    // CASCADE: purgar o paciente leva a versão e, com ela, a ligação — sem passar pelo trigger
    // de imutabilidade (que só barra apagar isoladamente, com o paciente ainda de pé).
    await admin.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient]);
    const left = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_therapeutic_project_contacts WHERE id = $1`,
      [ptpcId],
    );
    expect(left.rows[0].n).toBe(0);
  });
});
