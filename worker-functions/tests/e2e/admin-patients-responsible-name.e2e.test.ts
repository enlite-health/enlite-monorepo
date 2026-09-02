/**
 * admin-patients-responsible-name.e2e.test.ts — D249
 *
 * O lead "para otra persona" grava o nome de quem preencheu em
 * `patient_responsibles` e deixa o PACIENTE sem nome. A lista precisa então
 * mostrar quem responde por ele — e, se mostra um nome na tela, tem de ACHAR
 * por esse nome quando o operador o digita na busca.
 *
 * Contra Postgres real e a API real. Duas coisas que só o banco decide:
 * `concat_ws`/`NULLIF` montando o nome do responsável (sobrenome vazio não pode
 * virar "Flavia " com espaço solto), e o `EXISTS` da busca casando o paciente
 * por uma coluna que não é dele.
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('GET /api/admin/patients — nome do responsável (D249)', () => {
  const api = createApiClient();
  let pool: Pool;
  let adminToken: string;
  const criados: string[] = [];

  const TAG = `resp-name-${Date.now()}`;

  async function seedLead(opts: {
    patientFirstName: string | null;
    patientLastName?: string | null;
    responsible?: { firstName: string; lastName: string };
  }): Promise<string> {
    const id = randomUUID();
    criados.push(id);
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, status, origin, country)
       VALUES ($1, $2, $3, $4, 'SOLICITANTE', 'web_form', 'AR')`,
      [id, `${TAG}-${id}`, opts.patientFirstName, opts.patientLastName ?? null],
    );
    if (opts.responsible) {
      await pool.query(
        `INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order, source)
         VALUES ($1, $2, $3, true, 1, 'web_form')`,
        [id, opts.responsible.firstName, opts.responsible.lastName],
      );
    }
    return id;
  }

  async function listar(search?: string) {
    const qs = search ? `?limit=200&search=${encodeURIComponent(search)}` : '?limit=200';
    const res = await api.get(`/api/admin/patients${qs}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    return res.data.data as Array<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      responsibleName: string | null;
    }>;
  }

  let idComResponsavel = '';
  let idResponsavelSemSobrenome = '';
  let idPacienteProprio = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'resp-name-admin-e2e',
      email: 'resp-name-admin@e2e.local',
      role: 'admin',
    });

    // "Para otra persona": paciente sem nome, responsável com nome completo.
    idComResponsavel = await seedLead({
      patientFirstName: null,
      responsible: { firstName: 'Flavia', lastName: 'Villagra' },
    });
    // Responsável de nome único — sobrenome '' (a coluna é NOT NULL).
    idResponsavelSemSobrenome = await seedLead({
      patientFirstName: null,
      responsible: { firstName: 'Mariana', lastName: '' },
    });
    // "Para mí": o nome é do paciente e não há responsável.
    idPacienteProprio = await seedLead({
      patientFirstName: 'Joaquín',
      patientLastName: 'Benítez',
    });
  }, 60_000);

  afterAll(async () => {
    for (const id of criados) {
      await pool.query('DELETE FROM patients WHERE id = $1', [id]).catch(() => undefined);
    }
    await pool.end();
  });

  it('paciente sem nome devolve o nome do responsável primário', async () => {
    const linha = (await listar()).find((p) => p.id === idComResponsavel);
    expect(linha).toBeDefined();
    expect(linha!.firstName).toBeNull();
    expect(linha!.responsibleName).toBe('Flavia Villagra');
  });

  it('responsável de nome único não vira nome com espaço solto', async () => {
    const linha = (await listar()).find((p) => p.id === idResponsavelSemSobrenome);
    // 'Mariana ' com espaço no fim apareceria na tela e passaria despercebido —
    // é o que concat_ws + NULLIF + btrim evitam.
    expect(linha!.responsibleName).toBe('Mariana');
  });

  it('paciente com nome próprio NÃO ganha responsável inventado', async () => {
    const linha = (await listar()).find((p) => p.id === idPacienteProprio);
    expect(linha!.firstName).toBe('Joaquín');
    expect(linha!.responsibleName).toBeNull();
  });

  it('a busca acha o paciente pelo NOME DO RESPONSÁVEL', async () => {
    const porNome = await listar('Villagra');
    expect(porNome.map((p) => p.id)).toContain(idComResponsavel);

    // E continua achando pelo nome do próprio paciente.
    const porPaciente = await listar('Benítez');
    expect(porPaciente.map((p) => p.id)).toContain(idPacienteProprio);
    // Sem confundir um com o outro.
    expect(porPaciente.map((p) => p.id)).not.toContain(idComResponsavel);
  });
});
