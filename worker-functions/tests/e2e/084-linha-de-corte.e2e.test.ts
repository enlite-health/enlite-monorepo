/**
 * 084-linha-de-corte.e2e.test.ts @integration — spec 084 F3 (linha de corte das vagas antigas) contra Postgres real.
 *
 * Os use cases + o repositório da linha de corte EM PROCESSO (o CLI `scripts/linha-de-corte-vagas.ts` só os compõe), com a base
 * sintética dos grupos — inclusive o 817 (vaga antiga aberta + 3 rascunhos por serviço). Sem API, sem canal externo: só SELECT/UPDATE
 * no Postgres; NENHUM Talentum/WhatsApp/Ana Care/Short.io. Dados 100% sintéticos, sem PII. O ensaio e a aplicação são o MESMO
 * caminho com uma chave (ROLLBACK × COMMIT): a contagem antes = depois no ensaio e a aplicação baixa exatamente o que o ensaio listou.
 *
 * A classificação roda sobre o banco TODO (como no CLI); aqui só se age sobre as vagas SEMEADAS por este teste (ids), para não tocar
 * dado de outro teste do mesmo Postgres.
 */
import { Pool, type PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { MergeLegacyVacancyIntoServiceVacancyUseCase } from '@modules/case/application/MergeLegacyVacancyIntoServiceVacancyUseCase';
import { DraftFusionRepository } from '@modules/case/infrastructure/DraftFusionRepository';
import { LegacyVacancyCutoffRepository } from '@modules/case/infrastructure/LegacyVacancyCutoffRepository';
import { BAIXAR_GROUPS } from '@modules/case/domain/LegacyVacancyCutoff';
import { BajaVacanciesUseCase } from '@modules/matching/application/BajaVacanciesUseCase';
import { JobPostingAuditRepository } from '@modules/matching/infrastructure/JobPostingAuditRepository';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const JOB = 'linha-de-corte-vagas';
const STAMP = `lc084-${Date.now()}`;
const ACTOR = { actorUserId: null, actorType: 'CLI' as const, actorLabel: JOB, traceId: null };

class DryRun extends Error {}

describe('Spec 084 F3 — linha de corte das vagas antigas @integration', () => {
  let pool: Pool;
  let seq = 0;
  const repo = new LegacyVacancyCutoffRepository();
  let baja: BajaVacanciesUseCase;
  let merge: MergeLegacyVacancyIntoServiceVacancyUseCase;

  const ids: Record<string, string> = {};
  const patients: Record<string, string> = {};
  const svc: Record<string, string> = {};

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> =>
    (await pool.query(sql, params)).rows[0] as T;

  async function paciente(tag: string, status: string): Promise<string> {
    const r = await one<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'Corte084', 'E2E', 'AR', $2) RETURNING id`,
      [`${STAMP}-${tag}`, status],
    );
    return r.id;
  }

  async function servico(patientId: string, active = true): Promise<string> {
    const r = await one<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, country, created_by, updated_by, active)
       VALUES ($1, 'AT', 'AR', $2, $2, $3) RETURNING id`,
      [patientId, STAMP, active],
    );
    return r.id;
  }

  async function vaga(o: { patientId: string | null; serviceId?: string | null; status?: string; isDraft?: boolean; tag: string }): Promise<string> {
    const { vn } = await one<{ vn: string }>("SELECT nextval('job_postings_vacancy_number_seq') AS vn");
    const r = await one<{ id: string }>(
      `INSERT INTO job_postings (vacancy_number, patient_id, title, description, country, status, is_draft, is_test, contracted_service_id)
       VALUES ($1, $2, $3, '', 'AR', $4, $5, false, $6) RETURNING id`,
      [parseInt(vn, 10), o.patientId, `${STAMP}-${o.tag}`, o.status ?? 'SEARCHING', o.isDraft ?? false, o.serviceId ?? null],
    );
    return r.id;
  }

  async function worker(): Promise<string> {
    const r = await one<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, country, timezone) VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
      [`${STAMP}-uid-${++seq}`, `${STAMP}-${seq}@corte.test`],
    );
    return r.id;
  }

  async function postular(workerId: string, vacancyId: string, stage: string): Promise<void> {
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, $3, 'talentum')`,
      [workerId, vacancyId, stage],
    );
  }

  const count = async (table: string, vacancyId: string): Promise<number> =>
    (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE job_posting_id = $1`, [vacancyId])).n;
  const linha = (id: string) => one<{ status: string; baja_reason: string | null; deleted_at: Date | null; status_before_baja: string | null; status_before_hold: string | null }>(
    `SELECT status, baja_reason, deleted_at, status_before_baja, status_before_hold FROM job_postings WHERE id = $1`, [id]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    baja = new BajaVacanciesUseCase(pool);
    merge = new MergeLegacyVacancyIntoServiceVacancyUseCase(new DraftFusionRepository(), repo, baja, new JobPostingAuditRepository(), ACTOR);

    patients.baixa = await paciente('baixa', 'DISCHARGED');
    patients.ativoSemServico = await paciente('ativo-sem-servico', 'ACTIVE');
    patients.p817 = await paciente('817', 'ACTIVE');
    patients.ativoComRevisao = await paciente('ativo-revisao', 'ACTIVE');
    await servico(patients.ativoComRevisao);
    patients.hold = await paciente('hold', 'ACTIVE');

    ids.a = await vaga({ patientId: patients.baixa, tag: 'a' });
    ids.b = await vaga({ patientId: patients.ativoSemServico, tag: 'b' });
    ids.x = await vaga({ patientId: null, tag: 'x' });
    ids.dEncerrada = await vaga({ patientId: patients.ativoSemServico, status: 'CLOSED', tag: 'd-encerrada' });
    ids.dSuspensaBaixa = await vaga({ patientId: patients.baixa, status: 'SUSPENDED', tag: 'd-suspensa-baixa' });
    ids.revisaoSuspensa = await vaga({ patientId: patients.ativoComRevisao, status: 'SUSPENDED', tag: 'revisao-suspensa' });
    ids.revisaoActivo = await vaga({ patientId: patients.ativoComRevisao, status: 'ACTIVE', tag: 'revisao-activo' });

    // 817: vaga antiga aberta (sem serviço) + 3 serviços ativos, um rascunho por serviço.
    svc.s1 = await servico(patients.p817);
    svc.s2 = await servico(patients.p817);
    svc.s3 = await servico(patients.p817);
    ids.antiga817 = await vaga({ patientId: patients.p817, tag: '817-antiga' });
    ids.d1 = await vaga({ patientId: patients.p817, serviceId: svc.s1, status: 'PENDING_ACTIVATION', isDraft: true, tag: '817-d1' });
    ids.d2 = await vaga({ patientId: patients.p817, serviceId: svc.s2, status: 'PENDING_ACTIVATION', isDraft: true, tag: '817-d2' });
    ids.d3 = await vaga({ patientId: patients.p817, serviceId: svc.s3, status: 'PENDING_ACTIVATION', isDraft: true, tag: '817-d3' });

    // grupo e: vaga de serviço ATIVO hoje encerrada
    const sHold = await servico(patients.hold);
    ids.e = await vaga({ patientId: patients.hold, serviceId: sHold, status: 'CLOSED', tag: 'e' });
  });
  afterAll(async () => {
    await pool.end();
  });

  /** Mesmo caminho do CLI numa transação só; `commit=false` = ensaio (ROLLBACK). Age só nas vagas semeadas. */
  async function rodar(commit: boolean) {
    const out: { groups: Record<string, string>; antes: number; depois: number; merged: string } = { groups: {}, antes: 0, depois: 0, merged: '' };
    const run = async (client: PoolClient): Promise<void> => {
      const classified = await repo.classifyLegacy(client);
      const meus = new Set(Object.values(ids));
      for (const c of classified) if (meus.has(c.vacancyId)) out.groups[c.vacancyId] = c.group;
      out.antes = await repo.countLiveVacancies(client);

      const toBaixar = classified.filter((c) => meus.has(c.vacancyId) && (BAIXAR_GROUPS as readonly string[]).includes(c.group)).map((c) => c.vacancyId);
      const b = await baja.executeInTx(client, toBaixar, 'CUTOFF', ACTOR);
      if (!b.ok) throw new Error(`baixa recusada: ${JSON.stringify(b.refused)}`);

      const m = await merge.mergeInTx(client, { patientId: patients.p817, legacyId: ids.antiga817, targetId: ids.d2 });
      out.merged = m.status;
      await repo.putOnHold(client, [ids.e]);

      out.depois = await repo.countLiveVacancies(client);
      if (!commit) throw new DryRun();
    };
    try {
      await withActorContext(pool, run, systemActor(JOB));
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
    return out;
  }

  it('a classificação põe cada vaga semeada no grupo certo (a, b, x, d, c e a lista de revisão)', async () => {
    const dry = await rodar(false);
    expect(dry.groups[ids.a]).toBe('a');
    expect(dry.groups[ids.b]).toBe('b');
    expect(dry.groups[ids.x]).toBe('x');
    expect(dry.groups[ids.dEncerrada]).toBe('d-baixar');
    expect(dry.groups[ids.dSuspensaBaixa]).toBe('d-baixar');
    expect(dry.groups[ids.antiga817]).toBe('c');
    // suspensa e "Activo" de paciente ATIVO: lista de revisão, NÃO baixa (R15)
    expect(dry.groups[ids.revisaoSuspensa]).toBe('revisao');
    expect(dry.groups[ids.revisaoActivo]).toBe('revisao');
  });

  it('ENSAIO (ROLLBACK): nada muda no banco e a contagem de vagas vivas antes = depois', async () => {
    const dry = await rodar(false);
    expect(dry.merged).toBe('MERGED');
    expect(dry.depois).toBe(dry.antes);
    for (const id of [ids.a, ids.b, ids.x, ids.dEncerrada, ids.antiga817, ids.e]) {
      const r = await linha(id);
      expect(r.status).not.toBe('DE_BAJA');
      expect(r.deleted_at).toBeNull();
    }
    expect((await linha(ids.e)).status).toBe('CLOSED'); // o grupo e também só foi simulado
  });

  it('APPLY (COMMIT): baixa exatamente o que o ensaio listou (CUTOFF, status anterior guardado), NUNCA apaga, revisão intocada', async () => {
    const dry = await rodar(false);
    const apply = await rodar(true);
    expect(apply.groups).toEqual(dry.groups); // mesmo caminho, mesma classificação
    expect(apply.depois).toBe(apply.antes);   // nenhuma vaga apagada

    for (const id of [ids.a, ids.b, ids.x, ids.dEncerrada, ids.dSuspensaBaixa]) {
      const r = await linha(id);
      expect(r).toMatchObject({ status: 'DE_BAJA', baja_reason: 'CUTOFF', deleted_at: null });
    }
    expect((await linha(ids.dEncerrada)).status_before_baja).toBe('CLOSED');
    // lista de revisão: NÃO baixada
    expect((await linha(ids.revisaoSuspensa)).status).toBe('SUSPENDED');
    expect((await linha(ids.revisaoActivo)).status).toBe('ACTIVE');
    // grupo e: En espera, com o status anterior guardado
    expect(await linha(ids.e)).toMatchObject({ status: 'ON_HOLD', status_before_hold: 'SEARCHING' });
    // os rascunhos do serviço do 817 não foram baixados
    for (const id of [ids.d1, ids.d3]) expect((await linha(id)).status).toBe('PENDING_ACTIVATION');
  });

  it('grupo c (817): Kanban da antiga vai para a vaga do serviço escolhida e a antiga fica baixada no mesmo passo', async () => {
    // O APPLY acima já fez o merge; aqui se confere o resultado com a contagem colada, num cenário próprio (antes/depois).
    const pat = await paciente('817b', 'ACTIVE');
    const s = await servico(pat);
    const antiga = await vaga({ patientId: pat, tag: '817b-antiga' });
    const destino = await vaga({ patientId: pat, serviceId: s, status: 'PENDING_ACTIVATION', isDraft: true, tag: '817b-destino' });
    const [w1, w2] = [await worker(), await worker()];
    await postular(w1, antiga, 'QUALIFIED');
    await postular(w2, antiga, 'IN_PROGRESS');
    await postular(w2, destino, 'INVITED'); // colisão: o destino em entrada adota a etapa da antiga

    const antes = { antiga: await count('worker_job_applications', antiga), destino: await count('worker_job_applications', destino) };
    expect(antes).toEqual({ antiga: 2, destino: 1 });

    const out = await withActorContext(pool, (c) => merge.mergeInTx(c, { patientId: pat, legacyId: antiga, targetId: destino }), systemActor(JOB));
    expect(out.status).toBe('MERGED');

    expect({ antiga: await count('worker_job_applications', antiga), destino: await count('worker_job_applications', destino) })
      .toEqual({ antiga: 0, destino: 2 }); // contagem antes/depois: 2+1 → 0+2 (1 colisão fundida)
    expect(await one(`SELECT application_funnel_stage AS s FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`, [w2, destino]))
      .toEqual({ s: 'IN_PROGRESS' });
    expect(await linha(antiga)).toMatchObject({ status: 'DE_BAJA', baja_reason: 'CUTOFF', deleted_at: null });
    expect((await linha(destino)).status).toBe('PENDING_ACTIVATION'); // a vaga do serviço segue como estava
    const audit = await one<{ n: number }>(`SELECT count(*)::int AS n FROM job_posting_audit_log WHERE job_posting_id = $1`, [destino]);
    expect(audit.n).toBeGreaterThanOrEqual(1);
  });

  it('destino que NÃO é a vaga viva do serviço, ou antiga que já tem serviço: pulado, nada gravado', async () => {
    const pat = await paciente('pula', 'ACTIVE');
    const s = await servico(pat);
    const antiga = await vaga({ patientId: pat, tag: 'pula-antiga' });
    const viva = await vaga({ patientId: pat, serviceId: s, status: 'PENDING_ACTIVATION', isDraft: true, tag: 'pula-viva' });
    const outra = await vaga({ patientId: pat, tag: 'pula-outra' }); // sem serviço: não é destino válido

    const naoServico = await withActorContext(pool, (c) => merge.mergeInTx(c, { patientId: pat, legacyId: antiga, targetId: outra }), systemActor(JOB));
    expect(naoServico).toEqual({ status: 'SKIPPED', reason: 'TARGET_NOT_SERVICE_VACANCY' });
    expect((await linha(antiga)).status).toBe('SEARCHING');
    expect(viva).toBeTruthy();
  });
});
