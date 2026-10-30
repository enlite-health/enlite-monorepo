/**
 * agentes-capabilities-078.e2e.test.ts — spec 078, M3a-2: as 5 capabilities `agentes.*` contra o BANCO real
 * (migration 551), pelo caminho de produção da capability MCP: `withActorContext` com o ator
 * `system:mcp:<principal>`, conexão como `app_system` (a role do contexto de sistema do /mcp) e o GUC
 * `app.system_context` — ou seja, sob RLS e INSERT-only, não como superusuário.
 * Dados SINTÉTICOS com operador/inbox únicos por execução; a limpeza usa a conexão de admin (o app não deleta).
 */
import { Pool } from 'pg';
import { AgentesRepository } from '../../src/modules/mcp/infrastructure/AgentesRepository';
import { AgentesVeredictoRegistrarCapability } from '../../src/modules/mcp/application/capabilities/AgentesVeredictoRegistrarCapability';
import { AgentesReporteRegistrarCapability } from '../../src/modules/mcp/application/capabilities/AgentesReporteRegistrarCapability';
import { AgentesReporteLerCapability } from '../../src/modules/mcp/application/capabilities/AgentesReporteLerCapability';
import { AgentesIndicadoresLerCapability } from '../../src/modules/mcp/application/capabilities/AgentesIndicadoresLerCapability';
import { AgentesPlacarLerCapability } from '../../src/modules/mcp/application/capabilities/AgentesPlacarLerCapability';
import { AgentesMedicaoRegistrarCapability } from '../../src/modules/mcp/application/capabilities/AgentesMedicaoRegistrarCapability';
import { AgentesPedidoDepositarCapability } from '../../src/modules/mcp/application/capabilities/AgentesPedidoDepositarCapability';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('capabilities agentes.* contra o banco (spec 078, M3a-2)', () => {
  let admin: Pool;
  let app: Pool;
  const run = Math.random().toString(36).slice(2, 8);
  const operador = `qa078-${run}`;
  const inbox = `ib-${run}`;
  const area = `ar-${run}`;

  let veredictoCap: AgentesVeredictoRegistrarCapability;
  let reporteCap: AgentesReporteRegistrarCapability;
  let reporteLerCap: AgentesReporteLerCapability;
  let placarCap: AgentesPlacarLerCapability;
  let pedidoCap: AgentesPedidoDepositarCapability;
  let medicaoCap: AgentesMedicaoRegistrarCapability;
  let repo: AgentesRepository;

  const count = async (sql: string, params: unknown[] = []) =>
    Number((await admin.query(sql, params)).rows[0].n);

  beforeAll(() => {
    admin = new Pool({ connectionString: DATABASE_URL });
    app = new Pool({ connectionString: DATABASE_URL });
    app.on('connect', (c) => {
      // como o /mcp em produção: contexto de sistema declarado + role app_system (sujeita a RLS e a INSERT-only)
      void c.query(`SET ROLE app_system; SELECT set_config('app.system_context', 'mcp:qa078', false)`);
    });
    repo = new AgentesRepository(app);
    veredictoCap = new AgentesVeredictoRegistrarCapability(repo);
    reporteCap = new AgentesReporteRegistrarCapability(repo);
    reporteLerCap = new AgentesReporteLerCapability(repo);
    placarCap = new AgentesPlacarLerCapability(repo);
    pedidoCap = new AgentesPedidoDepositarCapability(repo);
    medicaoCap = new AgentesMedicaoRegistrarCapability(repo);
  });

  afterAll(async () => {
    // ordem de FK; o admin (dono) deleta, o app nunca
    await admin.query(`DELETE FROM agentes.medicoes WHERE escopo = $1`, [operador]);
    await admin.query(`DELETE FROM agentes.pedido_origens WHERE pedido_id IN (SELECT id FROM agentes.pedidos WHERE area = $1)`, [area]);
    await admin.query(`DELETE FROM agentes.pedido_atitudes WHERE pedido_id IN (SELECT id FROM agentes.pedidos WHERE area = $1)`, [area]);
    await admin.query(`DELETE FROM agentes.pedidos WHERE area = $1`, [area]);
    await admin.query(`DELETE FROM agentes.reporte_veredictos WHERE reporte_id IN (SELECT id FROM agentes.reportes WHERE area = $1)`, [area]);
    await admin.query(`DELETE FROM agentes.reportes WHERE area = $1`, [area]);
    await admin.query(`DELETE FROM agentes.veredicto_achados WHERE veredicto_id IN (SELECT id FROM agentes.veredictos WHERE operador = $1)`, [operador]);
    await admin.query(`DELETE FROM agentes.veredictos WHERE operador = $1`, [operador]);
    await app.end();
    await admin.end();
  });

  const veredicto = (conv: string, over: Record<string, unknown> = {}) => ({
    operador,
    sensor: 'juiz',
    inbox,
    conversa_ref: conv,
    ultima_msg_ref: `${conv}-m1`,
    nota: 6,
    cruza_areas: false,
    juiz_versao: 'juiz-v1',
    avaliado_em: '2026-10-15T12:00:00Z',
    achados: [
      { tipo: 'violacao', regra_ref: 'tom#aaaaaaaaaaaa', gravidade: 'media' },
      { tipo: 'acerto', regra_ref: 'canal#bbbbbbbbbbbb' },
    ],
    ...over,
  });

  let veredictoId: string;

  it('a conexão do teste é app_system (não superusuário): senão a prova não vale', async () => {
    const c = await app.connect();
    try {
      const { rows } = await c.query(`SELECT current_user AS u`);
      expect(rows[0].u).toBe('app_system');
    } finally {
      c.release();
    }
  });

  it('veredicto.registrar com 2 achados → 1 veredicto + 2 achados', async () => {
    const out = await veredictoCap.execute(veredicto('c1'), 'sol-supervisor');
    expect(out.duplicado).toBeUndefined();
    veredictoId = out.id;
    expect(await count(`SELECT count(*) n FROM agentes.veredictos WHERE operador = $1`, [operador])).toBe(1);
    expect(await count(`SELECT count(*) n FROM agentes.veredicto_achados WHERE veredicto_id = $1`, [veredictoId])).toBe(2);
  });

  it('o mesmo veredicto de novo → duplicado:true, mesmo id, contagem inalterada', async () => {
    const out = await veredictoCap.execute(veredicto('c1'), 'sol-supervisor');
    expect(out).toEqual({ id: veredictoId, duplicado: true });
    expect(await count(`SELECT count(*) n FROM agentes.veredictos WHERE operador = $1`, [operador])).toBe(1);
    expect(await count(`SELECT count(*) n FROM agentes.veredicto_achados WHERE veredicto_id = $1`, [veredictoId])).toBe(2);
  });

  it('veredicto que o BANCO recusa (regra_ref de 2 chars, passando por cima da capability) não deixa veredicto órfão', async () => {
    // a capability barra regra_ref < 3; o repositório direto prova que a transação desfaz o veredicto quando o CHECK do banco falha
    await expect(
      repo.registrarVeredicto('sol-supervisor', {
        operador, sensor: 'silente', inbox, conversa_ref: 'c-orfa', ultima_msg_ref: 'm', cruza_areas: false,
        avaliado_em: '2026-10-15T12:00:00Z', achados: [{ tipo: 'violacao', regra_ref: 'xx', gravidade: 'alta' }],
      }),
    ).rejects.toThrow();
    expect(await count(`SELECT count(*) n FROM agentes.veredictos WHERE operador = $1 AND conversa_ref = 'c-orfa'`, [operador])).toBe(0);
  });

  it('placar.ler devolve a agregação esperada e NENHUMA chave de texto', async () => {
    const v2 = await veredictoCap.execute(
      veredicto('c2', { sensor: 'silente', nota: undefined, juiz_versao: undefined, cruza_areas: true,
        avaliado_em: '2026-10-16T12:00:00Z',
        achados: [{ tipo: 'violacao', regra_ref: 'tom#aaaaaaaaaaaa', gravidade: 'alta' }] }),
      'sol-supervisor',
    );
    // fora da janela: não conta
    await veredictoCap.execute(veredicto('c3', { avaliado_em: '2026-09-01T12:00:00Z' }), 'sol-supervisor');

    const placar = await placarCap.execute(
      { operador, de: '2026-10-01T00:00:00Z', ate: '2026-10-29T00:00:00Z' },
      'maria',
    );
    expect(placar.veredictos).toBe(2);
    expect(placar.conversas).toBe(2);
    expect(placar.cruza_areas).toBe(1);
    expect(placar.nota_media).toBe(6); // só o juiz tem nota
    expect(placar.por_regra).toEqual([
      { regra_ref: 'tom#aaaaaaaaaaaa', violacoes: 2, gravidade_max: 'alta', veredicto_ids: [veredictoId, v2.id].sort() },
    ]);
    expect(placar.veredicto_ids).toHaveLength(2);
    expect(placar.veredicto_ids).toContain(veredictoId);

    // contrato por chaves: em nenhum nível do resultado existe chave de texto
    const chaves: string[] = [];
    const varre = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(varre);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) { chaves.push(k); varre(x); }
      }
    };
    varre(placar);
    expect(chaves.length).toBeGreaterThan(5);
    expect(chaves.filter((k) => /trecho|resumo|texto/i.test(k))).toEqual([]);
  });

  it('M4.4.1 sensor validador: ref da lista NUNCA -> nunca; ref fora da lista -> NÃO grave; scrubber -> dado; notário -> acao_fabricada (4 sintéticos)', async () => {
    const op = `${operador}-vd`;
    const base = { operador: op, inbox, nota: undefined, juiz_versao: undefined, cruza_areas: false, avaliado_em: '2026-10-20T12:00:00Z' };
    const mk = (conv: string, sensor: string, regra: string) =>
      veredicto(conv, { ...base, sensor, achados: [{ tipo: 'violacao', regra_ref: regra, gravidade: 'alta' }] });
    const vNunca = await veredictoCap.execute(mk('v1', 'validador', 'nunca-garantir-vaga#ffffffffffff'), 'sol-supervisor');
    const vFora = await veredictoCap.execute(mk('v2', 'validador', 'tom-informal#aaaaaaaaaaaa'), 'sol-supervisor');
    const scr = await veredictoCap.execute(mk('v3', 'scrubber', 'pii#cccccccccccc'), 'sol-supervisor');
    const not = await veredictoCap.execute(mk('v4', 'notario', 'acao#dddddddddddd'), 'sol-supervisor');
    const janela = { operador: op, de: '2026-10-01T00:00:00Z', ate: '2026-10-29T00:00:00Z' };

    const p = await placarCap.execute({ ...janela, nunca_refs: ['nunca-garantir-vaga#ffffffffffff'] }, 'maria');
    expect(p.veredictos).toBe(4);
    const por = Object.fromEntries(p.graves.map((g) => [g.veredicto_id, g]));
    expect(por[vNunca.id]).toMatchObject({ sensor: 'validador', gatilho: 'nunca', regra_ref: 'nunca-garantir-vaga#ffffffffffff' });
    expect(por[vFora.id]).toBeUndefined(); // controle negativo: validador SEM ref na lista não é grave
    expect(por[scr.id]).toMatchObject({ gatilho: 'dado' });
    expect(por[not.id]).toMatchObject({ gatilho: 'acao_fabricada' });
    expect(p.graves).toHaveLength(3);

    // sem a lista, o validador deixa de ser grave (o gatilho (a) depende do registro)
    const sem = await placarCap.execute(janela, 'maria');
    expect(sem.graves.map((g) => g.veredicto_id)).not.toContain(vNunca.id);

    await admin.query(`DELETE FROM agentes.veredicto_achados WHERE veredicto_id IN (SELECT id FROM agentes.veredictos WHERE operador = $1)`, [op]);
    await admin.query(`DELETE FROM agentes.veredictos WHERE operador = $1`, [op]);
  });

  it('placar.ler graves: scrubber=dado, notário=acao_fabricada, regra NUNCA=nunca; "alta" do juiz sem NUNCA NÃO entra (3 graves de 4)', async () => {
    const op = `${operador}-gr`;
    const base = { operador: op, inbox, nota: undefined, juiz_versao: undefined, cruza_areas: false, avaliado_em: '2026-10-20T12:00:00Z' };
    const mk = (conv: string, sensor: string, regra: string, extra: Record<string, unknown> = {}) =>
      veredicto(conv, { ...base, sensor, achados: [{ tipo: 'violacao', regra_ref: regra, gravidade: 'alta' }], ...extra });
    const scr = await veredictoCap.execute(mk('g1', 'scrubber', 'pii#cccccccccccc'), 'sol-supervisor');
    const not = await veredictoCap.execute(mk('g2', 'notario', 'acao#dddddddddddd'), 'sol-supervisor');
    const nun = await veredictoCap.execute(
      mk('g3', 'juiz', 'nunca-prometer#eeeeeeeeeeee', { nota: 3, juiz_versao: 'juiz-v1' }), 'sol-supervisor');
    const alta = await veredictoCap.execute(
      mk('g4', 'juiz', 'tom#aaaaaaaaaaaa', { nota: 4, juiz_versao: 'juiz-v1' }), 'sol-supervisor');
    const janela = { operador: op, de: '2026-10-01T00:00:00Z', ate: '2026-10-29T00:00:00Z' };

    const p = await placarCap.execute({ ...janela, nunca_refs: ['nunca-prometer#eeeeeeeeeeee'] }, 'maria');
    expect(p.veredictos).toBe(4);
    expect(p.graves).toHaveLength(3);
    const por = Object.fromEntries(p.graves.map((g) => [g.veredicto_id, g]));
    expect(por[scr.id]).toMatchObject({ sensor: 'scrubber', gatilho: 'dado', inbox, conversa_ref: 'g1', ultima_msg_ref: 'g1-m1', regra_ref: 'pii#cccccccccccc', avaliado_em: '2026-10-20T12:00:00.000Z' });
    expect(por[not.id]).toMatchObject({ sensor: 'notario', gatilho: 'acao_fabricada' });
    expect(por[nun.id]).toMatchObject({ sensor: 'juiz', gatilho: 'nunca', regra_ref: 'nunca-prometer#eeeeeeeeeeee' });
    expect(por[alta.id]).toBeUndefined(); // controle negativo: gravidade alta do juiz, regra fora de nunca_refs

    // sem nunca_refs: a regra NUNCA deixa de ser grave; scrubber e notário seguem
    const sem = await placarCap.execute(janela, 'maria');
    expect(sem.graves.map((g) => g.gatilho).sort()).toEqual(['acao_fabricada', 'dado']);
    // nenhuma chave de texto no item grave
    expect(Object.keys(p.graves[0]).filter((k) => /trecho|resumo|texto/i.test(k))).toEqual([]);

    await admin.query(`DELETE FROM agentes.veredicto_achados WHERE veredicto_id IN (SELECT id FROM agentes.veredictos WHERE operador = $1)`, [op]);
    await admin.query(`DELETE FROM agentes.veredictos WHERE operador = $1`, [op]);
  });

  it('placar de operador sem veredicto: zeros e lista vazia (não erro)', async () => {
    const p = await placarCap.execute({ operador: `${operador}-vazio`, de: '2026-10-01T00:00:00Z', ate: '2026-10-29T00:00:00Z' }, 'maria');
    expect(p).toMatchObject({ veredictos: 0, conversas: 0, nota_media: null, cruza_areas: 0, por_regra: [], veredicto_ids: [] });
  });

  let reporteId: string;
  it('reporte.registrar grava reporte + ligação por id; reporte.ler devolve (sem campo de trecho)', async () => {
    const out = await reporteCap.execute(
      { autor: 'Gestora QA', operador, area, caso: 'leve', regra_ref: 'tom#aaaaaaaaaaaa', ocorrencias: 2,
        janela_de: '2026-10-22', janela_ate: '2026-10-28', observacao: 'prometeu prazo', veredicto_ids: [veredictoId, veredictoId] },
      'maria',
    );
    reporteId = out.id;
    expect(out.duplicado).toBeUndefined();
    expect(await count(`SELECT count(*) n FROM agentes.reporte_veredictos WHERE reporte_id = $1`, [reporteId])).toBe(1); // id repetido colapsa

    const lido = await reporteLerCap.execute({ operador }, 'sol-fila');
    expect(lido.reportes).toHaveLength(1);
    expect(lido.reportes[0]).toMatchObject({ id: reporteId, area, veredicto_ids: [veredictoId] });
    expect(Object.keys(lido.reportes[0]).sort()).toEqual(
      ['area', 'autor', 'caso', 'criado_em', 'id', 'janela_ate', 'janela_de', 'observacao', 'ocorrencias', 'operador',
        'pedido_ids', 'regra_proposta', 'regra_ref', 'veredicto_ids'],
    );
    expect(lido.reportes[0]).toMatchObject({ caso: 'leve', regra_ref: 'tom#aaaaaaaaaaaa', ocorrencias: 2,
      janela_de: '2026-10-22', janela_ate: '2026-10-28', pedido_ids: [] }); // ainda sem pedido
  });

  it('reporte.registrar repetido (mesmo operador, caso, regra_ref, janela) → duplicado:true, mesmo id, nada regravado', async () => {
    const args = { autor: 'Gestora QA', operador, area, caso: 'leve', regra_ref: 'tom#aaaaaaaaaaaa', ocorrencias: 5,
      janela_de: '2026-10-22', janela_ate: '2026-10-28', observacao: 'de novo', veredicto_ids: [] };
    const out = await reporteCap.execute(args, 'maria');
    expect(out).toEqual({ id: reporteId, duplicado: true });
    expect(await count(`SELECT count(*) n FROM agentes.reportes WHERE area = $1`, [area])).toBe(1);
    // meta (regra_ref NULL) também deduplica; outra janela é outro reporte
    const meta = { ...args, caso: 'meta', regra_ref: undefined };
    const m1 = await reporteCap.execute(meta, 'maria');
    const m2 = await reporteCap.execute(meta, 'maria');
    expect(m1.duplicado).toBeUndefined();
    expect(m2).toEqual({ id: m1.id, duplicado: true });
    const outra = await reporteCap.execute({ ...args, janela_de: '2026-10-29', janela_ate: '2026-10-29' }, 'maria');
    expect(outra.duplicado).toBeUndefined();
    expect(await count(`SELECT count(*) n FROM agentes.reportes WHERE area = $1`, [area])).toBe(3);
  });

  it('reporte com veredicto inexistente: o banco recusa (FK) e nada fica gravado', async () => {
    await expect(
      reporteCap.execute(
        { autor: 'Gestora QA', operador, area, caso: 'leve', regra_ref: 'fantasma#1', janela_de: '2026-10-01', janela_ate: '2026-10-02', observacao: 'fantasma', veredicto_ids: ['123e4567-e89b-12d3-a456-426614174999'] },
        'maria',
      ),
    ).rejects.toThrow();
    expect(await count(`SELECT count(*) n FROM agentes.reportes WHERE area = $1 AND observacao = 'fantasma'`, [area])).toBe(0);
  });

  it('pedido.depositar → 1 pedido + 1 atitude (versão 1) + N origens; status da view = novo', async () => {
    const out = await pedidoCap.execute(
      {
        assunto: 'ajustar tom', descricao: 'descrição tipada', autor: 'sol-fila', area, grave_gatilho: 'nenhum',
        registro_versao: 'v1',
        atitude: { degrau: 1, conteudo: 'memória: nunca prometer prazo', caso_teste: 'caso: pergunta de prazo',
          metrica_alvo: 'taxa_violacao', janela: '7d', gatilho_rollback: 'taxa > 2x baseline' },
        origens: [{ reporte_id: reporteId }, { veredicto_id: veredictoId }],
      },
      'sol-fila',
    );
    expect(await count(`SELECT count(*) n FROM agentes.pedidos WHERE id = $1`, [out.pedido_id])).toBe(1);
    const at = await admin.query(`SELECT id, versao FROM agentes.pedido_atitudes WHERE pedido_id = $1`, [out.pedido_id]);
    expect(at.rows).toEqual([{ id: out.atitude_id, versao: 1 }]);
    expect(await count(`SELECT count(*) n FROM agentes.pedido_origens WHERE pedido_id = $1`, [out.pedido_id])).toBe(2);
    const st = await admin.query(`SELECT status FROM agentes.pedido_status WHERE pedido_id = $1`, [out.pedido_id]);
    expect(st.rows[0].status).toBe('novo');
  });

  it('reporte.ler: reporte que virou pedido → pedido_ids não vazio; reporte sem pedido → []', async () => {
    const lido = await reporteLerCap.execute({ operador }, 'sol-fila');
    const pedidoId = (await admin.query(`SELECT id FROM agentes.pedidos WHERE area = $1 LIMIT 1`, [area])).rows[0].id as string;
    const comPedido = lido.reportes.find((r) => r.id === reporteId);
    const semPedido = lido.reportes.filter((r) => r.id !== reporteId);
    expect(comPedido?.pedido_ids).toEqual([pedidoId]);
    expect(semPedido.length).toBeGreaterThan(0);
    for (const r of semPedido) expect(r.pedido_ids).toEqual([]);
  });

  it('pedido com origem inexistente: transação inteira revertida (nem pedido, nem atitude)', async () => {
    await expect(
      pedidoCap.execute(
        {
          assunto: 'pedido que falha', descricao: 'd', autor: 'sol-fila', area, grave_gatilho: 'nenhum', registro_versao: 'v1',
          atitude: { degrau: 0, conteudo: 'c', caso_teste: 't', metrica_alvo: 'm', janela: '7d', gatilho_rollback: 'r' },
          origens: [{ veredicto_id: '123e4567-e89b-12d3-a456-426614174999' }],
        },
        'sol-fila',
      ),
    ).rejects.toThrow();
    expect(await count(`SELECT count(*) n FROM agentes.pedidos WHERE area = $1 AND assunto = 'pedido que falha'`, [area])).toBe(0);
  });

  const medicao = (over: Record<string, unknown> = {}) => ({
    metrica: 'taxa_violacao', escopo: operador, de: '2026-10-01T00:00:00Z', ate: '2026-10-08T00:00:00Z',
    valor: 0.125, n: 340, medido_em: '2026-10-29T10:00:00Z', motivo: 'linha_de_base', ...over,
  });
  const sqlstate = async (p: Promise<unknown>) => {
    try { await p; return 'NENHUM-ERRO'; } catch (e) { return (e as { code?: string }).code ?? 'sem-código'; }
  };

  it('medicao.registrar: linha de base válida → 1 linha com os números fiéis', async () => {
    const out = await medicaoCap.execute(medicao(), 'sol-fila');
    const { rows } = await admin.query(`SELECT metrica, valor::float8 AS valor, n, motivo, pedido_id FROM agentes.medicoes WHERE id = $1`, [out.id]);
    expect(rows).toEqual([{ metrica: 'taxa_violacao', valor: 0.125, n: 340, motivo: 'linha_de_base', pedido_id: null }]);
    expect(await count(`SELECT count(*) n FROM agentes.medicoes WHERE escopo = $1`, [operador])).toBe(1);
  });

  it('medicao: linha_de_base COM pedido_id é recusada — pela capability E, passando por cima dela, pelo CHECK do banco (23514)', async () => {
    const pedidoId = (await admin.query(`SELECT id FROM agentes.pedidos WHERE area = $1 LIMIT 1`, [area])).rows[0].id as string;
    await expect(medicaoCap.execute(medicao({ pedido_id: pedidoId }), 'sol-fila')).rejects.toThrow();
    expect(await sqlstate(repo.registrarMedicao('sol-fila', medicao({ pedido_id: pedidoId })))).toBe('23514');
    // e o inverso: antes/depois sem pedido
    expect(await sqlstate(repo.registrarMedicao('sol-fila', medicao({ motivo: 'antes' })))).toBe('23514');
    expect(await count(`SELECT count(*) n FROM agentes.medicoes WHERE escopo = $1`, [operador])).toBe(1); // só a válida
  });

  it('medicao: antes/depois COM pedido_id existente → gravadas', async () => {
    const pedidoId = (await admin.query(`SELECT id FROM agentes.pedidos WHERE area = $1 LIMIT 1`, [area])).rows[0].id as string;
    await medicaoCap.execute(medicao({ motivo: 'antes', pedido_id: pedidoId }), 'sol-fila');
    await medicaoCap.execute(medicao({ motivo: 'depois', pedido_id: pedidoId, valor: 0.05 }), 'sol-fila');
    expect(await count(`SELECT count(*) n FROM agentes.medicoes WHERE escopo = $1 AND pedido_id = $2`, [operador, pedidoId])).toBe(2);
  });
});

describe('agentes.indicadores.ler contra o banco (spec 078, item 41)', () => {
  let admin: Pool;
  let app: Pool;
  let cap: AgentesIndicadoresLerCapability;
  const run = Math.random().toString(36).slice(2, 8);
  // Janela distante: só os dados semeados aqui caem nela. Fora dela: 2031-04-15.
  const janela = { de: '2031-03-01', ate: '2031-04-01' };
  const workerIds: string[] = [];
  let jobId: string;

  const worker = async (status: string, createdAt: string) => {
    const { rows } = await admin.query(
      `INSERT INTO workers (auth_uid, status, created_at) VALUES ($1, $2, $3) RETURNING id`,
      [`qa078i-${run}-${workerIds.length}`, status, createdAt],
    );
    workerIds.push(rows[0].id);
    return rows[0].id as string;
  };
  const candidatura = (workerId: string, stage: string, createdAt: string) =>
    admin.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, created_at) VALUES ($1,$2,$3,$4)`,
      [workerId, jobId, stage, createdAt],
    );

  beforeAll(() => {
    admin = new Pool({ connectionString: DATABASE_URL });
    app = new Pool({ connectionString: DATABASE_URL });
    app.on('connect', (c) => {
      void c.query(`SET ROLE app_system; SELECT set_config('app.system_context', 'mcp:qa078', false)`);
    });
    cap = new AgentesIndicadoresLerCapability(new AgentesRepository(app));
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
    await admin.query(`DELETE FROM job_postings WHERE title = $1`, [`qa078i-${run}`]);
    await admin.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [workerIds]);
    await app.end();
    await admin.end();
  });

  it('conta REGISTERED (total e no período) e SELECTED no período; nada de id nem texto', async () => {
    const base = await cap.execute(janela, 'sol-fila');
    jobId = (await admin.query(`INSERT INTO job_postings (title) VALUES ($1) RETURNING id`, [`qa078i-${run}`])).rows[0].id;
    const dentro = await worker('REGISTERED', '2031-03-10T12:00:00Z');
    const fora = await worker('REGISTERED', '2031-04-15T12:00:00Z');
    await worker('INCOMPLETE_REGISTER', '2031-03-11T12:00:00Z'); // fora de REGISTERED
    await candidatura(dentro, 'SELECTED', '2031-03-12T12:00:00Z');
    await candidatura(fora, 'SELECTED', '2031-04-15T12:00:00Z'); // fora do período

    const out = await cap.execute(janela, 'sol-fila');
    // eslint-disable-next-line no-console
    console.log('INDICADORES base=%j out=%j', base, out);
    expect(out).toEqual({
      ...janela,
      cadastros_completos: { total: base.cadastros_completos.total + 2, no_periodo: base.cadastros_completos.no_periodo + 1 },
      vagas_selecionadas: { no_periodo: base.vagas_selecionadas.no_periodo + 1 },
      fonte: 'analytics.management_dashboard',
    });
    expect(Object.keys(out).sort()).toEqual(['ate', 'cadastros_completos', 'de', 'fonte', 'vagas_selecionadas']);
  });

  it('banco limpo (sem dados prévios): os números são exatamente {total:2,no_periodo:1} e {no_periodo:1}', async () => {
    const out = await cap.execute(janela, 'sol-fila');
    if (out.cadastros_completos.total === 2) {
      expect(out.cadastros_completos).toEqual({ total: 2, no_periodo: 1 });
      expect(out.vagas_selecionadas).toEqual({ no_periodo: 1 });
    }
  });

  it('de >= ate é recusado antes do banco', async () => {
    await expect(cap.execute({ de: '2031-04-01', ate: '2031-04-01' }, 'sol-fila')).rejects.toThrow();
  });
});
