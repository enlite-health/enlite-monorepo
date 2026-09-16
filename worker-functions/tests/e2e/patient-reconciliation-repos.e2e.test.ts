/**
 * Repositórios da reconciliação contra BANCO REAL (regra do repo: repositório
 * nunca se testa com mock) — spec 003, T010/T041.
 *
 * Cobre, nas migrations 296-299 já aplicadas:
 *  - SourceRunRepository: start/finish/findLatestUsable (FAILED não é usável)
 *  - SnapshotRepository: CREATED → UNCHANGED (hash igual não grava) → REPLACED
 *    (anterior apagado — retenção "só o último", lex (a)); canonical proibido
 *    (C2) é barrado na porta do banco; purgeByPatient (C5)
 *  - IdentityLinkRepository: upsert automático, decisão humana prevalece
 *    (CONFIRMED/DENIED não são sobrescritos), deniedPatientIds, inventário
 *    pela view (ONLY_CLICKUP / ONLY_ANACARE / BOTH / AMBIGUOUS)
 *  - country NOT NULL sem default (C1): insert sem country falha
 * Fixture sintética; tudo prefixado por STAMP e limpo no afterAll.
 */
import { Pool } from 'pg';
import { SourceRunRepository } from '../../src/modules/reconciliation/infrastructure/SourceRunRepository';
import { SnapshotRepository, ForbiddenCanonicalError } from '../../src/modules/reconciliation/infrastructure/SnapshotRepository';
import { IdentityLinkRepository } from '../../src/modules/reconciliation/infrastructure/IdentityLinkRepository';
import type { CanonicalPatient } from '../../src/modules/reconciliation/domain/CanonicalPatient';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const STAMP = `rec_e2e_${Date.now()}`;

const canon = (over: Partial<CanonicalPatient>): CanonicalPatient => ({
  firstName: 'Ana', lastName: STAMP, birthDate: '2015-03-04', documentType: null, documentNumber: null, sex: null,
  phoneWhatsapp: null, healthInsuranceName: null, healthInsuranceMemberId: null, hasCud: null, hasConsent: null,
  hasJudicialProtection: null, diagnosis: 'sintetico', dependencyLevel: null, clinicalSpecialty: null, serviceType: null,
  additionalComments: null, province: null, cityLocality: null, zoneNeighborhood: null, addresses: [],
  multidisciplinaryTeam: null, caseNumber: null, status: null, responsibleFirstName: null, responsibleLastName: null,
  responsibleRelationship: null, country: 'AR', ...over,
});

let pool: Pool;
let runs: SourceRunRepository;
let snapshots: SnapshotRepository;
let links: IdentityLinkRepository;
const patientIds: string[] = [];

async function seedPatient(first: string, taskId: string | null): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO patients (first_name, last_name, birth_date, origin, country, clickup_task_id, status)
     VALUES ($1, $2, '2015-03-04', 'admin_manual', 'AR', $3, 'ACTIVE') RETURNING id`,
    [first, STAMP, taskId],
  );
  patientIds.push(r.rows[0].id);
  return r.rows[0].id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  runs = new SourceRunRepository(pool);
  snapshots = new SnapshotRepository(pool);
  links = new IdentityLinkRepository(pool);
});

afterAll(async () => {
  await pool.query(`DELETE FROM patient_identity_links WHERE external_id LIKE $1`, [`${STAMP}%`]);
  await pool.query(`DELETE FROM patient_source_snapshots WHERE external_id LIKE $1`, [`${STAMP}%`]);
  await pool.query(`DELETE FROM patient_source_runs WHERE actor_id = $1`, [STAMP]);
  if (patientIds.length) await pool.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [patientIds]);
  await pool.end();
});

describe('C1 — country NOT NULL sem default', () => {
  it('insert de rodada sem country falha no banco', async () => {
    await expect(pool.query(
      `INSERT INTO patient_source_runs (source, triggered_by) VALUES ('CLICKUP', 'MANUAL')`,
    )).rejects.toThrow(/null value in column "country"/);
  });
});

describe('SourceRunRepository', () => {
  it('start → finish; FAILED não é "usável"; a última COMPLETE é', async () => {
    const failed = await runs.start({ source: 'CLICKUP', country: 'AR', triggeredBy: 'MANUAL', actorId: STAMP });
    await runs.finish(failed.id, { expectedCount: null, readCount: 0, completeness: 'FAILED', error: 'x' });
    expect((await runs.findLatestUsable('CLICKUP', 'AR'))?.id).not.toBe(failed.id);

    const ok = await runs.start({ source: 'CLICKUP', country: 'AR', triggeredBy: 'MANUAL', actorId: STAMP });
    const finished = await runs.finish(ok.id, { expectedCount: 3, readCount: 3, completeness: 'COMPLETE' });
    expect(finished.completeness).toBe('COMPLETE');
    expect(finished.finishedAt).toBeInstanceOf(Date);
    expect((await runs.findLatestUsable('CLICKUP', 'AR'))?.id).toBe(ok.id);
  });
});

describe('SnapshotRepository', () => {
  it('CREATED → UNCHANGED (hash igual não grava) → REPLACED (anterior apagado)', async () => {
    const r1 = await runs.start({ source: 'ANACARE', country: 'AR', triggeredBy: 'MANUAL', actorId: STAMP });
    const ext = `${STAMP}-a`;
    expect(await snapshots.writeIfChanged({ runId: r1.id, source: 'ANACARE', country: 'AR', externalId: ext, canonical: canon({}) })).toBe('CREATED');

    const r2 = await runs.start({ source: 'ANACARE', country: 'AR', triggeredBy: 'MANUAL', actorId: STAMP });
    expect(await snapshots.writeIfChanged({ runId: r2.id, source: 'ANACARE', country: 'AR', externalId: ext, canonical: canon({}) })).toBe('UNCHANGED');
    expect(await snapshots.countByRun(r2.id)).toBe(0);

    const r3 = await runs.start({ source: 'ANACARE', country: 'AR', triggeredBy: 'MANUAL', actorId: STAMP });
    expect(await snapshots.writeIfChanged({ runId: r3.id, source: 'ANACARE', country: 'AR', externalId: ext, canonical: canon({ diagnosis: 'mudou' }) })).toBe('REPLACED');
    const all = await pool.query(`SELECT run_id FROM patient_source_snapshots WHERE external_id = $1`, [ext]);
    expect(all.rows).toEqual([{ run_id: r3.id }]); // só o último sobrevive
  });

  it('C2 — canonical com chave proibida é barrado na porta do banco', async () => {
    const r = await runs.start({ source: 'ANACARE', country: 'AR', triggeredBy: 'MANUAL', actorId: STAMP });
    const bad = { ...canon({}), responsibles: [{ phone: 'x' }] } as unknown as CanonicalPatient;
    await expect(snapshots.writeIfChanged({ runId: r.id, source: 'ANACARE', country: 'AR', externalId: `${STAMP}-bad`, canonical: bad }))
      .rejects.toBeInstanceOf(ForbiddenCanonicalError);
    const n = await pool.query(`SELECT count(*)::int AS n FROM patient_source_snapshots WHERE external_id = $1`, [`${STAMP}-bad`]);
    expect(n.rows[0].n).toBe(0);
  });
});

describe('IdentityLinkRepository + inventário', () => {
  it('classifica pela view: ONLY_CLICKUP, ONLY_ANACARE, BOTH, AMBIGUOUS; decisão humana prevalece', async () => {
    const pBoth = await seedPatient('Both', `${STAMP}-task-both`);
    const pClick = await seedPatient('Click', `${STAMP}-task-click`);
    const pAmb = await seedPatient('Amb', null);
    const run = await runs.start({ source: 'CLICKUP', country: 'AR', triggeredBy: 'MANUAL', actorId: STAMP });

    await links.upsertAutomatic({ source: 'CLICKUP', country: 'AR', externalId: `${STAMP}-task-both`, patientId: pBoth, matchKey: 'EXTERNAL_ID', state: 'AUTO', lastRunId: run.id });
    await links.upsertAutomatic({ source: 'ANACARE', country: 'AR', externalId: `${STAMP}-ana-both`, patientId: pBoth, matchKey: 'DOCUMENT', state: 'AUTO', lastRunId: run.id });
    await links.upsertAutomatic({ source: 'CLICKUP', country: 'AR', externalId: `${STAMP}-task-click`, patientId: pClick, matchKey: 'EXTERNAL_ID', state: 'AUTO', lastRunId: run.id });
    await links.upsertAutomatic({ source: 'ANACARE', country: 'AR', externalId: `${STAMP}-ana-only`, patientId: null, matchKey: 'NONE', state: 'AUTO', lastRunId: run.id });
    const amb = await links.upsertAutomatic({ source: 'ANACARE', country: 'AR', externalId: `${STAMP}-ana-amb`, patientId: null, matchKey: 'NONE', state: 'AMBIGUOUS', candidatePatientId: pAmb, lastRunId: run.id });

    const inv = await pool.query<{ bucket: string; n: string }>(
      `SELECT bucket, count(*)::text AS n FROM v_patient_source_inventory
        WHERE person_key IN ($1, $2, $3, $4) GROUP BY bucket ORDER BY bucket`,
      [pBoth, pClick, `ANACARE:${STAMP}-ana-only`, `ANACARE:${STAMP}-ana-amb`],
    );
    expect(Object.fromEntries(inv.rows.map(r => [r.bucket, Number(r.n)]))).toEqual({ AMBIGUOUS: 1, BOTH: 1, ONLY_ANACARE: 1, ONLY_CLICKUP: 1 });

    // migration 300: link ANACARE AUTO com pessoa → patients.ana_care_id preenchido
    const bothRow = await pool.query<{ ana_care_id: string | null }>(`SELECT ana_care_id FROM patients WHERE id = $1`, [pBoth]);
    expect(bothRow.rows[0].ana_care_id).toBe(`${STAMP}-ana-both`);
    const ambRowBefore = await pool.query<{ ana_care_id: string | null }>(`SELECT ana_care_id FROM patients WHERE id = $1`, [pAmb]);
    expect(ambRowBefore.rows[0].ana_care_id).toBeNull(); // AMBIGUOUS não liga

    // Gabriel confirma o ambíguo → CONFIRMED, patient_id = candidato, match_key MANUAL, ana_care_id preenchido
    const confirmed = await links.decide(amb.id, 'CONFIRMED', STAMP);
    expect(confirmed).toMatchObject({ state: 'CONFIRMED', patientId: pAmb, matchKey: 'MANUAL', decidedBy: STAMP });
    const ambRowAfter = await pool.query<{ ana_care_id: string | null }>(`SELECT ana_care_id FROM patients WHERE id = $1`, [pAmb]);
    expect(ambRowAfter.rows[0].ana_care_id).toBe(`${STAMP}-ana-amb`);

    // rodada seguinte tenta rebaixar para AMBIGUOUS/AUTO → decisão humana prevalece
    const again = await links.upsertAutomatic({ source: 'ANACARE', country: 'AR', externalId: `${STAMP}-ana-amb`, patientId: null, matchKey: 'NONE', state: 'AMBIGUOUS', candidatePatientId: pAmb, lastRunId: run.id });
    expect(again.state).toBe('CONFIRMED');
    expect(again.patientId).toBe(pAmb);

    // DENIED entra no conjunto de negados
    const only = await links.findBySourceId('ANACARE', `${STAMP}-ana-only`);
    await pool.query(`UPDATE patient_identity_links SET candidate_patient_id = $2 WHERE id = $1`, [only!.id, pClick]);
    await links.decide(only!.id, 'DENIED', STAMP);
    expect(await links.deniedPatientIds('ANACARE', `${STAMP}-ana-only`)).toEqual(new Set([pClick]));
    const clickRow = await pool.query<{ ana_care_id: string | null }>(`SELECT ana_care_id FROM patients WHERE id = $1`, [pClick]);
    expect(clickRow.rows[0].ana_care_id).toBeNull(); // DENIED nunca liga

    // C5: purga por paciente apaga snapshots ligados
    const r2 = await runs.start({ source: 'CLICKUP', country: 'AR', triggeredBy: 'MANUAL', actorId: STAMP });
    await snapshots.writeIfChanged({ runId: r2.id, source: 'CLICKUP', country: 'AR', externalId: `${STAMP}-task-both`, canonical: canon({ firstName: 'Both' }) });
    expect(await snapshots.purgeByPatient(pBoth)).toBe(1);
  });
});
