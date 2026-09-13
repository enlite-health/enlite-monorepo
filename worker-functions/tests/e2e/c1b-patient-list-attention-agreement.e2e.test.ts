/**
 * c1b-patient-list-attention-agreement.e2e.test.ts @integration — C3 do relatório F5.
 *
 * `needsAttention`/`attentionReasons` viraram DERIVADOS em JS (`computePatientCompleteness`), mas o
 * FILTRO, os CONTADORES e o `total_count` continuaram em SQL contra as colunas GUARDADAS
 * (`p.needs_attention`, `p.attention_reasons`). Efeito medido: o paciente aparece com o badge
 * "Necesita atención" e SOME quando a operadora filtra por ele; "Completo" devolve linhas
 * marcadas como precisando de atenção; e `attention_reason=INCOMPLETE_ADMISSION` (aceito pelo
 * schema e oferecido pela UI) nunca casa com ninguém.
 *
 * A prova é de CONCORDÂNCIA, não de valor fixo: o que o payload afirma (badge) tem de ser o que o
 * filtro devolve, o que o total conta e o que os contadores somam. Postgres real.
 */
import { Pool } from 'pg';
import { PatientQueryRepository } from '@modules/case/infrastructure/PatientQueryRepository';
import { computePatientCompleteness, ACTIVATABLE_STATUSES, patientNeedsAttentionSql } from '@modules/case/domain/PatientCompleteness';
import type { AdminPatientsListParams } from '@modules/case/interfaces/validators/adminPatientsListSchema';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = 'C1B-attention-%';
// País próprio: `stats()` conta a base INTEIRA, e a base e2e é toda AR (medido: 37/37). Com as
// fixtures em BR, `stats('BR')` e `list({country:'BR'})` falam das MESMAS 4 linhas — sem isso o
// contador dança com o que as outras suítes inserem no mesmo Postgres.
const BASE = { limit: 500, offset: 0, country: 'BR' } as unknown as AdminPatientsListParams;

describe('C3 — filtro, total e contadores concordam com o badge que a lista mostra (Postgres real) @integration', () => {
  let pool: Pool;
  const repo = new PatientQueryRepository();

  /** Cada cenário existe para mover UM código do checklist — a régua é `computePatientCompleteness`. */
  const cenarios = [
    { tag: 'C1B-attention-incompleto-admission',  status: 'ADMISSION',         completo: false },
    { tag: 'C1B-attention-incompleto-pending',    status: 'PENDING_ADMISSION', completo: false },
    { tag: 'C1B-attention-completo-admission',    status: 'ADMISSION',         completo: true  },
    { tag: 'C1B-attention-active-incompleto',     status: 'ACTIVE',            completo: false },
    // Migration 330: TUDO completo, menos o vínculo serviço→endereço — só SERVICE_ADDRESS acusa.
    // É o cenário que prova que a cláusula SQL nova e o JS concordam.
    { tag: 'C1B-attention-servico-sem-domicilio', status: 'ADMISSION',         completo: true, servicoSemEndereco: true },
  ];

  const limpar = async (): Promise<void> => {
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [TAG]);
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    for (const c of cenarios) {
      const id = (await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, has_consent, insurance_informed, birth_date)
         VALUES ($1, 'C1B', 'Atencion QA', 'BR', $2, $3, $4, '1970-01-01') RETURNING id`,
        [c.tag, c.status, c.completo, c.completo ? 'OSDE' : null],
      )).rows[0].id;
      if (c.completo) {
        const addr = (await pool.query<{ id: string }>(`INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1,'Calle C1B 1',1) RETURNING id`, [id])).rows[0].id;
        await pool.query(`INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order) VALUES ($1,'C1B','Resp',true,1)`, [id]);
        // Migration 330: "completo" exige o serviço APONTANDO para o endereço; o cenário
        // `servicoSemEndereco` deixa address_id NULL de propósito.
        await pool.query(
          // Decisão do Gabriel 07/09: "completo" também exige HORÁRIO (SERVICE_SCHEDULE).
          `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule) VALUES ($1,'CAREGIVER',true,'BR','c1b-e2e','c1b-e2e',$2,'[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]'::jsonb)`,
          [id, 'servicoSemEndereco' in c && c.servicoSemEndereco ? null : addr],
        );
      }
    }
  });

  afterAll(async () => { await limpar(); await pool.end(); });

  /** As linhas deste teste, com o que o PAYLOAD afirma — a fonte contra a qual tudo é medido. */
  const minhas = async () => {
    const { rows } = await repo.list({ ...BASE, search: 'Atencion QA' } as AdminPatientsListParams);
    return rows.filter((r) => (r.lastName ?? '') === 'Atencion QA');
  };

  it('a. o badge do payload é o que `computePatientCompleteness` decide (controle positivo do cenário)', async () => {
    const rows = await minhas();
    expect(rows).toHaveLength(cenarios.length);
    const incompletos = rows.filter((r) => r.attentionReasons.includes('INCOMPLETE_ADMISSION'));
    // 3 em ADMISSION/PENDING_ADMISSION e incompletos (2 sem nada + 1 só com serviço sem endereço,
    // migration 330); o ACTIVE incompleto NÃO conta (já foi aprovado); o completo não aparece.
    expect(incompletos.map((r) => r.needsAttention)).toEqual([true, true, true]);
    const semDomicilio = rows.find((r) => r.clickupTaskId === 'C1B-attention-servico-sem-domicilio');
    expect(semDomicilio?.attentionReasons).toContain('INCOMPLETE_ADMISSION');
    const completo = rows.find((r) => r.clickupTaskId === 'C1B-attention-completo-admission');
    expect(completo?.needsAttention).toBe(false);
    expect((ACTIVATABLE_STATUSES as readonly string[]).includes('ADMISSION')).toBe(true);
    expect(computePatientCompleteness({ birthDate: null, hasConsent: false, insuranceInformed: null, activeAddressCount: 0, activeResponsibleCount: 0, activeContractedServiceCount: 0, activeContractedServicesWithoutAddressCount: 0, activeContractedServicesWithoutScheduleCount: 0 }).missing.length).toBeGreaterThan(0);
  });

  it('b. filtrar por `needs_attention=true` devolve EXATAMENTE quem tem o badge — e nunca quem não tem', async () => {
    const badge = new Set((await minhas()).filter((r) => r.needsAttention).map((r) => r.id));
    const { rows } = await repo.list({ ...BASE, search: 'Atencion QA', needs_attention: 'true' } as AdminPatientsListParams);
    const filtrados = new Set(rows.filter((r) => (r.lastName ?? '') === 'Atencion QA').map((r) => r.id));
    expect([...filtrados].sort()).toEqual([...badge].sort());
    expect(rows.every((r) => r.needsAttention)).toBe(true);
  });

  it('c. filtrar por `needs_attention=false` ("Completo") NÃO devolve nenhuma linha com o badge', async () => {
    const { rows } = await repo.list({ ...BASE, search: 'Atencion QA', needs_attention: 'false' } as AdminPatientsListParams);
    const meus = rows.filter((r) => (r.lastName ?? '') === 'Atencion QA');
    expect(meus.some((r) => r.needsAttention)).toBe(false);
    const semBadge = (await minhas()).filter((r) => !r.needsAttention).map((r) => r.id).sort();
    expect(meus.map((r) => r.id).sort()).toEqual(semBadge);
  });

  it('d. `attention_reason=INCOMPLETE_ADMISSION` casa com quem o payload marca (hoje: ninguém)', async () => {
    const esperados = (await minhas()).filter((r) => r.attentionReasons.includes('INCOMPLETE_ADMISSION')).map((r) => r.id).sort();
    expect(esperados.length).toBeGreaterThan(0);
    const { rows } = await repo.list({ ...BASE, search: 'Atencion QA', attention_reason: 'INCOMPLETE_ADMISSION' } as AdminPatientsListParams);
    expect(rows.filter((r) => (r.lastName ?? '') === 'Atencion QA').map((r) => r.id).sort()).toEqual(esperados);
  });

  it('e. o `total` do filtro é o número de linhas que o filtro devolve (paginação não mente)', async () => {
    const { rows: pagina, total } = await repo.list({ ...BASE, search: 'Atencion QA', needs_attention: 'true', limit: 1 } as AdminPatientsListParams);
    expect(pagina).toHaveLength(1);
    const badge = (await minhas()).filter((r) => r.needsAttention).length;
    expect(total).toBe(badge);
  });

  it('f. os contadores de `stats()` somam o MESMO que o badge da lista', async () => {
    const { rows: todos, total } = await repo.list({ ...BASE } as AdminPatientsListParams);
    const comBadge = todos.filter((r) => r.needsAttention).length;
    expect(total).toBe(cenarios.length);
    expect(comBadge).toBeGreaterThan(0); // controle positivo: as fixtures deste teste estão dentro

    const stats = await repo.stats('BR');
    expect(stats.total).toBe(total);
    expect(stats.needsAttention).toBe(comBadge);
    expect(stats.complete).toBe(total - comBadge);
    expect(stats.needsAttention + stats.complete).toBe(stats.total);
  });

  it('g. DIFERENCIAL: numa ÚNICA leitura, o SQL do filtro e `computePatientCompleteness` dão o mesmo veredito para TODA linha', async () => {
    // Um SELECT só: o veredito do SQL e os insumos do veredito do JS saem do MESMO snapshot —
    // é isto que impede as duas implementações da regra de divergirem sem ninguém ver.
    const { rows } = await pool.query<Record<string, never>>(`
      SELECT p.id, p.status, p.needs_attention, p.birth_date, p.has_consent,
             COALESCE(p.insurance_informed, p.health_insurance_name) AS ins,
             (SELECT COUNT(*)::int FROM patient_addresses pa WHERE pa.patient_id = p.id AND pa.archived_at IS NULL) AS addrs,
             (EXISTS (SELECT 1 FROM patient_responsibles pr WHERE pr.patient_id = p.id))::int AS resp,
             (EXISTS (SELECT 1 FROM patient_contracted_services s WHERE s.patient_id = p.id AND s.active))::int AS svc,
             (EXISTS (SELECT 1 FROM patient_contracted_services s
                        LEFT JOIN patient_addresses sa ON sa.id = s.address_id AND sa.archived_at IS NULL
                       WHERE s.patient_id = p.id AND s.active AND sa.id IS NULL))::int AS svc_noaddr,
             -- Decisão do Gabriel 07/09: serviço ativo sem horário (NULL ou array vazio).
             (EXISTS (SELECT 1 FROM patient_contracted_services s
                       WHERE s.patient_id = p.id AND s.active
                         AND (s.schedule IS NULL OR jsonb_array_length(s.schedule) = 0)))::int AS svc_nosched,
             ${patientNeedsAttentionSql('p')} AS sql_flag
        FROM patients p
       WHERE p.deleted_at IS NULL`);
    expect(rows.length).toBeGreaterThan(cenarios.length); // controle positivo: a base inteira, não só as minhas

    const now = new Date();
    const divergentes = (rows as unknown as Array<Record<string, unknown>>).filter((r) => {
      const { missing } = computePatientCompleteness({
        birthDate: (r.birth_date as string | Date | null) ?? null,
        hasConsent: (r.has_consent as boolean | null) ?? null,
        insuranceInformed: (r.ins as string | null) ?? null,
        activeAddressCount: r.addrs as number,
        activeResponsibleCount: r.resp as number,
        activeContractedServiceCount: r.svc as number,
        activeContractedServicesWithoutAddressCount: r.svc_noaddr as number,
        activeContractedServicesWithoutScheduleCount: r.svc_nosched as number,
        now,
      });
      const incompleta = (ACTIVATABLE_STATUSES as readonly (string | null)[]).includes(r.status as string | null) && missing.length > 0;
      const js = r.needs_attention === true || incompleta;
      return js !== r.sql_flag;
    }).map((r) => r.id);

    expect(divergentes).toEqual([]);
  });
});
