/**
 * admissionTravaTactiqHarness — spec 050, 4º passo, F27 (R-53): UMA leitura do Tactiq por vez por responsável. Banco real, vínculo REAL
 * (`TactiqLinkService`, a única porta para um token), importação REAL; Tactiq, cofre e Vertex são dublês que CONTAM (`inFlight`/`maxInFlight`).
 *
 * O MESMO conjunto roda em dois arquivos, mudando SÓ quem conecta (`-runtime`: login membro de `app_runtime` + pool de sistema `app_system`,
 * RLS de país ligada, como a stage; `-dono`: controle, como a produção). O relógio é parâmetro. Dados sintéticos (@example.test).
 *
 * A27-1 mesma responsável, rodadas sobrepostas → 1 em voo · A27-2 responsáveis diferentes → 2 em voo · A27-3 importação × teste diário
 * (nos dois sentidos): quem perde não muda estado · A27-5 rotação gravada ANTES do uso, trilha da importação · A27-6 `fn` que lança solta.
 */
import { Pool } from 'pg';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { TactiqUnauthorizedError, type TactiqMeetingItem } from '../../../src/modules/matching/application/ports/TactiqPorts';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { FakeAdmissionSummaryGenerator } from '../../../src/modules/matching/infrastructure/doubles/FakeAdmissionSummaryGenerator';
import { InMemoryTranscriptVault } from '../../../src/modules/matching/infrastructure/doubles/InMemoryTranscriptVault';
import { capturingLogger } from '../../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import type { StoreAdmissionSummaryDocument } from '../../../src/modules/patient-documents/application/StoreAdmissionSummaryDocument';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
export type ConexaoTrava = 'runtime' | 'dono';
const SENHA = 'adm050_trv_pw';
const MIN = 60_000;
const T0 = new Date('2031-04-14T10:00:00Z');
const CTX = 'job:admission-import';

export function definirCenariosTravaTactiq(conexao: ConexaoTrava, sufixo: string): void {
  const RUNTIME_USER = `adm050tv_rt_${sufixo}`;
  const SYSTEM_USER = `adm050tv_sys_${sufixo}`;
  const host = (n: number): string => `ana.trava.${sufixo}.${n}@example.test`;

  describe(`F27 — uma leitura do Tactiq por vez por responsável, conexão: ${conexao}`, () => {
    let admin: Pool;
    let patientId = '';
    let seq = 0;
    const mcp = new FakeTactiqMcp();
    const oauth = new FakeTactiqOAuth();
    const vault = new InMemoryTranscriptVault();
    const vertex = new FakeAdmissionSummaryGenerator();
    const logs = capturingLogger();
    const envAnterior: Record<string, string | undefined> = {};
    let link: import('../../../src/modules/matching/application/TactiqLinkService').TactiqLinkService;
    let importer: import('../../../src/modules/matching/application/AdmissionImportService').AdmissionImportService;
    let sysCtx: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
    function setEnv(k: string, v: string | undefined): void {
      if (!(k in envAnterior)) envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    /** Reunião terminada há 80 min (importável), do responsável `h`, com vínculo vivo cujo refresh token é o próprio e-mail. */
    async function reuniao(h: string, horasDepois = 0): Promise<{ id: string; code: string }> {
      seq += 1;
      const start = new Date(T0.getTime() - 120 * MIN - horasDepois * 60 * MIN); // outro horário: a trava de horário é por anfitriã
      const code = `ADM-${(sufixo + seq + Math.random().toString(36).slice(2, 8)).toUpperCase().slice(-6)}`;
      const { rows } = await admin.query(
        `INSERT INTO admission_appointments (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link,
           admission_code, created_at, conference_ended_at, import_status)
         VALUES ($1,'AR',$2,'Operadora Sintetica',$3,$4,'booked',$5,$6,$7,$8,'pending') RETURNING id`,
        [patientId, h, start, new Date(start.getTime() + 30 * MIN), `https://meet.google.com/trv-${sufixo}${seq}-xyz`, code,
          new Date(start.getTime() - 300 * MIN), new Date(T0.getTime() - 80 * MIN)],
      );
      const item: TactiqMeetingItem = { id: `tq-${code}`, title: `${code} Admisión`, createdAt: start.toISOString(), durationSeconds: 1800 };
      for (const tk of [`at-${h}`, `at-rt-novo-${sufixo}`]) mcp.meetingsByToken.set(tk, [...(mcp.meetingsByToken.get(tk) ?? []), item]);
      mcp.pagesByMeeting.set(item.id, [{ page: 1, totalPages: 1, totalChars: 18, hasMore: false, entries: [{ text: 'TEXTO-SINTETICO-UM', speaker: 'Operadora', startSeconds: 0, endSeconds: 9 }] }]);
      return { id: rows[0].id as string, code };
    }
    async function vincular(h: string): Promise<void> {
      await admin.query(`DELETE FROM tactiq_links WHERE lower(host_email) = lower($1)`, [h]);
      const { TactiqLinkRepository } = await import('../../../src/modules/matching/infrastructure/TactiqLinkRepository');
      await new TactiqLinkRepository(admin).upsertLinked({ email: h, uid: `e2e-050-trv-${sufixo}`, tokenEncrypted: h, clientId: null, now: T0 });
    }
    const importar = (id: string) => sysCtx(CTX, () => importer.importOne(id, T0));
    const testeDiario = () => sysCtx(CTX, () => link.runDailyCheck());
    const estado = async (id: string) =>
      (await admin.query(
        `SELECT a.import_status, a.import_attempts, (SELECT count(*)::int FROM admission_events e WHERE e.appointment_id = a.id) AS eventos
           FROM admission_appointments a WHERE a.id = $1`, [id])).rows[0] as { import_status: string; import_attempts: number; eventos: number };
    const vinculo = async (h: string) =>
      (await admin.query(`SELECT status, last_check_outcome FROM tactiq_links WHERE lower(host_email) = lower($1)`, [h])).rows[0] as { status: string; last_check_outcome: string };
    const refreshGravado = async (h: string): Promise<string> =>
      (await admin.query(`SELECT s.refresh_token_encrypted AS t FROM tactiq_link_secrets s JOIN tactiq_links l ON l.id = s.link_id WHERE lower(l.host_email) = lower($1)`, [h])).rows[0].t;
    /** A chave da trava, vista de OUTRA conexão: `true` = estava livre (e foi solta de novo). */
    async function chaveLivre(h: string): Promise<boolean> {
      const c = await admin.connect();
      try {
        const ok = (await c.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok`, [`tactiq_link:${h.toLowerCase()}`])).rows[0].ok as boolean;
        if (ok) await c.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`tactiq_link:${h.toLowerCase()}`]);
        return ok;
      } finally {
        c.release();
      }
    }
    async function esperar(cond: () => boolean): Promise<void> {
      for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 25));
      expect(cond()).toBe(true);
    }
    let soltarTudo: Array<() => void> = [];
    const segurar = (): { release: () => void } => {
      let release = (): void => undefined;
      mcp.gate = new Promise<void>((r) => { release = r; });
      soltarTudo.push(release);
      return { release };
    };

    async function limpar(): Promise<void> {
      await admin.query(`DELETE FROM admission_appointments WHERE host_email LIKE $1`, [`ana.trava.${sufixo}.%@example.test`]);
      await admin.query(`DELETE FROM tactiq_links WHERE host_email LIKE $1`, [`ana.trava.${sufixo}.%@example.test`]);
      await admin.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [`e2e-050-trv-${sufixo}`]);
    }

    beforeAll(async () => {
      admin = new Pool({ connectionString: DATABASE_URL });
      await ensureLoginRole(admin, RUNTIME_USER, SENHA, 'app_runtime');
      await ensureLoginRole(admin, SYSTEM_USER, SENHA, 'app_system');
      await limpar();
      setEnv('DATABASE_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, RUNTIME_USER, SENHA) : DATABASE_URL);
      setEnv('DATABASE_SYSTEM_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, SYSTEM_USER, SENHA) : undefined);
      setEnv('COUNTRY_RLS_ENABLED', 'true');
      setEnv('DB_POOL_MAX', '6');
      // O default de produção: uma importação em voo custa 2 conexões do pool de sistema (cliente da request + a conexão das duas travas,
      // reunião e responsável); duas simultâneas (4) têm de caber. Com uma conexão por trava seriam 3 cada e este pool de 5 não caberia.
      setEnv('DB_SYSTEM_POOL_MAX', '5');
      patientId = (await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent)
         VALUES ($1,'Carla','Sintetico','AR',false,true) RETURNING id`, [`e2e-050-trv-${sufixo}`])).rows[0].id;

      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      sysCtx = (await import('@shared/database/requestDbSession')).withSystemDbContext;
      const { TactiqLinkService } = await import('../../../src/modules/matching/application/TactiqLinkService');
      const { TactiqLinkRepository } = await import('../../../src/modules/matching/infrastructure/TactiqLinkRepository');
      const { AdmissionImportService } = await import('../../../src/modules/matching/application/AdmissionImportService');
      const { AdmissionImportRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionImportRepository');
      const { AdmissionEventRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionEventRepository');
      const pool = DatabaseConnection.getInstance().getPool();
      link = new TactiqLinkService({
        repo: new TactiqLinkRepository(pool), oauth, mcp, cipher: { encrypt: async (p) => p, decrypt: async (c) => c }, db: pool, log: logs.log, now: () => T0,
      });
      const documents = {
        prepare: async () => ({ commit: async () => ({ outcome: 'stored' as const, documentId: '00000000-0000-4000-8000-000000000052', sizeBytes: 1, sha256: 'x' }), discard: async () => undefined }),
      } as unknown as StoreAdmissionSummaryDocument;
      importer = new AdmissionImportService({
        repo: new AdmissionImportRepository(pool), events: new AdmissionEventRepository(pool), tokens: link, mcp, vault, summary: vertex, documents, db: pool, log: logs.log, now: () => T0,
      });
    }, 90000);

    afterEach(() => {
      for (const solta of soltarTudo) solta(); // teste que falhou no meio não deixa leitura presa (o `pool.end()` do afterAll esperaria)
      soltarTudo = [];
    });

    beforeEach(() => {
      mcp.reset();
      vertex.reset();
    });

    afterAll(async () => {
      mcp.gate = null;
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      await DatabaseConnection.getInstance().close();
      await limpar();
      await dropLoginRoles(admin, [RUNTIME_USER, SYSTEM_USER]);
      await admin.end();
      for (const [k, v] of Object.entries(envAnterior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('0. sanidade: a conexão é a que o arquivo declara e, no runtime, a RLS está de pé', async () => {
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const raw = DatabaseConnection.getInstance().getRawPool();
      expect((await raw.query('SELECT current_user AS u')).rows[0].u).toBe(conexao === 'runtime' ? RUNTIME_USER : new URL(DATABASE_URL).username);
      const semContexto = raw.query(`SELECT count(*)::int AS n FROM patients WHERE id = $1`, [patientId]);
      if (conexao === 'runtime') await expect(semContexto).rejects.toThrow(/rls_session_without_identity/);
      else expect((await semContexto).rows[0].n).toBe(1);
    });

    it('A27-1 + A27-5: duas reuniões da MESMA responsável em rodadas sobrepostas → 1 em voo; quem espera não muda estado; o refresh rotacionado já está gravado ANTES do uso', async () => {
      const h = host(1);
      await vincular(h);
      const a1 = await reuniao(h);
      const a2 = await reuniao(h, 3);
      oauth.rotateTo(`rt-novo-${sufixo}`);
      const g = segurar();

      const p1 = importar(a1.id);
      await esperar(() => mcp.inFlight === 1);
      expect(await refreshGravado(h)).toBe(`rt-novo-${sufixo}`); // A27-5: gravado antes de a busca terminar
      expect(await chaveLivre(h)).toBe(false); // controle: a chave está presa enquanto a leitura está em voo
      expect(await chaveLivre(host(99))).toBe(true); // e é só desta responsável
      const antes = await estado(a2.id);
      const p2 = importar(a2.id);
      await Promise.race([p2, new Promise((r) => setTimeout(r, 400))]); // sem a trava, a 2ª entraria na busca e ficaria presa no `gate`
      expect(mcp.maxInFlight).toBe(1);
      expect(await p2).toBe('transient');
      expect(await estado(a2.id)).toEqual(antes); // sem estado novo, sem tentativa, sem evento
      expect(antes).toMatchObject({ import_status: 'pending', import_attempts: 0, eventos: 0 });
      expect(await link.withHostAccess(h.toUpperCase(), async () => 'x')).toEqual({ ok: false, reason: 'busy' }); // e-mail em minúsculas na chave
      expect(mcp.searchCalls).toHaveLength(1);
      expect(mcp.maxInFlight).toBe(1);

      g.release();
      expect(await p1).toBe('done');
      expect(await chaveLivre(h)).toBe(true);
      mcp.gate = null;
      expect(await importar(a2.id)).toBe('done'); // na rodada seguinte ela consegue
      expect(mcp.maxInFlight).toBe(1);
      expect(oauth.refreshCalls).toEqual([h, `rt-novo-${sufixo}`]); // a 2ª troca usou o refresh que a 1ª gravou
      const ev = await admin.query(`SELECT kind FROM admission_events WHERE appointment_id = $1 ORDER BY at, kind`, [a1.id]);
      expect(ev.rows.map((r) => r.kind)).toEqual(['import_matched', 'transcript_vaulted', 'summary_saved']); // mesma trilha de sempre
      const sha = (await admin.query(`SELECT ref->>'sha256' AS s FROM admission_events WHERE appointment_id = $1 AND kind = 'import_matched'`, [a1.id])).rows[0].s as string;
      expect(vault.putCalls.some((o) => o.includes(a1.id) && o.includes(sha))).toBe(true); // o objeto do cofre leva o sha256 da trilha
    });

    it('A27-2: responsáveis DIFERENTES em paralelo → 2 em voo (a trava é por responsável, não global)', async () => {
      const [h1, h2] = [host(2), host(3)];
      await Promise.all([vincular(h1), vincular(h2)]);
      const [a1, a2] = [await reuniao(h1), await reuniao(h2)];
      const g = segurar();
      const [p1, p2] = [importar(a1.id), importar(a2.id)];
      await esperar(() => mcp.inFlight === 2);
      expect(mcp.maxInFlight).toBe(2);
      g.release();
      expect([await p1, await p2]).toEqual(['done', 'done']);
    });

    it('A27-3: importação em voo × teste diário → o teste não pinga, não rebaixa e não grava; terminada a leitura, o mesmo teste pinga (controle)', async () => {
      const h = host(4);
      await vincular(h);
      const a = await reuniao(h);
      mcp.pingError = new TactiqUnauthorizedError(); // se o teste diário furasse a trava, o vínculo cairia para `broken`
      const g = segurar();
      const p = importar(a.id);
      await esperar(() => mcp.inFlight === 1);
      await testeDiario();
      expect(mcp.pingTokens).not.toContain(`at-${h}`);
      expect(await vinculo(h)).toEqual({ status: 'linked', last_check_outcome: 'linked' });
      g.release();
      expect(await p).toBe('done');

      await testeDiario(); // controle positivo: livre, o teste pinga e, com o erro programado, rebaixa
      expect(mcp.pingTokens).toContain(`at-${h}`);
      expect(await vinculo(h)).toMatchObject({ status: 'broken' });
    });

    it('A27-3: teste diário em voo × importação → a importação sai `transient` sem estado, sem tentativa e sem evento; o vínculo segue `linked`', async () => {
      const h = host(5);
      await vincular(h);
      const a = await reuniao(h);
      let solta = (): void => undefined;
      mcp.pingGates.set(`at-${h}`, new Promise<void>((r) => { solta = r; }));
      soltarTudo.push(() => solta());
      const diario = testeDiario();
      await esperar(() => mcp.inFlight === 1);
      const antes = await estado(a.id);
      expect(await importar(a.id)).toBe('transient');
      expect(await estado(a.id)).toEqual(antes);
      expect(mcp.searchCalls).toHaveLength(0);
      solta();
      await diario;
      expect(await vinculo(h)).toMatchObject({ status: 'linked', last_check_outcome: 'ok' });
      expect(await importar(a.id)).toBe('done'); // controle: livre, importa
      expect(mcp.searchCalls).toHaveLength(1);
    });

    it('A27-6: `fn` que lança solta a trava (a chamada seguinte da mesma responsável consegue; nenhuma conexão presa)', async () => {
      const h = host(6);
      await vincular(h);
      await expect(sysCtx(CTX, () => link.withHostAccess(h, async () => { throw new Error('boom'); }))).rejects.toThrow('boom');
      expect(await chaveLivre(h)).toBe(true);
      expect(await sysCtx(CTX, () => link.withHostAccess(h, async (t) => t))).toEqual({ ok: true, value: `at-${h}` });
      const presos = await admin.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid() AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
      expect(presos.rows[0].n).toBe(0);
    });

    it('a chave da trava (com o e-mail) nunca vai para log', () => {
      const saida = logs.output();
      expect(saida.length).toBeGreaterThan(0); // controle: o logger capturou algo
      expect(saida).not.toContain('tactiq_link:');
      expect(saida).not.toContain(`ana.trava.${sufixo}`);
    });
  });
}
