/**
 * admission-d-incomplete-needs-attention.e2e.test.ts @integration — QA-caça rodada 1, item conserto 1
 *
 * O que SÓ este arquivo prova.
 *
 * A spec 014 (lex D1.1) dizia "needsAttention passa a derivar do checklist"; a implementação
 * original nunca recalculava — só lia a coluna legada `patients.needs_attention`, escrita uma
 * vez no import. O QA-caça reproduziu: paciente com `completeness.missing` não vazio no
 * `GET /:id` continuava `needsAttention:false` na lista. O teste de repositório
 * (`PatientQueryRepository.test.ts`) mocka `pool.query` — prova a FÓRMULA (EXISTS/booleano +
 * `computePatientCompleteness`), mas não que o SQL novo (EXISTS correlacionado, COALESCE,
 * o JOIN com `patient_responsibles`/`patient_contracted_services`) roda de verdade contra
 * Postgres. Aqui não há mock: API real, Postgres real, o mesmo `GET /api/admin/patients` que
 * alimenta lista E kanban (é a MESMA query — `AdminPatientsController.listPatients` →
 * `PatientQueryRepository.list`).
 *
 * Também prova o contrato D1.1: `missing[]`/`completeness` NUNCA aparecem no corpo da lista —
 * só o booleano `needsAttention` e o enum `attentionReasons` (com o código novo
 * `INCOMPLETE_ADMISSION`, fechado em `AttentionReason.ts`).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

describe('needsAttention deriva do checklist na lista/kanban (QA-caça rodada 1, item 1) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  const TAG = `qacaca-item1-${Date.now()}`;
  const criados: string[] = [];

  let idIncompleto = '';
  let idCompleto = '';
  let idForaDaAdmissao = '';
  let idLegadoTrue = '';

  async function seedPatient(opts: {
    suffix: string;
    status: string;
    caseNumber: number;
    needsAttentionLegacy?: boolean;
    hasConsent?: boolean;
    insuranceInformed?: string | null;
    withAddress?: boolean;
    withService?: boolean;
  }): Promise<string> {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients
           (clickup_task_id, first_name, last_name, country, status, case_number,
            has_consent, insurance_informed, needs_attention)
         VALUES ($1, 'QACaca', $2, 'AR', $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          `${TAG}-${opts.suffix}`,
          opts.suffix,
          opts.status,
          opts.caseNumber,
          opts.hasConsent ?? true,
          opts.insuranceInformed ?? 'OSDE',
          opts.needsAttentionLegacy ?? false,
        ],
      )
    ).rows[0].id;
    criados.push(id);

    let addressId: string | null = null;
    if (opts.withAddress) {
      addressId = (await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, address_formatted, display_order, country)
         VALUES ($1, 'Calle Falsa 123, CABA', 0, 'AR') RETURNING id`,
        [id],
      )).rows[0].id;
    }
    if (opts.withService) {
      // Migration 330: "completo" exige o serviço apontando para o endereço (SERVICE_ADDRESS);
      // sem endereço na ficha o serviço nasce sem vínculo — e o checklist acusa os dois.
      await pool.query(
        // Decisão do Gabriel 07/09: "completo" também exige HORÁRIO no serviço (SERVICE_SCHEDULE).
        `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
         VALUES ($1, 'AT', true, 'AR', 'qacaca-item1-e2e', 'qacaca-item1-e2e', $2, '[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]'::jsonb)`,
        [id, addressId],
      );
    }
    return id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);
    asAdmin = await staffAuth('qacaca-item1-admin', 'admin');

    // 1. ADMISSION, checklist INCOMPLETO (sem endereço, sem serviço) — o caso reproduzido pelo QA.
    idIncompleto = await seedPatient({
      suffix: 'incompleto',
      status: 'ADMISSION',
      caseNumber: 88001,
      withAddress: false,
      withService: false,
    });

    // 2. PENDING_ADMISSION, checklist COMPLETO (endereço + serviço + consent + cobertura;
    //    RESPONSIBLE não exigido — sem birth_date, conta como adulto).
    idCompleto = await seedPatient({
      suffix: 'completo',
      status: 'PENDING_ADMISSION',
      caseNumber: 88002,
      withAddress: true,
      withService: true,
    });

    // 3. ACTIVE (fora de ACTIVATABLE_STATUSES), checklist incompleto — não deve derivar
    //    (paciente já aprovado; "atenção" aqui seria ruído).
    idForaDaAdmissao = await seedPatient({
      suffix: 'fora-admissao',
      status: 'ACTIVE',
      caseNumber: 88003,
      withAddress: false,
      withService: false,
    });

    // 4. ADMISSION, checklist COMPLETO, mas legado needsAttention=true — o OR preserva o legado.
    idLegadoTrue = await seedPatient({
      suffix: 'legado-true',
      status: 'ADMISSION',
      caseNumber: 88004,
      needsAttentionLegacy: true,
      withAddress: true,
      withService: true,
    });
  });

  afterAll(async () => {
    if (criados.length) {
      await pool.query('DELETE FROM patient_contracted_services WHERE patient_id = ANY($1::uuid[])', [criados]);
      await pool.query('DELETE FROM patient_addresses WHERE patient_id = ANY($1::uuid[])', [criados]);
      await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [criados]);
    }
    await pool.end();
  });

  async function getDetail(id: string) {
    const res = await api.get(`/api/admin/patients/${id}`, asAdmin);
    expect(res.status).toBe(200);
    return res.data.data;
  }

  async function listRows() {
    const res = await api.get('/api/admin/patients?limit=200&offset=0', asAdmin);
    expect(res.status).toBe(200);
    return (res.data.data as Record<string, any>[]).filter((p) => criados.includes(p.id));
  }

  it('GET /:id confirma o insumo: paciente incompleto tem completeness.missing NÃO vazio', async () => {
    const detail = await getDetail(idIncompleto);
    expect(detail.completeness.missing.length).toBeGreaterThan(0);
    expect(detail.completeness.missing).toContain('ADDRESS');
    expect(detail.completeness.missing).toContain('CONTRACTED_SERVICE');
  });

  it('GET /:id confirma: paciente completo tem completeness.missing VAZIO, ready true', async () => {
    const detail = await getDetail(idCompleto);
    expect(detail.completeness.missing).toEqual([]);
    expect(detail.completeness.ready).toBe(true);
  });

  it('reprodução do defeito 1 (QA-caça): paciente incompleto EM ADMISSÃO → lista devolve needsAttention:true + INCOMPLETE_ADMISSION (antes: false)', async () => {
    const linhas = await listRows();
    const row = linhas.find((p) => p.id === idIncompleto)!;
    expect(row).toBeDefined();
    expect(row.needsAttention).toBe(true);
    expect(row.attentionReasons).toContain('INCOMPLETE_ADMISSION');
  });

  it('paciente completo → needsAttention:false, sem INCOMPLETE_ADMISSION', async () => {
    const linhas = await listRows();
    const row = linhas.find((p) => p.id === idCompleto)!;
    expect(row.needsAttention).toBe(false);
    expect(row.attentionReasons).not.toContain('INCOMPLETE_ADMISSION');
  });

  it('paciente ACTIVE incompleto (fora de ACTIVATABLE_STATUSES) → needsAttention continua FALSE — não deriva fora da admissão', async () => {
    const linhas = await listRows();
    const row = linhas.find((p) => p.id === idForaDaAdmissao)!;
    expect(row.needsAttention).toBe(false);
    expect(row.attentionReasons).not.toContain('INCOMPLETE_ADMISSION');
  });

  it('legado needsAttention=true SEMPRE aparece (OR), mesmo com checklist completo', async () => {
    const linhas = await listRows();
    const row = linhas.find((p) => p.id === idLegadoTrue)!;
    expect(row.needsAttention).toBe(true);
  });

  it('contrato D1.1: a lista NUNCA expõe `missing`/`completeness` — só booleano + enum fechado', async () => {
    const linhas = await listRows();
    for (const row of linhas) {
      expect(row).not.toHaveProperty('missing');
      expect(row).not.toHaveProperty('completeness');
    }
    expect(JSON.stringify(linhas)).not.toContain('"missing"');
  });
});
