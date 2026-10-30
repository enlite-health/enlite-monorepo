/**
 * agentes-aprovacao-078.e2e.test.ts — spec 078, M1.3.1 (itens 20/48, §6.11): a capability `agentes.aprovacao.verificar`
 * contra o BANCO real (migration 551), pelo caminho de produção (`withActorContext`, role app_system, ator
 * `system:mcp:sol-propagador`). Dados SINTÉTICOS por execução; a limpeza usa o admin (o app não deleta).
 * Pedido/atitude/evento entram por admin: o que se prova aqui é a LEITURA, não o depósito.
 */
import { Pool } from 'pg';
import { AgentesRepository } from '../../src/modules/mcp/infrastructure/AgentesRepository';
import { AgentesAprovacaoVerificarCapability } from '../../src/modules/mcp/application/capabilities/AgentesAprovacaoVerificarCapability';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('agentes.aprovacao.verificar contra o banco (spec 078, M1.3.1)', () => {
  let admin: Pool;
  let app: Pool;
  let cap: AgentesAprovacaoVerificarCapability;
  const run = Math.random().toString(36).slice(2, 8);
  const area = `ap-${run}`;

  beforeAll(() => {
    admin = new Pool({ connectionString: DATABASE_URL });
    app = new Pool({ connectionString: DATABASE_URL });
    app.on('connect', (c) => {
      void c.query(`SET ROLE app_system; SELECT set_config('app.system_context', 'mcp:qa078', false)`);
    });
    cap = new AgentesAprovacaoVerificarCapability(new AgentesRepository(app));
  });

  afterAll(async () => {
    const ids = `(SELECT id FROM agentes.pedidos WHERE area = $1)`;
    await admin.query(`DELETE FROM agentes.pedido_eventos WHERE pedido_id IN ${ids}`, [area]);
    await admin.query(`DELETE FROM agentes.pedido_origens WHERE pedido_id IN ${ids}`, [area]);
    await admin.query(`DELETE FROM agentes.pedido_atitudes WHERE pedido_id IN ${ids}`, [area]);
    await admin.query(`DELETE FROM agentes.pedidos WHERE area = $1`, [area]);
    await admin.query(`DELETE FROM agentes.veredictos WHERE operador = $1`, [`qa-${run}`]);
    await app.end();
    await admin.end();
  });

  /** pedido com `versoes` atitudes (v1..vN) — devolve os ids das atitudes em ordem de versão. */
  async function pedidoComAtitudes(versoes: number) {
    const ver = await admin.query(
      `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas, avaliado_em)
       VALUES ($1,'silente',$2,$3,$4,false,now()) RETURNING id`,
      [`qa-${run}`, `ib-${run}`, `c-${Math.random()}`, `m-${Math.random()}`],
    );
    const ped = await admin.query(
      `INSERT INTO agentes.pedidos (assunto, descricao, autor, area, grave_gatilho, registro_versao)
       VALUES ('ajustar tom','descrição','sol-fila',$1,'nenhum','v1') RETURNING id`,
      [area],
    );
    const pedidoId = ped.rows[0].id as string;
    await admin.query(`INSERT INTO agentes.pedido_origens (pedido_id, veredicto_id) VALUES ($1,$2)`, [pedidoId, ver.rows[0].id]);
    const atitudes: string[] = [];
    for (let v = 1; v <= versoes; v++) {
      const a = await admin.query(
        `INSERT INTO agentes.pedido_atitudes (pedido_id, versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback)
         VALUES ($1,$2,1,'memória','caso','taxa_violacao','7d','taxa > 2x') RETURNING id`,
        [pedidoId, v],
      );
      atitudes.push(a.rows[0].id as string);
    }
    return { pedidoId, atitudes };
  }

  const evento = async (pedidoId: string, atitudeId: string, acao: 'aceitar' | 'negar' | 'descrever') => {
    const r = await admin.query(
      `INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, motivo, comentario)
       VALUES ($1,$2,$3,'staff-qa','humano', $4, $5) RETURNING id`,
      [pedidoId, atitudeId, acao, acao === 'negar' ? 'sem motivo bom' : null, acao === 'descrever' ? 'comentário' : null],
    );
    return r.rows[0].id as string;
  };

  it('aceitar na atitude v1 (única) → valida=true, atitude_atual=true, ids e data fiéis', async () => {
    const { pedidoId, atitudes } = await pedidoComAtitudes(1);
    const id = await evento(pedidoId, atitudes[0], 'aceitar');
    const out = await cap.execute({ aprovacao_id: id }, 'sol-propagador');
    expect(out).toEqual({
      valida: true, acao: 'aceitar', pedido_id: pedidoId, atitude_id: atitudes[0], atitude_versao: 1,
      atitude_atual: true, decidido_em: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });

  it('negar → valida=false (acao=negar, atitude_atual=true): Negar não gera aprovação', async () => {
    const { pedidoId, atitudes } = await pedidoComAtitudes(1);
    const id = await evento(pedidoId, atitudes[0], 'negar');
    const out = await cap.execute({ aprovacao_id: id }, 'sol-propagador');
    expect(out).toMatchObject({ valida: false, acao: 'negar', atitude_atual: true });
  });

  it('descrever → valida=false', async () => {
    const { pedidoId, atitudes } = await pedidoComAtitudes(1);
    const id = await evento(pedidoId, atitudes[0], 'descrever');
    expect(await cap.execute({ aprovacao_id: id }, 'sol-propagador')).toMatchObject({ valida: false, acao: 'descrever' });
  });

  it('aceitar na v1 de um pedido que já tem a v2 → valida=false, atitude_atual=false, versão 1', async () => {
    const { pedidoId, atitudes } = await pedidoComAtitudes(2);
    const id = await evento(pedidoId, atitudes[0], 'aceitar');
    const out = await cap.execute({ aprovacao_id: id }, 'sol-propagador');
    expect(out).toMatchObject({ valida: false, acao: 'aceitar', atitude_id: atitudes[0], atitude_versao: 1, atitude_atual: false });
  });

  it('aceitar na v2 (a mais alta) de um pedido com v1 e v2 → valida=true, versão 2', async () => {
    const { pedidoId, atitudes } = await pedidoComAtitudes(2);
    const id = await evento(pedidoId, atitudes[1], 'aceitar');
    expect(await cap.execute({ aprovacao_id: id }, 'sol-propagador')).toMatchObject({ valida: true, atitude_versao: 2, atitude_atual: true });
  });

  it('uuid inexistente → valida=false, acao=null, sem ids', async () => {
    const out = await cap.execute({ aprovacao_id: '123e4567-e89b-12d3-a456-426614174999' }, 'sol-propagador');
    expect(out).toEqual({
      valida: false, acao: null, pedido_id: null, atitude_id: null, atitude_versao: null, atitude_atual: false, decidido_em: null,
    });
  });

  it('o id de uma ATITUDE ou de um PEDIDO não é id de aprovação → valida=false', async () => {
    const { pedidoId, atitudes } = await pedidoComAtitudes(1);
    await evento(pedidoId, atitudes[0], 'aceitar');
    expect((await cap.execute({ aprovacao_id: atitudes[0] }, 'sol-propagador')).valida).toBe(false);
    expect((await cap.execute({ aprovacao_id: pedidoId }, 'sol-propagador')).valida).toBe(false);
  });
});
