/**
 * admissionLiveResumoCenarios — spec 050 F28: o gatilho do resumo pelas rotas HTTP reais, nos dois papéis (`runtime` × `dono`).
 * A28-1 as cinco sequências de contagem · A28-2 desiste aos 10 min e a rede termina · A28-4 sem a rota nova = resultado de hoje
 * A28-5 sentinela · A28-6 `not_ready` não escreve estado · A28-7 uma leitura por minuto · A28-8 um resumo só, no fim (R-49, R-56).
 */
import { ResumoHarness, type ConexaoResumo, type ReuniaoResumo } from './admissionLiveResumoHarness';
import { createFastGate } from '../../../src/modules/matching/application/AdmissionFastGate';

const SENTINELA = 'Quixotrium';
const TELEFONE = '+5491155550128';

export function definirCenariosResumo(conexao: ConexaoResumo, sufixo: string): void {
  describe(`F28 — resumo assim que a transcrição estiver pronta, HTTP real, conexão: ${conexao}`, () => {
    const h = new ResumoHarness(conexao, sufixo);
    beforeAll(() => h.iniciar(), 90000);
    afterAll(() => h.encerrar());
    beforeEach(async () => {
      h.reiniciarDubles();
      await h.limparReunioes();
    });

    /** Reunião 10:00–10:45 com uma conferência de 1 a `fim` min; a 1ª rodada do job de 1 min (em `fim + 1`) grava o fim e arma o gatilho. */
    async function armada(fim = 30, blocos = 3): Promise<ReuniaoResumo> {
      const r = await h.reuniao(0, 45);
      h.conferencias(r, h.conf('c1', 1, fim));
      h.blocos(r, blocos);
      await h.vivo(fim + 1);
      expect(await h.row(r.id)).toMatchObject({ import_status: 'pending', summary_fast_state: 'armed' });
      return r;
    }
    const buscas = (): number => h.mcp.searchCalls.length;

    it('0. sanidade: a conexão é a que o arquivo declara e, no runtime, a RLS está de pé', async () => {
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const raw = DatabaseConnection.getInstance().getRawPool();
      expect((await raw.query('SELECT current_user AS u')).rows[0].u).toBe(conexao === 'runtime' ? `adm050rs_rt_${sufixo}` : new URL(process.env.DATABASE_URL as string).username);
      const semContexto = raw.query(`SELECT count(*)::int AS n FROM patients`);
      if (conexao === 'runtime') await expect(semContexto).rejects.toThrow(/rls_session_without_identity/);
      else expect((await semContexto).rows[0].n).toBeGreaterThanOrEqual(0);
    });

    it('A28-1 (R-51): contagens 0, 3, 3 → importa na 3ª leitura (1 documento, 1 admission.paid_call); nenhuma busca antes de fim + 3 min (controle: aos 3 min há 1)', async () => {
      const p0 = h.pagas();
      const r = await armada(30, 0);
      await h.vivo(32);
      expect(buscas()).toBe(0); // fim + 2 min
      await h.vivo(33);
      expect(buscas()).toBe(1); // controle: fim + 3 min, a 1ª leitura (a reunião ainda não apareceu: contagem 0)
      h.blocos(r, 3);
      await h.vivo(34);
      expect(await h.row(r.id)).toMatchObject({ import_status: 'pending', import_attempts: 0, summary_fast_state: 'armed', summary_fast_reads: 2, summary_fast_last_count: 3 });
      expect(h.chamadas().vertex).toBe(0);
      expect(h.vault.putCalls).toHaveLength(0);
      await h.vivo(35);
      expect(await h.row(r.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'fired', summary_fast_reads: 3 });
      expect([buscas(), h.chamadas().vertex, h.docs.length, h.pagas() - p0, await h.count(r.id, 'summary_saved')]).toEqual([3, 1, 1, 1, 1]);
      expect(await h.kinds(r.id)).toEqual(expect.arrayContaining(['summary_fast_ready:done', 'transcript_vaulted', 'import_matched']));
      await h.vivo(36);
      await h.importar(60); // a rede depois: nada a refazer
      expect([buscas(), h.chamadas().vertex, h.docs.length]).toEqual([3, 1, 1]);
    });

    it('A28-1 (R-51): contagens 0, 3, 4, 4 → importa na 4ª leitura, não antes', async () => {
      const r = await armada(30, 0);
      await h.vivo(33);
      for (const [min, n] of [[34, 3], [35, 4]] as const) { h.blocos(r, n); await h.vivo(min); }
      expect(h.chamadas().vertex).toBe(0); // 3 e depois 4: ainda mudando
      expect(await h.row(r.id)).toMatchObject({ summary_fast_state: 'armed', summary_fast_reads: 3, summary_fast_last_count: 4 });
      await h.vivo(36);
      expect(await h.row(r.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'fired', summary_fast_reads: 4 });
      expect([buscas(), h.chamadas().vertex]).toEqual([4, 1]);
    });

    it('A28-1 (R-51): leituras a ≥ 60 s uma da outra (a 2ª, 30 s depois da 1ª, não lê; aos 60 s lê)', async () => {
      const r = await armada();
      await h.vivo(33);
      await h.vivo(33.5);
      await h.vivo(33.9);
      expect(buscas()).toBe(1);
      await h.vivo(34);
      expect(buscas()).toBe(2); // controle: o relógio andou 60 s e a leitura veio
      expect((await h.row(r.id)).summary_fast_reads).toBe(2);
    });

    it('A28-1 (R-51): 3 estável com a conferência ABERTA → 0 importações (o gatilho cai); a mesma contagem com a sala fechada importa (controle)', async () => {
      const r = await armada();
      await h.vivo(33); // 1ª leitura: 3, sem leitura anterior
      h.conferencias(r, h.conf('c1', 1, 30), h.conf('c2', 33.5, null));
      await h.vivo(34);
      await h.vivo(35);
      await h.vivo(36);
      expect(buscas()).toBe(1); // reabriu: o gatilho foi cancelado e nenhuma leitura nova saiu
      expect(await h.row(r.id)).toMatchObject({ summary_fast_state: 'cancelled', import_status: null });
      expect(h.chamadas().vertex).toBe(0);
      // o portão sozinho, com a sala aberta e a contagem estável, também segura (e solta com a sala fechada)
      const x = await h.reuniao(0, 45, { conferenceStartedMin: 1, conferenceEndedMin: 30, importStatus: 'pending' });
      expect(await h.importarDireto(x.id, 36, createFastGate({ previousCount: 3, conferenceOpen: true }))).toBe('not_ready');
      expect(h.chamadas().vertex).toBe(0);
      expect(await h.importarDireto(x.id, 36, createFastGate({ previousCount: 3, conferenceOpen: false }))).toBe('done');
      expect(h.chamadas().vertex).toBe(1);
    });

    it('A28-1 (R-51) + A28-2 (R-52): nunca estabiliza → 5 leituras e nenhuma 6ª; gave_up por max_reads com UM evento', async () => {
      const r = await armada(30, 1);
      for (const [i, min] of [33, 34, 35, 36, 37].entries()) { h.blocos(r, i + 1); await h.vivo(min); }
      expect(buscas()).toBe(5);
      expect(await h.row(r.id)).toMatchObject({ summary_fast_state: 'armed', summary_fast_reads: 5 });
      for (const min of [38, 39, 40, 41, 42]) await h.vivo(min);
      expect(buscas()).toBe(5); // nenhuma 6ª
      expect(await h.row(r.id)).toMatchObject({ summary_fast_state: 'gave_up', import_status: 'pending', import_attempts: 0 });
      expect(await h.count(r.id, 'summary_fast_gave_up')).toBe(1);
      expect(await h.kinds(r.id)).toContain('summary_fast_gave_up:max_reads');
      expect(h.chamadas().vertex).toBe(0);
    });

    it('A28-2 (R-52): prazo de 10 min → gave_up por deadline (1 evento, nenhuma leitura nova); depois a rota de sempre do admission-import termina o trabalho', async () => {
      const r = await armada(30, 1);
      await h.vivo(33);
      h.blocos(r, 2);
      await h.vivo(34);
      h.blocos(r, 3);
      await h.vivo(41); // fim + 11 min: o prazo passou
      await h.vivo(42);
      expect(buscas()).toBe(2); // o job de 1 min não leu mais
      expect(await h.row(r.id)).toMatchObject({ summary_fast_state: 'gave_up', import_status: 'pending' });
      expect(await h.kinds(r.id)).toContain('summary_fast_gave_up:deadline');
      expect(await h.count(r.id, 'summary_fast_gave_up')).toBe(1);
      expect(h.chamadas().vertex).toBe(0);
      const rede = await h.importar(42);
      expect(rede.data.done).toBeGreaterThanOrEqual(1);
      expect(await h.row(r.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'gave_up' });
      expect([h.chamadas().vertex, h.docs.length, await h.count(r.id, 'summary_saved')]).toEqual([1, 1, 1]);
    });

    it('A28-4 (R-54): só as duas rotas antigas → fim, importação e resumo de sempre, summary_fast_* vazio e 0 eventos novos; com a rota nova há ≥ 1 chamada de cada (controle)', async () => {
      async function percurso(comNova: boolean): Promise<ReuniaoResumo> {
        const r = await h.reuniao(0, 45);
        h.conferencias(r, h.conf('c1', 1, 30));
        if (comNova) for (const min of [31, 33, 34, 35]) await h.vivo(min);
        await h.rede(46);
        await h.importar(57);
        return r;
      }
      const a = await percurso(false);
      const sem = h.chamadas();
      const rowSem = await h.row(a.id);
      expect(rowSem).toMatchObject({ import_status: 'done', summary_fast_state: null, summary_fast_reads: null, summary_fast_last_count: null, summary_fast_last_read_at: null });
      expect(new Date(rowSem.conference_ended_at).toISOString()).toBe(h.at(30).toISOString());
      const kindsSem = await h.kinds(a.id);
      expect(kindsSem.filter((k) => /^(conference_reopened|summary_fast_)/.test(k))).toEqual([]);
      expect(kindsSem).toEqual(expect.arrayContaining(['conference_ended', 'import_matched', 'summary_saved']));
      expect(sem).toEqual({ meet: 1, tactiq: 2, vertex: 1 }); // 1 listagem do Meet; 1 busca + 1 página; 1 resumo

      await h.limparReunioes(); // a 1ª reunião sairia da janela só às 11:45 e o job de 1 min a listaria no Meet de novo
      h.reiniciarDubles();
      const b = await percurso(true);
      const com = h.chamadas();
      expect(await h.row(b.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'fired' });
      expect(com.meet).toBeGreaterThanOrEqual(1);
      expect(com.tactiq).toBeGreaterThanOrEqual(1);
      expect(com).toEqual({ meet: 4, tactiq: 4, vertex: 1 }); // 4 rodadas do job de 1 min listam o Meet; 2 leituras (busca + página); o resumo é UM, só que mais cedo
      expect(com.meet).toBeGreaterThan(sem.meet);
      expect(com.tactiq).toBeGreaterThan(sem.tactiq);
      expect(new Date((await h.row(b.id)).conference_ended_at).toISOString()).toBe(h.at(30).toISOString());
    });

    it('A28-5 (R-55): nome, telefone, e-mail e texto-sentinela nunca vão para log, trilha, linhas do gatilho nem resposta — nem quando o Tactiq falha com a sentinela na mensagem', async () => {
      const paciente = await h.fx.criarPaciente({ isTest: false, primeiroNome: SENTINELA, sobrenome: `${SENTINELA}Sobrenome`, telefone: TELEFONE });
      const r = await h.reuniao(0, 45, { pacienteId: paciente });
      h.conferencias(r, h.conf('c1', 1, 30));
      h.blocos(r, 3, `${SENTINELA}-clinico`);
      h.logs.log.info({}, 'marca-inicial');
      const marca = h.logs.output().length;
      const respostas: string[] = [];
      respostas.push((await h.vivo(31)).texto);
      h.mcp.searchError = new Error(`falha com ${SENTINELA} e ${TELEFONE}`);
      respostas.push((await h.vivo(33)).texto); // leitura que falha: o caminho de erro roda
      expect(buscas()).toBe(1);
      h.mcp.searchError = null;
      for (const min of [34, 35]) respostas.push((await h.vivo(min)).texto);
      expect(await h.row(r.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'fired' }); // controle: o caminho pago rodou até o fim
      expect(h.vertex.received.join('')).toContain(`${SENTINELA}-clinico`); // controle: a sentinela EXISTE no Vertex (onde pode estar)
      const ap = (await h.admin.query(`SELECT host_email, meet_link FROM admission_appointments WHERE id = $1`, [r.id])).rows[0];
      const trilha = JSON.stringify((await h.admin.query(`SELECT kind, outcome, reason, ref FROM admission_events WHERE appointment_id = $1`, [r.id])).rows);
      const gatilho = JSON.stringify((await h.admin.query(
        `SELECT import_status, import_attempts, summary_fast_state, summary_fast_reads, summary_fast_last_count, summary_fast_last_read_at FROM admission_appointments WHERE id = $1`, [r.id])).rows);
      const saida = h.logs.output().slice(marca);
      expect(saida).toContain('admission.live.run_done'); // controles: o log, a trilha e o gatilho existem e foram lidos
      expect(saida).toContain('admission.summary_fast_ready');
      expect(trilha).toContain('summary_fast_ready');
      expect(gatilho).toContain('fired');
      const proibidos = [SENTINELA, TELEFONE, 'Operadora Sintetica', ap.host_email, ap.meet_link, r.meetCode];
      for (const [fonte, texto] of [['log', saida], ['trilha', trilha], ['gatilho', gatilho], ['resposta', respostas.join('')]] as const) {
        for (const p of proibidos) expect({ fonte, p, achou: texto.includes(p) }).toEqual({ fonte, p, achou: false });
      }
    });

    it('A28-6: `not_ready` não escreve estado (import_status, import_attempts e trilha como estavam; 0 import_waiting); a rede, na mesma situação, grava import_waiting (controle)', async () => {
      const semana = { conferenceStartedMin: 1, conferenceEndedMin: 30, importStatus: 'pending' } as const;
      const fast = await h.reuniao(0, 45, semana);
      const rede = await h.reuniao(0, 45, semana);
      h.blocos(fast, 0);
      h.blocos(rede, 0); // a reunião não apareceu no Tactiq
      const antes = { row: await h.row(fast.id), eventos: await h.kinds(fast.id) };
      expect(await h.importarDireto(fast.id, 33, createFastGate({ previousCount: null, conferenceOpen: false }))).toBe('not_ready');
      expect(buscas()).toBe(1); // controle: o Tactiq FOI lido
      expect(await h.row(fast.id)).toEqual(antes.row);
      expect(await h.kinds(fast.id)).toEqual(antes.eventos);
      expect(await h.count(fast.id, 'import_waiting')).toBe(0);
      expect(await h.importarDireto(rede.id, 41)).toBe('waiting');
      expect(await h.row(rede.id)).toMatchObject({ import_status: 'waiting', import_attempts: 1 });
      expect(await h.count(rede.id, 'import_waiting')).toBe(1);
      // e pelo job: várias rodadas sem a reunião aparecer não mexem em estado de importação
      const viva = await armada(30, 0);
      for (const min of [33, 34, 35]) await h.vivo(min);
      expect(await h.row(viva.id)).toMatchObject({ import_status: 'pending', import_attempts: 0, summary_fast_reads: 3, summary_fast_last_count: null });
      expect(await h.count(viva.id, 'import_waiting')).toBe(0);
    });

    it('A28-7 (R-53): duas execuções no mesmo minuto, uma depois da outra → 1 leitura (sem a reivindicação o teste mede 2)', async () => {
      const r = await armada();
      await h.vivo(33);
      await h.vivo(33);
      expect(buscas()).toBe(1);
      expect((await h.row(r.id)).summary_fast_reads).toBe(1);
    });

    it('A28-7 (R-53): duas execuções SOBREPOSTAS no mesmo minuto (a 1ª ainda lendo) → 1 leitura em voo e 1 no total', async () => {
      const r = await armada();
      let solta = (): void => undefined;
      h.mcp.gate = new Promise<void>((resolve) => { solta = resolve; });
      const p1 = h.vivo(33);
      for (let i = 0; i < 200 && h.mcp.inFlight < 1; i += 1) await new Promise((res) => setTimeout(res, 25));
      expect(h.mcp.inFlight).toBe(1); // controle: a 1ª leitura está presa no Tactiq dublado
      const p2 = h.vivo(33); // chega com a leitura em voo
      expect((await p2).status).toBe(200);
      solta();
      expect((await p1).status).toBe(200);
      h.mcp.gate = null;
      expect([buscas(), h.mcp.maxInFlight]).toEqual([1, 1]);
      expect((await h.row(r.id)).summary_fast_reads).toBe(1);
    });

    it('A28-8 (R-49): saída e volta com o gatilho armado → cancelado (0 leitura na volta), 1 resumo só, no fim novo', async () => {
      const r = await armada(20);
      h.conferencias(r, h.conf('c1', 1, 20), h.conf('c2', 22, null));
      await h.vivo(23); // fim + 3 min do 1º fim: a leitura estaria liberada, mas a sala reabriu
      expect(buscas()).toBe(0);
      expect(await h.row(r.id)).toMatchObject({ summary_fast_state: 'cancelled', import_status: null });
      expect(await h.count(r.id, 'conference_reopened')).toBe(1);
      h.conferencias(r, h.conf('c1', 1, 20), h.conf('c2', 22, 40));
      await h.vivo(41); // rearma no fim novo (40)
      expect(await h.row(r.id)).toMatchObject({ summary_fast_state: 'armed', import_status: 'pending' });
      await h.vivo(42);
      expect(buscas()).toBe(0); // fim novo + 2 min
      for (const min of [43, 44]) await h.vivo(min);
      expect(await h.row(r.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'fired' });
      expect([h.chamadas().vertex, h.docs.length, await h.count(r.id, 'summary_saved')]).toEqual([1, 1, 1]);
    });

    it('A28-8 (R-56): sala aberta 10 min antes e reaberta na hora → 0 chamada paga antes do fim de verdade, 1 resumo só; fim aos 30 de 45 dispara (controle)', async () => {
      const r = await h.reuniao(0, 45);
      h.conferencias(r, h.conf('c1', -10, 5));
      h.blocos(r, 3);
      for (const min of [6, 9, 12]) await h.vivo(min);
      expect(await h.row(r.id)).toMatchObject({ summary_fast_state: null, import_status: null });
      expect(await h.kinds(r.id)).toContain('conference_ended:too_early');
      h.conferencias(r, h.conf('c1', -10, 5), h.conf('c2', 10, null));
      await h.vivo(13);
      expect(h.chamadas().tactiq).toBe(0);
      expect(h.chamadas().vertex).toBe(0); // 0 chamada paga até aqui
      h.conferencias(r, h.conf('c1', -10, 5), h.conf('c2', 10, 40));
      await h.vivo(41);
      for (const min of [43, 44]) await h.vivo(min);
      expect(await h.row(r.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'fired' });
      expect([h.chamadas().vertex, h.docs.length]).toEqual([1, 1]);
      const controle = await armada(30);
      for (const min of [33, 34]) await h.vivo(min);
      expect(await h.row(controle.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'fired' });
    });
  });
}
