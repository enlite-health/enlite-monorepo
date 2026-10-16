/**
 * spec 050, 4º passo, F26 (A26-3, A26-4 com importação em voo, A26-7; R-46, R-47, R-49, R-18): o job de 1 minuto contra BANCO REAL,
 * chamado direto (relógio por parâmetro), com os dublês do Meet. Convivência com o job de 15 min, janela, paciente de teste, importação
 * em voo e os erros do Meet que só contam. Cada "0 chamadas" tem, NA MESMA execução, o cenário que dá ≥ 1.
 */
import { Pool } from 'pg';
import { AdmissionLiveJob } from '../../src/modules/matching/application/AdmissionLiveJob';
import { AdmissionPostCallJob } from '../../src/modules/matching/application/AdmissionPostCallJob';
import { AdmissionLiveRepository } from '../../src/modules/matching/infrastructure/AdmissionLiveRepository';
import { AdmissionPostCallRepository } from '../../src/modules/matching/infrastructure/AdmissionPostCallRepository';
import { AdmissionEventRepository } from '../../src/modules/matching/infrastructure/AdmissionEventRepository';
import { FakeMeetConference } from '../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { PAID_REHEARSAL_RELEASED_EVENT } from '../../src/modules/matching/domain/admissionRealm';
import { LiveFixtures } from './helpers/admissionLiveFixtures';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const T0 = new Date('2031-05-12T10:00:00Z');
const MIN = 60_000;
const at = (min: number): Date => new Date(T0.getTime() + min * MIN);

describe('F26 — job de 1 minuto: janela, paciente de teste, convivência e importação em voo (banco real)', () => {
  let admin: Pool;
  let fx: LiveFixtures;
  let fake: FakeMeetConference;
  let logs: ReturnType<typeof capturingLogger>;
  let events: AdmissionEventRepository;
  let live: AdmissionLiveJob;
  let live2: AdmissionLiveJob;
  let rede: AdmissionPostCallJob;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    fx = new LiveFixtures(admin, 'f26c', T0);
    await fx.iniciar();
    fake = new FakeMeetConference();
    logs = capturingLogger();
    events = new AdmissionEventRepository(admin);
    const postCall = new AdmissionPostCallRepository(admin);
    const mk = () => new AdmissionLiveJob({ live: new AdmissionLiveRepository(admin), postCall, meet: fake, events, db: admin, log: logs.log });
    live = mk();
    live2 = mk();
    rede = new AdmissionPostCallJob({ repo: postCall, meet: fake, events, db: admin, log: logs.log });
  });
  beforeEach(async () => {
    fake.reset();
    await fx.iniciar(); // cada teste parte de uma fila só dele (iniciar limpa o que o anterior semeou)
  });
  afterAll(async () => {
    await fx.limpar();
    await admin.end();
  });

  const codeOf = async (id: string): Promise<string> =>
    ((await admin.query(`SELECT meet_link FROM admission_appointments WHERE id = $1`, [id])).rows[0].meet_link as string).split('/').pop() as string;
  const conf = (n: string, ini: number, fim: number | null) => ({ name: `conferenceRecords/${n}`, startTime: at(ini), endTime: fim === null ? null : at(fim) });
  const kinds = async (id: string): Promise<string[]> =>
    (await admin.query(`SELECT kind || coalesce(':' || reason, '') AS k FROM admission_events WHERE appointment_id = $1 ORDER BY kind`, [id])).rows.map((r) => r.k);
  const row = async (id: string) => (await admin.query(`SELECT * FROM admission_appointments WHERE id = $1`, [id])).rows[0];

  /** Reunião + dublê programado com o que `registros` diz. */
  async function reuniao(inicioMin: number, fimMin: number, registros: ReturnType<typeof conf>[], extra: Partial<Parameters<LiveFixtures['semear']>[0]> = {}) {
    const id = await fx.semear({ inicioMin, fimMin, ...extra });
    const code = await codeOf(id);
    fake.setRecords(code, registros);
    return { id, code, space: `spaces/${code}` };
  }

  it('A26-3 (R-46, R-47): antes, dentro e depois da janela → a Meet só é chamada para a de DENTRO (fora = 0 chamadas, ao lado de dentro ≥ 1, na mesma execução)', async () => {
    const antes = await reuniao(16, 61, [conf('c1', 17, null)]); // entra em 16 min: 1 min fora
    const dentro = await reuniao(-10, 35, [conf('c1', -9, null)]);
    const depois = await reuniao(-106, -61, [conf('c1', -105, null)]); // 1 min depois do fim marcado + 60 min
    const s = await live.runOnce(at(0));
    expect(fake.listCalls.filter((c) => c === dentro.space).length).toBeGreaterThanOrEqual(1);
    expect(fake.listCalls.filter((c) => c === antes.space)).toHaveLength(0);
    expect(fake.listCalls.filter((c) => c === depois.space)).toHaveLength(0);
    expect(fake.resolveCalls).not.toContain(antes.code);
    expect(fake.resolveCalls).not.toContain(depois.code);
    expect(s.started).toBeGreaterThanOrEqual(1);
    expect(await kinds(dentro.id)).toEqual(['conference_started']);
    expect(await kinds(antes.id)).toEqual([]);
    expect(await kinds(depois.id)).toEqual([]);
  });

  it('A26-3 (R-18): paciente is_test sem liberação → 0 chamadas ao Meet e nenhum evento; com a liberação vigente na mesma fixture → ≥ 1', async () => {
    const teste = await fx.criarPaciente({ isTest: true });
    const real = await reuniao(-10, 35, [conf('c1', -9, null)]); // controle: paciente real, mesma janela
    const t = await reuniao(-10, 35, [conf('c1', -9, null)], { pacienteId: teste });
    const s1 = await live.runOnce(at(0));
    expect(fake.listCalls.filter((c) => c === real.space).length).toBeGreaterThanOrEqual(1);
    expect(fake.listCalls.filter((c) => c === t.space)).toHaveLength(0);
    expect(fake.resolveCalls).not.toContain(t.code);
    expect(s1.skippedTest).toBeGreaterThanOrEqual(1);
    expect(await kinds(t.id)).toEqual([]); // o `skipped_test` é da rede de 15 min
    expect((await row(t.id)).conference_started_at).toBeNull();

    await events.append({ appointmentId: t.id, kind: PAID_REHEARSAL_RELEASED_EVENT, outcome: 'released', ref: { actorUid: 'ator-sintetico', expiresAt: at(120).toISOString() } }, admin);
    fake.reset();
    fake.setRecords(t.code, [conf('c1', -9, null)]);
    await live.runOnce(at(1));
    expect(fake.listCalls.filter((c) => c === t.space).length).toBeGreaterThanOrEqual(1);
    expect(await kinds(t.id)).toContain('conference_started');
  });

  it('A26-7: dois jobs de 1 min ao mesmo tempo na mesma reunião (Meet lenta) → um processa e o outro conta skippedLocked; 1 started e 1 ended na trilha', async () => {
    const a = await reuniao(0, 45, [conf('c1', 1, 44)]);
    fake.delayMs = 400;
    const [r1, r2] = await Promise.all([live.runOnce(at(50)), live2.runOnce(at(50))]);
    expect(r1.skippedLocked + r2.skippedLocked).toBeGreaterThanOrEqual(1);
    expect(r1.ended + r2.ended).toBe(1);
    expect(await kinds(a.id)).toEqual(['conference_ended', 'conference_started']);
  });

  it('A26-7: job de 1 min e job de 15 min ao mesmo tempo → um pula; 1 started e 1 ended; em sequência no mesmo minuto o segundo NÃO escreve (updated_at igual), e um fim novo escreve (controle)', async () => {
    const a = await reuniao(0, 45, [conf('c1', 1, 44)]);
    fake.delayMs = 400;
    const [v, r] = await Promise.all([live.runOnce(at(50)), rede.runOnce(at(50))]);
    expect(v.skippedLocked + r.skippedLocked).toBeGreaterThanOrEqual(1);
    expect(await kinds(a.id)).toEqual(['conference_ended', 'conference_started']);
    fake.delayMs = 0;

    const antes = (await row(a.id)).updated_at as Date;
    const igual = await live.runOnce(at(50));
    await rede.runOnce(at(50));
    expect(igual.waiting).toBeGreaterThanOrEqual(1);
    expect(new Date((await row(a.id)).updated_at).getTime()).toBe(new Date(antes).getTime());
    expect(await kinds(a.id)).toEqual(['conference_ended', 'conference_started']);

    // controle: uma conferência nova que fechou depois ANDA o fim, e aí a linha muda
    fake.setRecords(a.code, [conf('c1', 1, 44), conf('c2', 46, 48)]);
    await live.runOnce(at(51));
    expect(new Date((await row(a.id)).conference_ended_at).getTime()).toBe(at(48).getTime());
    expect(new Date((await row(a.id)).updated_at).getTime()).toBeGreaterThan(new Date(antes).getTime());
  });

  it('A26-4: reabertura com a IMPORTAÇÃO em voo (a mesma trava de sessão) → a rodada não mexe e conta skippedImporting; solta a trava e a rodada seguinte reabre; a trava da rodada não fica presa', async () => {
    const a = await reuniao(0, 45, [conf('c1', 1, 30), conf('c2', 35, null)], {
      conferenceStartedMin: 1, conferenceEndedMin: 30, importStatus: 'pending', summaryFastState: 'armed',
    });
    const importacao = await admin.connect(); // quem segura o `admission_import:<id>` é a sessão da importação
    const chave = `admission_import:${a.id}`;
    try {
      expect((await importacao.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [chave])).rows[0].ok).toBe(true);
      const s1 = await live.runOnce(at(36));
      expect(s1.skippedImporting).toBe(1);
      expect(s1.reopened).toBe(0);
      expect(await row(a.id)).toMatchObject({ import_status: 'pending', summary_fast_state: 'armed' });
      expect(new Date((await row(a.id)).conference_ended_at).getTime()).toBe(at(30).getTime());
      expect(await kinds(a.id)).toEqual([]);
    } finally {
      await importacao.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [chave]);
      importacao.release();
    }
    const s2 = await live.runOnce(at(37));
    expect(s2.reopened).toBe(1);
    expect(await row(a.id)).toMatchObject({ import_status: null, summary_fast_state: 'cancelled', conference_ended_at: null });
    expect(await kinds(a.id)).toEqual(['conference_reopened:before_summary']);
    // a trava de transação do job foi solta no commit: a importação consegue tomá-la
    const depois = await admin.connect();
    try {
      expect((await depois.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [chave])).rows[0].ok).toBe(true);
      await depois.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [chave]);
    } finally {
      depois.release();
    }
  });

  it('escopo do Meet ausente e erro transitório → só contam: nenhum estado, nenhum log de alarme (a rede de 15 min, na mesma reunião, bloqueia e alarma)', async () => {
    const a = await reuniao(0, 45, [conf('c1', 1, null)]);
    const antes = await row(a.id);
    const marca = logs.output().length;

    fake.scopeMissing();
    const s1 = await live.runOnce(at(10));
    fake.transient();
    const s2 = await live.runOnce(at(11));
    expect(s1.scopeMissing).toBe(1);
    expect(s2.transient).toBe(1);
    const depois = await row(a.id);
    expect(depois).toMatchObject({ import_status: null, conference_started_at: null, conference_ended_at: null });
    expect(new Date(depois.updated_at).getTime()).toBe(new Date(antes.updated_at).getTime());
    expect(await kinds(a.id)).toEqual([]);
    const saida = logs.output().slice(marca);
    expect(saida).toContain('admission.live.run_done'); // controle: a saída foi lida
    expect(saida).not.toContain('admission.import_blocked');
    expect(saida).not.toContain('"level":50'); // nenhum error

    fake.scopeMissing(); // controle: a rede, com o mesmo erro, bloqueia e grava
    await rede.runOnce(at(12));
    expect((await row(a.id)).import_status).toBe('blocked');
    expect(logs.output().slice(marca)).toContain('admission.import_blocked');
    expect(logs.output().slice(marca)).toContain('"level":50'); // controle: o nível error aparece na saída quando existe
  });
});
