/**
 * spec 050 F28 — A28-3: o modo rápido é o MESMO `importHeld` da rede de 15 min (cofre, `admission.paid_call`, Vertex, PDF, documento, teto
 * de 3 tentativas, `is_test`, ensaio). Banco real, as três rotas reais, dublês que contam. Conexão `dono`, com o pool de sistema de
 * DOIS (o do `docker-compose.test.yml`): o caminho rápido pela rota não pode abrir conexão extra enquanto a trava está presa (senão trava).
 */
import { createHash } from 'crypto';
import { ResumoHarness } from './helpers/admissionLiveResumoHarness';
import { AdmissionSummaryError } from '../../src/modules/matching/application/ports/AdmissionImportPorts';
import { createFastGate } from '../../src/modules/matching/application/AdmissionFastGate';

describe('F28 — o modo rápido percorre o mesmo caminho da importação de sempre (A28-3)', () => {
  const h = new ResumoHarness('dono', 'f28c', 2);
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  beforeAll(() => h.iniciar(), 90000);
  afterAll(() => h.encerrar());
  beforeEach(async () => {
    h.reiniciarDubles();
    await h.limparReunioes();
  });

  async function fechada(extra: Parameters<ResumoHarness['reuniao']>[2] = {}) {
    const r = await h.reuniao(0, 45, { conferenceStartedMin: 1, conferenceEndedMin: 30, importStatus: 'pending', summaryFastState: 'armed', ...extra });
    h.conferencias(r, h.conf('c1', 1, 30));
    return r;
  }
  const objeto = (r: { id: string }): { nome: string; sha: string } => {
    const [nome, o] = [...h.vault.objects.entries()].find(([n]) => n.includes(r.id)) as [string, { body: Buffer }];
    return { nome, sha: sha(o.body) };
  };

  it('mesma fixture, rápido × rede: o objeto do cofre (nome com o sha256 do conteúdo), o documento, a trilha e a entrada do Vertex são IGUAIS', async () => {
    const rapido = await fechada();
    const rede = await fechada({ summaryFastState: null }); // a rede de 15 min não tem gatilho armado
    for (const r of [rapido, rede]) h.blocos(r, 3, 'TEXTO-IGUAL');
    for (const min of [33, 34]) await h.vivo(min); // pela rota: o pool de sistema tem 2 conexões
    expect(await h.row(rapido.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'fired' });
    expect(await h.importarDireto(rede.id, 57)).toBe('done');

    const [a, b] = [objeto(rapido), objeto(rede)];
    expect(a.nome).toBe(`AR/${rapido.id}/transcricao-${a.sha}.txt`);
    expect(b.nome).toBe(`AR/${rede.id}/transcricao-${b.sha}.txt`);
    expect(a.sha).toBe(b.sha); // o conteúdo gravado é o mesmo, byte a byte
    const norm = (d: { label: string; originalFilename: string }, code: string) => ({ label: d.label, nome: d.originalFilename.replace(code, 'COD') });
    expect(h.docs).toHaveLength(2);
    expect(norm(h.docs[0], rapido.code)).toEqual(norm(h.docs[1], rede.code));
    expect(h.vertex.received[0]).toBe(h.vertex.received[1]);
    expect(h.vertex.inputs[0].fecha).toBe(h.vertex.inputs[1].fecha);
    const forma = async (id: string) => (await h.admin.query(
      `SELECT kind, outcome, ref - 'documentId' - 'sha256' - 'bytes' - 'object' - 'generation' AS ref FROM admission_events
        WHERE appointment_id = $1 AND kind IN ('import_matched','transcript_vaulted','summary_saved') ORDER BY kind`, [id])).rows;
    const [fa, fb] = [await forma(rapido.id), await forma(rede.id)];
    expect(fa.map((e) => e.kind)).toEqual(['import_matched', 'summary_saved', 'transcript_vaulted']);
    expect(JSON.stringify(fa)).toBe(JSON.stringify(fb).replace(new RegExp(rede.code, 'g'), rapido.code)); // só o código da reunião difere
  });

  it('o teto de 3 tentativas soma rápido + rede: 1 falha no rápido + 2 na rede → bloqueada, nenhuma 4ª chamada ao Vertex', async () => {
    const r = await fechada();
    h.blocos(r, 3);
    h.vertex.failWith = new AdmissionSummaryError('vertex_failed');
    for (const min of [33, 34]) await h.vivo(min);
    expect(h.chamadas().vertex).toBe(1); // a falha do rápido (o gatilho cumpriu o papel: `fired`; o resto é da rede)
    expect(await h.row(r.id)).toMatchObject({ import_status: 'pending', summary_fast_state: 'fired' });
    for (const min of [41, 42]) await h.vivo(min);
    expect(h.chamadas().vertex).toBe(1); // o job de 1 min não repete
    expect(await h.importarDireto(r.id, 41)).toBe('summary_failed');
    expect(await h.importarDireto(r.id, 56)).toBe('summary_failed');
    expect(h.chamadas().vertex).toBe(3);
    expect(await h.importarDireto(r.id, 71)).toBe('blocked');
    expect(h.chamadas().vertex).toBe(3); // nenhuma 4ª
    expect(await h.row(r.id)).toMatchObject({ import_status: 'blocked' });
    // controle: o teto é do conjunto — uma reunião sem falha prévia chama o Vertex normalmente
    h.vertex.failWith = null;
    const limpa = await fechada();
    h.blocos(limpa, 3);
    expect(await h.importarDireto(limpa.id, 41)).toBe('done');
    expect(h.chamadas().vertex).toBe(4);
  });

  it('paciente de teste SEM liberação → 0 chamadas (nem Meet, nem Tactiq, nem cofre, nem Vertex); a mesma reunião de paciente real faz ≥ 1 de cada (controle)', async () => {
    const teste = await h.fx.criarPaciente({ isTest: true });
    const t = await fechada({ pacienteId: teste });
    h.blocos(t, 3);
    for (const min of [31, 33, 34, 35]) await h.vivo(min);
    expect(await h.importarDireto(t.id, 36, createFastGate({ previousCount: 3, conferenceOpen: false }))).toBe('skipped_test');
    expect(h.chamadas()).toEqual({ meet: 0, tactiq: 0, vertex: 0 });
    expect([h.vault.putCalls.length, h.rehearsal.putCalls.length]).toEqual([0, 0]);

    const real = await fechada();
    h.blocos(real, 3);
    for (const min of [31, 33, 34]) await h.vivo(min);
    const c = h.chamadas();
    expect([c.meet >= 1, c.tactiq >= 1, c.vertex >= 1]).toEqual([true, true, true]);
  });

  it('ensaio LIBERADO → a transcrição vai ao bucket de ensaio, nunca ao cofre; sem liberação o cofre também não recebe nada', async () => {
    const teste = await h.fx.criarPaciente({ isTest: true });
    const e = await fechada({ pacienteId: teste });
    h.blocos(e, 3);
    await h.admin.query(
      `INSERT INTO admission_events (appointment_id, kind, outcome, ref) VALUES ($1, 'paid_rehearsal_released', 'released', $2::jsonb)`,
      [e.id, JSON.stringify({ actorUid: 'e2e-050-f28', expiresAt: h.at(600).toISOString() })],
    );
    for (const min of [33, 34]) await h.vivo(min);
    expect(await h.row(e.id)).toMatchObject({ import_status: 'done', summary_fast_state: 'fired' });
    expect([h.rehearsal.putCalls.filter((o) => o.includes(e.id)).length, h.vault.putCalls.length]).toEqual([1, 0]);
    expect(h.chamadas().vertex).toBe(1);
  });
});
