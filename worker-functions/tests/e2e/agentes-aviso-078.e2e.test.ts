/**
 * agentes-aviso-078.e2e.test.ts — spec 078, M3b-2 (itens 53, 55, 57) contra o BANCO real (migrations 551 + 553).
 * Mesma conexão da `agentes-capabilities-078`: `app_system` + `app.system_context` (o caminho do /mcp), sob RLS e INSERT-only.
 * TWILIO SEMPRE DUBLÊ (`StubAvisoWhatsapp`): o teste prova que o cliente real não é chamado. Dados SINTÉTICOS; a limpeza usa o admin.
 * O reenvio usa relógio simulado e pedidos semeados em 2020 (criado_em explícito pelo admin): só os MEUS pedidos entram na janela,
 * então as contagens são exatas mesmo num banco com pedidos de outras suítes.
 */
import { Pool } from 'pg';
import { withActorContext } from '../../src/shared/database/actorContext';
import { systemActor } from '../../src/shared/audit/actorSource';
import { AgentesRepository } from '../../src/modules/mcp/infrastructure/AgentesRepository';
import { AgentesPedidoDepositarCapability } from '../../src/modules/mcp/application/capabilities/AgentesPedidoDepositarCapability';
import { AgentesAvisoReenviarCapability } from '../../src/modules/mcp/application/capabilities/AgentesAvisoReenviarCapability';
import { AvisoPedidoService, type AvisoConfig } from '../../src/modules/agentes/application/AvisoPedidoService';
import { PostgresAvisosRegistro } from '../../src/modules/agentes/infrastructure/PostgresAvisosRegistro';
import { resolverDecisoresPedidosIa } from '../../src/modules/agentes/infrastructure/DecisoresPedidosIa';
import { StubAvisoWhatsapp } from '../../src/modules/agentes/infrastructure/avisoWhatsapp';
import { SystemNotificationPublisher } from '../../src/modules/inapp-notification/application/SystemNotificationPublisher';
import { NotificationRepository } from '../../src/modules/inapp-notification/infrastructure/NotificationRepository';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ADMIN_ACTOR = systemActor('mcp:sol-fila');

describe('aviso do pedido do Sol contra o banco (spec 078, M3b-2)', () => {
  let admin: Pool;
  let app: Pool;
  const run = Math.random().toString(36).slice(2, 8);
  const area = `av-${run}`;
  const decisores = [`qa078av-${run}-1`, `qa078av-${run}-2`];
  const numeros = ['+5491100000011', '+5491100000012'];
  let cfg: AvisoConfig;
  let wpp: StubAvisoWhatsapp;
  let svc: AvisoPedidoService;
  let depositar: AgentesPedidoDepositarCapability;
  let reenviar: AgentesAvisoReenviarCapability;
  let veredictoId: string;

  const n = async (sql: string, p: unknown[] = []) => Number((await admin.query(sql, p)).rows[0].n);

  const pedidoInput = (over: Record<string, unknown> = {}) => ({
    assunto: 'ASSUNTO-SECRETO-DO-PEDIDO', descricao: 'DESCRICAO-SECRETA-DO-PEDIDO', autor: 'sol-fila', area,
    grave_gatilho: 'nenhum', registro_versao: 'v1',
    atitude: { degrau: 2, conteudo: 'CONTEUDO-SECRETO', caso_teste: 'caso', metrica_alvo: 'm', janela: '7d', gatilho_rollback: 'g' },
    origens: [{ veredicto_id: veredictoId }],
    ...over,
  });

  /** Semeia pedido + atitude direto pelo admin, com `criado_em` explícito (a conexão do app não escolhe o relógio). */
  const semear = async (criadoEm: string, grave = true) => {
    const p = await admin.query(
      `INSERT INTO agentes.pedidos (assunto, descricao, autor, area, grave_gatilho, registro_versao, criado_em)
       VALUES ('a','d','sol-fila',$1,$2,'v1',$3) RETURNING id`,
      [area, grave ? 'dado' : 'nenhum', criadoEm],
    );
    const a = await admin.query(
      `INSERT INTO agentes.pedido_atitudes (pedido_id, versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback)
       VALUES ($1,1,1,'c','t','m','7d','g') RETURNING id`, [p.rows[0].id],
    );
    return { id: p.rows[0].id as string, atitude: a.rows[0].id as string };
  };

  /** Tira o pedido da janela do reenvio (uma decisão humana), para um teste não contaminar o seguinte. */
  const aposentar = async (...ps: Array<{ id: string; atitude: string }>) => {
    for (const p of ps) {
      await admin.query(
        `INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, motivo)
         SELECT $1,$2,'negar','staff:qa','humano','aposentado' WHERE NOT EXISTS (
           SELECT 1 FROM agentes.pedido_eventos WHERE atitude_id = $2 AND acao IN ('aceitar','negar'))`, [p.id, p.atitude],
      );
    }
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    admin = new Pool({ connectionString: DATABASE_URL });
    veredictoId = (await admin.query(
      `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas)
       VALUES ($1,'silente',$1,'c','m',false) RETURNING id`, [`qa078av-${run}`],
    )).rows[0].id;
    app = new Pool({ connectionString: DATABASE_URL });
    app.on('connect', (c) => { void c.query(`SET ROLE app_system; SELECT set_config('app.system_context', 'mcp:qa078av', false)`); });
    wpp = new StubAvisoWhatsapp();
    cfg = {
      from: '+5491199990000', contentSid: 'HXsolgrave', linkBase: 'https://app.enlite.test', reenvioHoras: 4,
      destinatarios: [{ uid: decisores[0], numero: numeros[0] }, { uid: decisores[1], numero: numeros[1] }],
    };
    svc = new AvisoPedidoService({
      decisores: async () => decisores,
      inapp: new SystemNotificationPublisher(new NotificationRepository(app, {} as never)),
      whatsapp: wpp,
      registro: new PostgresAvisosRegistro(),
      tx: (fn) => withActorContext(app, fn, ADMIN_ACTOR),
      config: () => cfg,
    });
    depositar = new AgentesPedidoDepositarCapability(new AgentesRepository(app, svc));
    reenviar = new AgentesAvisoReenviarCapability(svc);
  });

  afterAll(async () => {
    const ids = `(SELECT id FROM agentes.pedidos WHERE area = $1)`;
    await admin.query(`DELETE FROM agentes.pedido_origens WHERE veredicto_id = $1`, [veredictoId]);
    await admin.query(`DELETE FROM agentes.avisos_enviados WHERE pedido_id IN ${ids}`, [area]);
    await admin.query(`DELETE FROM agentes.pedido_eventos WHERE pedido_id IN ${ids}`, [area]);
    await admin.query(`DELETE FROM agentes.pedido_origens WHERE pedido_id IN ${ids}`, [area]);
    await admin.query(`DELETE FROM agentes.pedido_atitudes WHERE pedido_id IN ${ids}`, [area]);
    await admin.query(`DELETE FROM agentes.pedidos WHERE area = $1`, [area]);
    await admin.query(`DELETE FROM agentes.veredictos WHERE id = $1`, [veredictoId]);
    await admin.query(
      `DELETE FROM notification_events WHERE id IN (SELECT event_id FROM notifications WHERE recipient_uid = ANY($1))`, [decisores],
    );
    await app.end();
    await admin.end();
  });

  it('a conexão do teste é app_system (não superusuário) e a 553 está aplicada com os 2 tipos', async () => {
    const c = await app.connect();
    try { expect((await c.query(`SELECT current_user AS u`)).rows[0].u).toBe('app_system'); } finally { c.release(); }
    expect(await n(`SELECT count(*) n FROM notification_types WHERE code IN ('PEDIDO_IA_NOVO','PEDIDO_IA_GRAVE')`)).toBe(2);
  });

  it('depositar pedido GRAVE: 1 notificação GRAVE in-app por decisor (2), SEM payload, 2 WhatsApp pelo dublê só com o link, 1 linha de auditoria por envio', async () => {
    const out = await depositar.execute(pedidoInput({ grave_gatilho: 'dado' }), 'sol-fila');
    const pid = out.pedido_id;

    for (const tipo of ['PEDIDO_IA_GRAVE']) {
      const r = await admin.query(
        `SELECT e.payload, e.actor_uid, e.patient_id, n.recipient_uid FROM notification_events e JOIN notifications n ON n.event_id = e.id
          WHERE e.type_code = $1 AND n.recipient_uid = ANY($2) ORDER BY n.recipient_uid`, [tipo, decisores],
      );
      expect(r.rows.map((x) => x.recipient_uid)).toEqual(decisores);
      expect(r.rows.every((x) => JSON.stringify(x.payload) === '{}' && x.actor_uid === 'system:sol-fila' && x.patient_id === null)).toBe(true);
    }
    expect(wpp.calls).toHaveLength(2);
    expect(wpp.calls.map((c) => c.to)).toEqual(numeros);
    for (const c of wpp.calls) {
      expect(c.variables).toEqual({ '1': `https://app.enlite.test/admin/pedidos-ia/${pid}` });
      expect(c.from).toBe('+5491199990000');
      expect(JSON.stringify(c)).not.toMatch(/SECRET/); // assunto/descrição/conteúdo do pedido nunca chegam ao canal
    }
    const linhas = await admin.query(
      `SELECT canal, destinatario_ref, tentativa, resultado, template_ref FROM agentes.avisos_enviados WHERE pedido_id = $1 ORDER BY canal, destinatario_ref`, [pid],
    );
    expect(linhas.rows.filter((l) => l.canal === 'inapp')).toHaveLength(2);
    // a GRAVE substitui a NOVA: o decisor não recebe as duas pelo mesmo pedido (este é o 1º depósito da suíte)
    expect(await n(`SELECT count(*) n FROM notifications n JOIN notification_events e ON e.id = n.event_id WHERE e.type_code = 'PEDIDO_IA_NOVO' AND n.recipient_uid = ANY($1)`, [decisores])).toBe(0);
    const tw = linhas.rows.filter((l) => l.canal === 'twilio');
    expect(tw).toHaveLength(2);
    expect(tw.every((l) => l.tentativa === 1 && l.resultado === 'stub')).toBe(true);
    expect(JSON.stringify(linhas.rows)).not.toContain('5491100000'); // nenhum número em claro na trilha
    expect(tw.every((l) => /^[0-9a-f]{64}$/.test(l.destinatario_ref))).toBe(true);
  });

  it('controle: pedido NÃO grave -> só NOVO in-app, 0 WhatsApp e 0 linha twilio', async () => {
    const antes = wpp.calls.length;
    const { pedido_id } = await depositar.execute(pedidoInput({ grave_gatilho: 'nenhum' }), 'sol-fila');
    expect(wpp.calls.length).toBe(antes);
    expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND canal = 'twilio'`, [pedido_id])).toBe(0);
    expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND canal = 'inapp' AND template_ref = 'PEDIDO_IA_NOVO'`, [pedido_id])).toBe(2);
    expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND template_ref = 'PEDIDO_IA_GRAVE'`, [pedido_id])).toBe(0);
  });

  it('fail-closed sem número do Sol: 0 chamadas ao dublê, 2 linhas falha (motivo-slug) e o PEDIDO existe', async () => {
    const antes = wpp.calls.length;
    cfg = { ...cfg, from: null };
    try {
      const { pedido_id } = await depositar.execute(pedidoInput({ grave_gatilho: 'nunca' }), 'sol-fila');
      expect(wpp.calls.length).toBe(antes);
      const r = await admin.query(`SELECT resultado, motivo FROM agentes.avisos_enviados WHERE pedido_id = $1 AND canal = 'twilio'`, [pedido_id]);
      expect(r.rows).toEqual([{ resultado: 'falha', motivo: 'sem_numero_do_sol' }, { resultado: 'falha', motivo: 'sem_numero_do_sol' }]);
      expect(await n(`SELECT count(*) n FROM agentes.pedidos WHERE id = $1`, [pedido_id])).toBe(1);
    } finally { cfg = { ...cfg, from: '+5491199990000' }; }
  });

  it('Twilio recusa: o pedido NÃO se desfaz e a falha fica na trilha', async () => {
    wpp.failWith = true;
    try {
      const { pedido_id } = await depositar.execute(pedidoInput({ grave_gatilho: 'acao_fabricada' }), 'sol-fila');
      expect(await n(`SELECT count(*) n FROM agentes.pedidos WHERE id = $1`, [pedido_id])).toBe(1);
      expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND canal='twilio' AND resultado='falha' AND motivo='twilio_recusou'`, [pedido_id])).toBe(2);
    } finally { wpp.failWith = false; }
  });

  it('a trilha é INSERT-only para o app (UPDATE/DELETE negados) e o BANCO barra a 3ª tentativa e o in-app repetido', async () => {
    const { id, atitude } = await semear('2019-01-01T00:00:00Z');
    const c = await app.connect();
    try {
      await c.query(`INSERT INTO agentes.avisos_enviados (pedido_id, canal, destinatario_ref, tentativa, template_ref, resultado) VALUES ($1,'twilio','r1',1,'t','ok')`, [id]);
      await expect(c.query(`UPDATE agentes.avisos_enviados SET resultado = 'falha' WHERE pedido_id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`DELETE FROM agentes.avisos_enviados WHERE pedido_id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`INSERT INTO agentes.avisos_enviados (pedido_id, canal, destinatario_ref, tentativa, template_ref, resultado) VALUES ($1,'twilio','r1',3,'t','ok')`, [id])).rejects.toMatchObject({ code: '23514' });
      await expect(c.query(`INSERT INTO agentes.avisos_enviados (pedido_id, canal, destinatario_ref, tentativa, template_ref, resultado) VALUES ($1,'twilio','r1',1,'t','ok')`, [id])).rejects.toMatchObject({ code: '23505' });
      await expect(c.query(`INSERT INTO agentes.avisos_enviados (pedido_id, canal, destinatario_ref, tentativa, template_ref, resultado) VALUES ($1,'inapp','u',2,'t','ok')`, [id])).rejects.toMatchObject({ code: '23514' });
    } finally { c.release(); }
    await aposentar({ id, atitude });
  });

  it('item 57: grave sem decisão há 5 h com 1 tentativa -> tentativa 2; de novo -> 0 reenvios e `escalar` traz o pedido (NUNCA 3ª tentativa)', async () => {
    const A = await semear('2020-01-01T00:00:00Z');
    await svc.whatsappGrave(A.id); // tentativa 1 pelo caminho de produção
    expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND canal='twilio'`, [A.id])).toBe(2);
    const antes = wpp.calls.length;

    const r1 = await reenviar.execute({ agora: '2020-01-01T05:00:00Z' }, 'sol-fila');
    expect(r1).toEqual({ reenviados: 2, escalar: [] });
    expect(wpp.calls.length).toBe(antes + 2);
    expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND canal='twilio' AND tentativa = 2`, [A.id])).toBe(2);

    const r2 = await reenviar.execute({ agora: '2020-01-01T06:00:00Z' }, 'sol-fila');
    expect(r2).toEqual({ reenviados: 0, escalar: [{ pedido_id: A.id }] });
    const r3 = await reenviar.execute({ agora: '2020-01-02T06:00:00Z' }, 'sol-fila');
    expect(r3).toEqual({ reenviados: 0, escalar: [{ pedido_id: A.id }] });
    expect(wpp.calls.length).toBe(antes + 2); // nunca 2 reenvios
    expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND canal='twilio'`, [A.id])).toBe(4);
    expect(await n(`SELECT max(tentativa) n FROM agentes.avisos_enviados WHERE pedido_id = $1`, [A.id])).toBe(2);
    await aposentar(A);
  });

  it('controle 57: pedido DECIDIDO antes de N horas, e pedido com MENOS de N horas -> 0 reenvios, fora de `escalar`', async () => {
    const B = await semear('2020-03-01T00:00:00Z'); // decidido
    const C = await semear('2020-03-01T03:00:00Z'); // só 2 h de idade na hora do reenvio
    await svc.whatsappGrave(B.id);
    await svc.whatsappGrave(C.id);
    await admin.query(
      `INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, motivo) VALUES ($1,$2,'negar','staff:qa','humano','nao')`, [B.id, B.atitude],
    );
    const antes = wpp.calls.length;
    const r = await reenviar.execute({ agora: '2020-03-01T05:00:00Z' }, 'sol-fila');
    expect(r).toEqual({ reenviados: 0, escalar: [] });
    expect(wpp.calls.length).toBe(antes);
    for (const p of [B, C]) {
      expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND tentativa = 2`, [p.id])).toBe(0);
    }
    // e o relógio manda: 3 h depois C passa de 4 h e entra (prova que o controle não é instrumento morto)
    const r2 = await reenviar.execute({ agora: '2020-03-01T07:30:00Z' }, 'sol-fila');
    expect(r2.reenviados).toBe(2);
    expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND tentativa = 2`, [C.id])).toBe(2);
    expect(await n(`SELECT count(*) n FROM agentes.avisos_enviados WHERE pedido_id = $1 AND tentativa = 2`, [B.id])).toBe(0);
    await aposentar(C);
  });

  it('o resolvedor de decisores roda contra o IAM real sob app_system (SQL e funções existem) e devolve uma lista', async () => {
    const uids = await withActorContext(app, (c) => resolverDecisoresPedidosIa(c), ADMIN_ACTOR);
    expect(Array.isArray(uids)).toBe(true);
  });
});
