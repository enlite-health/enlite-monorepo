/**
 * agentes-insert-only-078.e2e.test.ts — spec 078, M3a-1 (migration 551): as invariantes do schema `agentes`
 * provadas como `app_runtime` (a role do request path), no BANCO real. Nada passa pela API.
 * Cada teste roda numa transação que sempre dá ROLLBACK (dados SINTÉTICOS, nenhuma sujeira); os erros esperados
 * são capturados com SAVEPOINT para a transação seguir.
 *
 * Itens do §3: 17/18 (CHECKs do reporte, UPDATE/DELETE negados) · 19 (pedido no formato) ·
 * 20/48 (1 decisão por atitude, agente nunca aprova) · 41 (linha de base sem pedido).
 */
import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const TABELAS = [
  'veredictos', 'veredicto_achados', 'reportes', 'reporte_veredictos', 'pedidos',
  'pedido_atitudes', 'pedido_origens', 'pedido_eventos', 'medicoes',
];

describe('schema agentes — INSERT-only, CHECKs e unicidades (spec 078, migration 551)', () => {
  let pool: Pool;
  let client: PoolClient;
  let n = 0;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  /** Transação como app_runtime com identidade de staff (o request path); sempre revertida. */
  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_runtime');
    await client.query(`SELECT set_config('app.user_uid', 'qa-078-staff', true)`);
    n = 0;
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  /** SQLSTATE do erro, ou 'NENHUM-ERRO'. SAVEPOINT: o erro não aborta a transação do teste. */
  async function sqlState(sql: string, params: unknown[] = []): Promise<string> {
    await client.query('SAVEPOINT s');
    try {
      await client.query(sql, params);
      await client.query('RELEASE SAVEPOINT s');
      return 'NENHUM-ERRO';
    } catch (e) {
      await client.query('ROLLBACK TO SAVEPOINT s');
      return (e as { code?: string }).code ?? 'sem-código';
    }
  }

  async function um(sql: string, params: unknown[] = []): Promise<string> {
    const { rows } = await client.query(sql, params);
    return rows[0].id;
  }

  const veredicto = (over: Partial<Record<string, unknown>> = {}) => {
    n += 1;
    const v = { operador: 'luz', sensor: 'silente', inbox: 'ar-1', conversa_ref: `conv-${n}`, ultima_msg_ref: `msg-${n}`, ...over };
    return um(
      `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas)
       VALUES ($1,$2,$3,$4,$5,false) RETURNING id`,
      [v.operador, v.sensor, v.inbox, v.conversa_ref, v.ultima_msg_ref],
    );
  };
  const pedido = () =>
    um(`INSERT INTO agentes.pedidos (assunto, descricao, autor, area, registro_versao) VALUES ('assunto','descricao tipada','sol','recrutamento','v1') RETURNING id`);
  const atitude = (pedidoId: string, versao = 1) =>
    um(
      `INSERT INTO agentes.pedido_atitudes (pedido_id, versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback)
       VALUES ($1,$2,1,'memoria: x','caso: y','taxa_violacao','7d','taxa > 2x baseline') RETURNING id`,
      [pedidoId, versao],
    );
  const evento = (pedidoId: string, atitudeId: string, acao: string, kind = 'humano', motivo: string | null = null, comentario: string | null = null) =>
    sqlState(
      `INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, motivo, comentario)
       VALUES ($1,$2,$3,'marcel',$4,$5,$6)`,
      [pedidoId, atitudeId, acao, kind, motivo, comentario],
    );

  it.each(TABELAS)('17/18. %s: UPDATE e DELETE como app_runtime -> 42501 (INSERT-only no banco)', async (tabela) => {
    const coluna = tabela === 'reporte_veredictos' ? 'reporte_id' : 'id'; // M:N sem id próprio
    expect(await sqlState(`UPDATE agentes.${tabela} SET ${coluna} = ${coluna}`)).toBe('42501');
    expect(await sqlState(`DELETE FROM agentes.${tabela}`)).toBe('42501');
    expect(await sqlState(`TRUNCATE agentes.${tabela}`)).toBe('42501');
  });

  it('controle positivo: INSERT válido em cada uma das 9 tabelas -> 1 linha', async () => {
    const v = await veredicto();
    await um(`INSERT INTO agentes.veredicto_achados (veredicto_id, tipo, regra_ref, gravidade) VALUES ($1,'violacao','01-principios#0123456789ab','alta') RETURNING id`, [v]);
    const r = await um(`INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, janela_de, janela_ate, observacao) VALUES ('gestor-1','luz','recrutamento','leve','tom#0123456789ab','2026-10-01','2026-10-07','respondeu fora do tom') RETURNING id`);
    await client.query(`INSERT INTO agentes.reporte_veredictos (reporte_id, veredicto_id) VALUES ($1,$2)`, [r, v]);
    const p = await pedido();
    const a = await atitude(p);
    await um(`INSERT INTO agentes.pedido_origens (pedido_id, reporte_id) VALUES ($1,$2) RETURNING id`, [p, r]);
    expect(await evento(p, a, 'aceitar')).toBe('NENHUM-ERRO');
    await um(`INSERT INTO agentes.medicoes (metrica, escopo, de, ate, valor, n, motivo) VALUES ('taxa_violacao','luz', now()-interval '7 days', now(), 0.12, 40, 'linha_de_base') RETURNING id`);
    for (const t of TABELAS) {
      const { rows } = await client.query(`SELECT count(*)::int AS c FROM agentes.${t}`);
      expect({ t, c: rows[0].c }).toEqual({ t, c: 1 });
    }
  });

  it('11. veredicto duplicado (sensor, inbox, conversa_ref, ultima_msg_ref) -> 23505', async () => {
    await veredicto({ conversa_ref: 'dup', ultima_msg_ref: 'm1' });
    expect(await sqlState(
      `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas) VALUES ('luz','silente','ar-1','dup','m1',false)`,
    )).toBe('23505');
    // controle: outra última mensagem da mesma conversa é outro veredicto
    expect(await sqlState(
      `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas) VALUES ('luz','silente','ar-1','dup','m2',false)`,
    )).toBe('NENHUM-ERRO');
  });

  it('11. nota/juiz_versao só existem quando sensor = juiz (nos dois sentidos) -> 23514', async () => {
    const base = `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas, nota, juiz_versao) VALUES ('luz',$1,'ar-1','c','m',false,$2,$3)`;
    expect(await sqlState(base, ['silente', 7, null])).toBe('23514');
    expect(await sqlState(base, ['juiz', null, 'j1'])).toBe('23514');
    expect(await sqlState(base, ['juiz', 7, null])).toBe('23514');
    expect(await sqlState(base, ['juiz', 7, 'j1'])).toBe('NENHUM-ERRO');
  });

  it('11. achado: gravidade NULL se e só se acerto -> 23514', async () => {
    const v = await veredicto();
    const q = `INSERT INTO agentes.veredicto_achados (veredicto_id, tipo, regra_ref, gravidade) VALUES ($1,$2,'p#0123456789ab',$3)`;
    expect(await sqlState(q, [v, 'violacao', null])).toBe('23514');
    expect(await sqlState(q, [v, 'acerto', 'baixa'])).toBe('23514');
    expect(await sqlState(q, [v, 'acerto', null])).toBe('NENHUM-ERRO');
  });

  it('17/18. reporte com observacao de 501 caracteres -> 23514; com 500 entra', async () => {
    const q = `INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, janela_de, janela_ate, observacao) VALUES ('g','luz','recrutamento','leve','r#1','2026-10-01','2026-10-07',$1)`;
    expect(await sqlState(q, ['x'.repeat(501)])).toBe('23514');
    expect(await sqlState(q, ['x'.repeat(500)])).toBe('NENHUM-ERRO');
    expect(await sqlState(
      `INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, janela_de, janela_ate, observacao, regra_proposta) VALUES ('g','luz','recrutamento','leve','r#2','2026-10-01','2026-10-07','ok',$1)`, ['r'.repeat(301)],
    )).toBe('23514');
  });

  it('reporte tipado: caso fora da lista -> 23514; leve/reforco sem regra_ref -> 23514; meta sem regra_ref entra; janela invertida -> 23514; ocorrencias < 0 -> 23514', async () => {
    const q = (caso: string, regra: string | null, de = '2026-10-01', ate = '2026-10-07', oc: number | null = 1) =>
      sqlState(
        `INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, ocorrencias, janela_de, janela_ate, observacao)
         VALUES ('g','luz','recrutamento',$1,$2,$5,$3,$4,'o')`,
        [caso, regra, de, ate, oc],
      );
    expect(await q('grave', 'r#1')).toBe('23514');
    expect(await q('leve', null)).toBe('23514');
    expect(await q('reforco', null)).toBe('23514');
    expect(await q('meta', null)).toBe('NENHUM-ERRO');
    expect(await q('reforco', 'r#1', '2026-10-08', '2026-10-07')).toBe('23514');
    expect(await q('leve', 'r#9', '2026-10-01', '2026-10-07', -1)).toBe('23514');
    expect(await q('leve', 'r#9', '2026-10-01', '2026-10-01', 0)).toBe('NENHUM-ERRO'); // janela de 1 dia e 0 ocorrências valem
    expect(await q('leve', 'r'.repeat(201))).toBe('23514');
  });

  it('reporte duplicado (operador, caso, regra_ref, janela) -> 23505; vale também para meta (regra_ref NULL); outra janela ou outro caso entra', async () => {
    const q = (caso: string, regra: string | null, ate = '2026-10-07', operador = 'luz') =>
      sqlState(
        `INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, janela_de, janela_ate, observacao)
         VALUES ('g',$4,'recrutamento',$1,$2,'2026-10-01',$3,'o')`,
        [caso, regra, ate, operador],
      );
    expect(await q('leve', 'tom#1')).toBe('NENHUM-ERRO');
    expect(await q('leve', 'tom#1')).toBe('23505');
    expect(await q('meta', null)).toBe('NENHUM-ERRO');
    expect(await q('meta', null)).toBe('23505');
    expect(await q('leve', 'tom#1', '2026-10-08')).toBe('NENHUM-ERRO');
    expect(await q('reforco', 'tom#1')).toBe('NENHUM-ERRO');
    expect(await q('leve', 'tom#1', '2026-10-07', 'outro-op')).toBe('NENHUM-ERRO');
  });

  it('placar_diario: 2 veredictos no mesmo dia -> 1 linha por regra_ref com as contagens; dia sem violação -> 1 linha com regra_ref NULL; acerto não vira linha', async () => {
    const ins = (conv: string, nota: number, cruza: boolean, em: string) =>
      um(
        `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, nota, cruza_areas, juiz_versao, avaliado_em)
         VALUES ('op-view','juiz','ar-1',$1,'m',$2,$3,'jv1',$4) RETURNING id`,
        [conv, nota, cruza, em],
      );
    const ach = (v: string, tipo: string, regra: string, grav: string | null) =>
      client.query(`INSERT INTO agentes.veredicto_achados (veredicto_id, tipo, regra_ref, gravidade) VALUES ($1,$2,$3,$4)`, [v, tipo, regra, grav]);
    const v1 = await ins('conv-a', 4, true, '2026-10-15T15:00:00Z');
    const v2 = await ins('conv-b', 8, false, '2026-10-15T18:00:00Z');
    await ach(v1, 'violacao', 'tom#aaa', 'alta');
    await ach(v1, 'violacao', 'canal#bbb', 'baixa');
    await ach(v2, 'violacao', 'tom#aaa', 'media');
    await ach(v2, 'acerto', 'prazo#ccc', null);
    await ins('conv-c', 9, false, '2026-10-16T15:00:00Z'); // outro dia, sem achado

    const { rows } = await client.query(
      `SELECT operador, to_char(dia,'YYYY-MM-DD') AS dia, regra_ref, violacoes::int AS violacoes,
              conversas_avaliadas::int AS conversas, nota_media::float8 AS nota, cruza_areas::int AS cruza
         FROM agentes.placar_diario WHERE operador = 'op-view' ORDER BY dia, regra_ref NULLS LAST`,
    );
    expect(rows).toEqual([
      { operador: 'op-view', dia: '2026-10-15', regra_ref: 'canal#bbb', violacoes: 1, conversas: 2, nota: 6, cruza: 1 },
      { operador: 'op-view', dia: '2026-10-15', regra_ref: 'tom#aaa', violacoes: 2, conversas: 2, nota: 6, cruza: 1 },
      { operador: 'op-view', dia: '2026-10-16', regra_ref: null, violacoes: 0, conversas: 1, nota: 9, cruza: 0 },
    ]);
  });

  it('19. pedido: conteudo da atitude > 4000 -> 23514; área > 40 -> 23514; pedido sem atitude não tem evento (FK)', async () => {
    const p = await pedido();
    const q = `INSERT INTO agentes.pedido_atitudes (pedido_id, versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback)
               VALUES ($1,1,1,$2,'c','m','7d','r')`;
    expect(await sqlState(q, [p, 'c'.repeat(4001)])).toBe('23514');
    expect(await sqlState(q, [p, 'c'.repeat(4000)])).toBe('NENHUM-ERRO');
    expect(await sqlState(
      `INSERT INTO agentes.pedidos (assunto, descricao, autor, area, registro_versao) VALUES ('a','d','sol',$1,'v1')`, ['a'.repeat(41)],
    )).toBe('23514');
  });

  it('19. origem do pedido é reporte OU veredicto (nunca os dois, nunca nenhum) -> 23514', async () => {
    const p = await pedido();
    const r = await um(`INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, janela_de, janela_ate, observacao) VALUES ('g','luz','x','leve','r#3','2026-10-01','2026-10-07','o') RETURNING id`);
    const v = await veredicto();
    const q = `INSERT INTO agentes.pedido_origens (pedido_id, reporte_id, veredicto_id) VALUES ($1,$2,$3)`;
    expect(await sqlState(q, [p, r, v])).toBe('23514');
    expect(await sqlState(q, [p, null, null])).toBe('23514');
    expect(await sqlState(q, [p, null, v])).toBe('NENHUM-ERRO');
  });

  it('20/48. aceitar com actor_kind=agente -> 23514 (agente nunca aprova); negar e descrever idem; humano entra', async () => {
    const p = await pedido();
    const a = await atitude(p);
    expect(await evento(p, a, 'aceitar', 'agente')).toBe('23514');
    expect(await evento(p, a, 'negar', 'agente', 'motivo')).toBe('23514');
    expect(await evento(p, a, 'descrever', 'agente', null, 'comentario')).toBe('23514');
    expect(await evento(p, a, 'aceitar', 'humano')).toBe('NENHUM-ERRO');
  });

  it('20/48. 2ª decisão (aceitar ou negar) na mesma atitude -> 23505; descrever repete; atitude nova decide de novo', async () => {
    const p = await pedido();
    const a1 = await atitude(p, 1);
    const a2 = await atitude(p, 2);
    expect(await evento(p, a1, 'aceitar')).toBe('NENHUM-ERRO');
    expect(await evento(p, a1, 'aceitar')).toBe('23505');
    expect(await evento(p, a1, 'negar', 'humano', 'motivo')).toBe('23505');
    expect(await evento(p, a1, 'descrever', 'humano', null, 'c1')).toBe('NENHUM-ERRO');
    expect(await evento(p, a1, 'descrever', 'humano', null, 'c2')).toBe('NENHUM-ERRO');
    expect(await evento(p, a2, 'aceitar')).toBe('NENHUM-ERRO');
  });

  it('20/48. negar sem motivo -> 23514; descrever sem comentário -> 23514; com eles entram', async () => {
    const p = await pedido();
    const a = await atitude(p);
    expect(await evento(p, a, 'negar', 'humano', null)).toBe('23514');
    expect(await evento(p, a, 'descrever', 'humano', null, null)).toBe('23514');
    expect(await evento(p, a, 'negar', 'humano', 'fora do escopo')).toBe('NENHUM-ERRO');
  });

  it('20/48. o evento só prende uma atitude DO MESMO pedido (FK composta) -> 23503', async () => {
    const p1 = await pedido();
    const p2 = await pedido();
    const aDoP2 = await atitude(p2);
    expect(await evento(p1, aDoP2, 'aceitar')).toBe('23503');
  });

  it('41. medicoes: pedido_id junto de linha_de_base -> 23514; linha_de_base sem pedido entra; antes/depois sem pedido -> 23514', async () => {
    const p = await pedido();
    const q = `INSERT INTO agentes.medicoes (metrica, escopo, de, ate, valor, n, motivo, pedido_id) VALUES ('m','luz', now()-interval '1 day', now(), 1, 1, $1, $2)`;
    expect(await sqlState(q, ['linha_de_base', p])).toBe('23514');
    expect(await sqlState(q, ['antes', null])).toBe('23514');
    expect(await sqlState(q, ['linha_de_base', null])).toBe('NENHUM-ERRO');
    expect(await sqlState(q, ['antes', p])).toBe('NENHUM-ERRO');
  });

  it('pedido_status: novo -> aceito depois do evento; descrever depois vira redirecionado; negar vira negado', async () => {
    const status = async (id: string) => (await client.query(`SELECT status FROM agentes.pedido_status WHERE pedido_id = $1`, [id])).rows[0].status;
    const p = await pedido();
    const a = await atitude(p);
    expect(await status(p)).toBe('novo');
    await client.query(
      `INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, ts) VALUES ($1,$2,'aceitar','marcel','humano', now() + interval '1 second')`,
      [p, a],
    );
    expect(await status(p)).toBe('aceito');
    await client.query(
      `INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, comentario, ts) VALUES ($1,$2,'descrever','marcel','humano','muda o degrau', now() + interval '2 seconds')`,
      [p, a],
    );
    expect(await status(p)).toBe('redirecionado');
    const p2 = await pedido();
    const a2 = await atitude(p2);
    await client.query(
      `INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, motivo) VALUES ($1,$2,'negar','marcel','humano','nao')`,
      [p2, a2],
    );
    expect(await status(p2)).toBe('negado');
  });

  it('RLS: app_runtime SEM identidade (sem app.user_uid) não insere (42501) e não lê; app_system com system_context passa', async () => {
    await client.query(`SELECT set_config('app.user_uid', '', true)`);
    expect(await sqlState(
      `INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, janela_de, janela_ate, observacao) VALUES ('g','luz','x','leve','r#3','2026-10-01','2026-10-07','o')`,
    )).toBe('42501');
    // com identidade, grava uma linha; sem identidade, o SELECT devolve 0
    await client.query(`SELECT set_config('app.user_uid', 'qa-078-staff', true)`);
    await client.query(`INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, janela_de, janela_ate, observacao) VALUES ('g','luz','x','leve','r#3','2026-10-01','2026-10-07','o')`);
    expect((await client.query(`SELECT count(*)::int AS c FROM agentes.reportes`)).rows[0].c).toBe(1);
    await client.query(`SELECT set_config('app.user_uid', '', true)`);
    expect((await client.query(`SELECT count(*)::int AS c FROM agentes.reportes`)).rows[0].c).toBe(0);
    // sistema: role app_system + app.system_context
    await client.query('RESET ROLE');
    await client.query('SET LOCAL ROLE app_system');
    await client.query(`SELECT set_config('app.system_context', 'qa-078', true)`);
    expect((await client.query(`SELECT count(*)::int AS c FROM agentes.reportes`)).rows[0].c).toBe(1);
  });
});
