/**
 * agentes-schema-078.e2e.test.ts — spec 078, M3a-1 (migration 551): o schema `agentes` provado no BANCO real.
 *
 * Item 11 do §3 ("o placar não tem coluna de texto livre"): lista FECHADA de colunas (nome + tipo) de
 * `veredictos`, `veredicto_achados` e `reportes`. Coluna nova — de qualquer tipo — reprova até alguém editar
 * esta lista de propósito. E todo `text` dessas 3 tabelas tem de ter teto de tamanho (char_length) ou lista
 * fechada de valores (IN) num CHECK de coluna única: `text` sem teto é o buraco por onde a conversa entraria.
 * Nada passa pela API; dados: nenhum (só metadados do catálogo).
 */
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const COLUNAS_ESPERADAS: Record<string, Record<string, string>> = {
  veredictos: {
    id: 'uuid',
    operador: 'text',
    sensor: 'text',
    inbox: 'text',
    conversa_ref: 'text',
    ultima_msg_ref: 'text',
    nota: 'smallint',
    cruza_areas: 'boolean',
    juiz_versao: 'text',
    avaliado_em: 'timestamp with time zone',
  },
  veredicto_achados: {
    id: 'uuid',
    veredicto_id: 'uuid',
    tipo: 'text',
    regra_ref: 'text',
    gravidade: 'text',
  },
  reportes: {
    id: 'uuid',
    autor: 'text',
    operador: 'text',
    area: 'text',
    observacao: 'text',
    regra_proposta: 'text',
    criado_em: 'timestamp with time zone',
  },
};

const TABELAS = [
  'veredictos', 'veredicto_achados', 'reportes', 'reporte_veredictos', 'pedidos',
  'pedido_atitudes', 'pedido_origens', 'pedido_eventos', 'medicoes',
];

describe('schema agentes (spec 078, migration 551)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('0. sanidade: as 9 tabelas e a view existem (o zero das provas abaixo não é banco sem migration)', async () => {
    const { rows } = await pool.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agentes' AND c.relkind IN ('r','v') ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...TABELAS, 'pedido_status'].sort());
  });

  it.each(Object.keys(COLUNAS_ESPERADAS))('11. %s: a lista de colunas é FECHADA (nome + tipo)', async (tabela) => {
    const { rows } = await pool.query(
      `SELECT a.attname AS coluna, format_type(a.atttypid, a.atttypmod) AS tipo
         FROM pg_attribute a
        WHERE a.attrelid = ('agentes.' || $1)::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
      [tabela],
    );
    const real = Object.fromEntries(rows.map((r) => [r.coluna, r.tipo]));
    expect(real).toEqual(COLUNAS_ESPERADAS[tabela]);
  });

  it.each(Object.keys(COLUNAS_ESPERADAS))('11. %s: todo text/varchar tem CHECK de tamanho ou de valores fixos', async (tabela) => {
    const { rows } = await pool.query(
      `SELECT a.attname AS coluna,
              EXISTS (
                SELECT 1 FROM pg_constraint k
                 WHERE k.conrelid = a.attrelid AND k.contype = 'c' AND k.conkey = ARRAY[a.attnum]
                   AND (pg_get_constraintdef(k.oid) LIKE '%char_length(%' OR pg_get_constraintdef(k.oid) LIKE '%= ANY (ARRAY[%')
              ) AS com_teto
         FROM pg_attribute a
        WHERE a.attrelid = ('agentes.' || $1)::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND a.atttypid IN ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype)`,
      [tabela],
    );
    // controle positivo da própria régua: a tabela tem colunas de texto (um instrumento que não vê nenhuma aprovaria tudo)
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.com_teto).map((r) => r.coluna)).toEqual([]);
  });

  it('11. reportes: observacao <= 500 e regra_proposta <= 300 estão no banco (não só na régua do teste)', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'agentes.reportes'::regclass AND contype = 'c' AND conname IN ('reportes_observacao_check','reportes_regra_proposta_check')
        ORDER BY conname`,
    );
    expect(rows.map((r) => r.def)).toEqual([
      expect.stringContaining('<= 500'),
      expect.stringContaining('<= 300'),
    ]);
  });
});
