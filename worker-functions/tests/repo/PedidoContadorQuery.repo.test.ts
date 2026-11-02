/**
 * PedidoContadorQuery.repo.test.ts — Postgres REAL (nunca mock), spec 081 F4 / T092 / D601.
 * Banco EFÊMERO próprio (CREATE DATABASE) com SÓ a migration 551 (schema `agentes`); derruba no afterAll.
 * Como rodar (mesmo protocolo dos irmãos de tests/repo):
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:<porta>/enlite_e2e \
 *     npx jest --config jest.config.repo.js PedidoContadorQuery --maxWorkers=2
 *
 * FIXTURE SINTÉTICA — 10 pedidos (9 na janela [2026-09-07, 2026-10-19), 1 fora). Semana = segunda-feira em Buenos Aires.
 * "limpa" = 1º evento aceitar, sem comentário, atitude versao 1. Todos os dados são óbvios de teste.
 *
 * pedido | semana     | origem                  | eventos                        | classe      | conta em
 * -------|------------|-------------------------|--------------------------------|-------------|---------
 * P1     | 2026-09-07 | reporte                 | aceitar, sem comentário, v1    | limpa       | contador 1
 * P2     | 2026-09-07 | MISTA reporte+veredicto | aceitar, sem comentário, v1    | limpa       | contador 1 (iii)
 * P3     | 2026-09-14 | reporte                 | aceitar, sem comentário, v1    | limpa       | contador 1
 * P4     | 2026-09-14 | reporte                 | negar (com motivo)             | contestação | contador 1 (i) ZERA
 * P5     | 2026-09-21 | reporte                 | aceitar, sem comentário, v1    | limpa       | contador 1
 * P6     | 2026-09-21 | reporte                 | (nenhum)                       | pendente    | contador 1 (iv)
 * V1     | 2026-09-07 | só veredicto            | aceitar, sem comentário, v1    | limpa       | contador 2
 * V2     | 2026-09-07 | só veredicto            | aceitar, sem comentário, v1    | limpa       | contador 2
 * V3     | 2026-09-14 | só veredicto            | aceitar, sem comentário, v1    | limpa       | contador 2 (ii) 1 aceita só
 * FORA   | 2026-10-26 | só veredicto            | descrever (contestação)        | contestação | NENHUM (fora da janela)
 *
 * Semanas do contador 1: 09-07 = 2 limpas -> válida (seq 1) · 09-14 = 1 limpa + 1 contestação -> ZERA (seq 0) ·
 *   09-21 = 1 limpa + 1 pendente -> neutra (seq 0; pendente não conta como aceita, nem zera).
 * Semanas do contador 2: 09-07 = 2 limpas -> válida (seq 1) · 09-14 = 1 limpa -> neutra (não avança, não zera).
 *   Se o FORA entrasse na janela, a contestação de 10-26 zeraria o contador 2 (1 -> 0).
 *
 * NÚMEROS ESPERADOS (exatos)
 *   contador 1: semanasValidasSeguidas 0 · ultimaContestacaoSemana '2026-09-14' · pendentes 1 · pedidos 6 · atingiuRegua false (régua 4)
 *   contador 2: semanasValidasSeguidas 1 · ultimaContestacaoSemana null         · pendentes 0 · pedidos 3 · atingiuRegua false (régua 26)
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import {
  consultarContadoresPedidos,
  sequenciaVigente,
  REGUA_CONTADOR_1_SEMANAS,
  REGUA_CONTADOR_2_SEMANAS,
} from '../../src/modules/agentes/infrastructure/PedidoContadorQuery';

const BASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5455/enlite_e2e';
const MIGRATION = path.join(__dirname, '..', '..', 'migrations', '551_078_agentes_placar_reportes_pedidos.sql');
const JANELA = { de: new Date('2026-09-07T03:00:00Z'), ate: new Date('2026-10-19T03:00:00Z') };

let pool: Pool;
let dbName: string;

type Ev = { acao: 'aceitar' | 'negar' | 'descrever'; comentario?: string; motivo?: string } | null;
interface P { id: string; criado: string; origem: 'reporte' | 'mista' | 'veredicto'; ev: Ev }

const FIXTURE: P[] = [
  { id: 'P1', criado: '2026-09-09T15:00:00Z', origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'P2', criado: '2026-09-09T16:00:00Z', origem: 'mista', ev: { acao: 'aceitar' } },
  { id: 'P3', criado: '2026-09-16T15:00:00Z', origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'P4', criado: '2026-09-16T16:00:00Z', origem: 'reporte', ev: { acao: 'negar', motivo: 'motivo sintético' } },
  { id: 'P5', criado: '2026-09-23T15:00:00Z', origem: 'reporte', ev: { acao: 'aceitar' } },
  { id: 'P6', criado: '2026-09-23T16:00:00Z', origem: 'reporte', ev: null },
  { id: 'V1', criado: '2026-09-09T17:00:00Z', origem: 'veredicto', ev: { acao: 'aceitar' } },
  { id: 'V2', criado: '2026-09-09T18:00:00Z', origem: 'veredicto', ev: { acao: 'aceitar' } },
  { id: 'V3', criado: '2026-09-16T17:00:00Z', origem: 'veredicto', ev: { acao: 'aceitar' } },
  { id: 'FORA', criado: '2026-10-28T15:00:00Z', origem: 'veredicto', ev: { acao: 'descrever', comentario: 'ajuste sintético' } },
];

async function seed(): Promise<void> {
  let n = 0;
  for (const p of FIXTURE) {
    n += 1;
    const ped = await pool.query<{ id: string }>(
      `INSERT INTO agentes.pedidos (assunto, descricao, autor, area, registro_versao, criado_em)
       VALUES ($1,'descrição sintética','autor-sintetico','area-sintetica','v-sintetica',$2) RETURNING id`,
      [`Pedido sintético ${p.id}`, p.criado],
    );
    const pedidoId = ped.rows[0].id;
    const at = await pool.query<{ id: string }>(
      `INSERT INTO agentes.pedido_atitudes (pedido_id, versao, degrau, conteudo, caso_teste, metrica_alvo, janela, gatilho_rollback)
       VALUES ($1,1,0,'c','t','m','j','g') RETURNING id`,
      [pedidoId],
    );
    if (p.origem !== 'veredicto') {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO agentes.reportes (autor, operador, area, caso, regra_ref, janela_de, janela_ate, observacao)
         VALUES ('autor-sintetico','operador-sintetico','area-sintetica','leve',$1,'2026-09-01','2026-09-02','obs sintética') RETURNING id`,
        [`regra-${n}`],
      );
      await pool.query(`INSERT INTO agentes.pedido_origens (pedido_id, reporte_id) VALUES ($1,$2)`, [pedidoId, r.rows[0].id]);
    }
    if (p.origem !== 'reporte') {
      const v = await pool.query<{ id: string }>(
        `INSERT INTO agentes.veredictos (operador, sensor, inbox, conversa_ref, ultima_msg_ref, cruza_areas)
         VALUES ('operador-sintetico','silente','inbox-sintetica',$1,'msg-sintetica',false) RETURNING id`,
        [`conversa-${n}`],
      );
      await pool.query(`INSERT INTO agentes.pedido_origens (pedido_id, veredicto_id) VALUES ($1,$2)`, [pedidoId, v.rows[0].id]);
    }
    if (p.ev) {
      await pool.query(
        `INSERT INTO agentes.pedido_eventos (pedido_id, atitude_id, acao, actor_uid, actor_kind, motivo, comentario, ts)
         VALUES ($1,$2,$3,'humano-sintetico','humano',$4,$5,$6)`,
        [pedidoId, at.rows[0].id, p.ev.acao, p.ev.motivo ?? null, p.ev.comentario ?? null, p.criado],
      );
    }
  }
}

beforeAll(async () => {
  dbName = `t092_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: BASE_URL });
  try { await admin.query(`CREATE DATABASE ${dbName}`); } finally { await admin.end(); }
  const u = new URL(BASE_URL);
  u.pathname = `/${dbName}`;
  pool = new Pool({ connectionString: u.toString() });
  const c = await pool.connect();
  try {
    c.on('notice', () => undefined);
    await c.query(fs.readFileSync(MIGRATION, 'utf8'));
  } finally { c.release(); }
  await seed();
});

afterAll(async () => {
  await pool.end();
  const admin = new Pool({ connectionString: BASE_URL });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally { await admin.end(); }
});

describe('consultarContadoresPedidos — conjunto sintético de 10 pedidos (9 na janela + 1 fora)', () => {
  it('contador 1 (origem com reporte, inclusive mista): zera na contestação; pendente não conta nem zera', async () => {
    const { contador1 } = await consultarContadoresPedidos(pool, JANELA);
    expect(contador1).toEqual({
      semanasValidasSeguidas: 0,
      reguaSemanas: 4,
      atingiuRegua: false,
      ultimaContestacaoSemana: '2026-09-14',
      pendentes: 1,
      pedidos: 6,
    });
  });

  it('contador 2 (só veredicto): semana de 1 aceita só não avança nem zera; o pedido fora da janela não entra', async () => {
    const { contador2 } = await consultarContadoresPedidos(pool, JANELA);
    expect(contador2).toEqual({
      semanasValidasSeguidas: 1,
      reguaSemanas: 26,
      atingiuRegua: false,
      ultimaContestacaoSemana: null,
      pendentes: 0,
      pedidos: 3,
    });
  });

  it('janela maior (inclui o FORA): a contestação de 10-26 zera o contador 2 — prova que a janela filtra', async () => {
    const { contador2 } = await consultarContadoresPedidos(pool, { de: JANELA.de, ate: new Date('2026-11-02T03:00:00Z') });
    expect(contador2.semanasValidasSeguidas).toBe(0);
    expect(contador2.pedidos).toBe(4);
  });
});

describe('sequenciaVigente / réguas', () => {
  const validas = (n: number) => Array.from({ length: n }, (_, i) => ({ semana: `2026-${String(1000 + i)}`, limpas: 2, contestacoes: 0 }));
  it('réguas são 4 e 26 semanas', () => {
    expect(REGUA_CONTADOR_1_SEMANAS).toBe(4);
    expect(REGUA_CONTADOR_2_SEMANAS).toBe(26);
  });
  it('4 semanas válidas seguidas = 4; contestação no meio volta a 0 e recomeça', () => {
    expect(sequenciaVigente(validas(4)).seguidas).toBe(4);
    const meio = [...validas(3), { semana: '2026-1003x', limpas: 0, contestacoes: 1 }, { semana: '2026-1004', limpas: 2, contestacoes: 0 }];
    expect(sequenciaVigente(meio).seguidas).toBe(1);
  });
  it('semana neutra (1 limpa) no meio não quebra nem soma', () => {
    const s = [...validas(2), { semana: '2026-1002x', limpas: 1, contestacoes: 0 }, { semana: '2026-1003', limpas: 2, contestacoes: 0 }];
    expect(sequenciaVigente(s).seguidas).toBe(3);
  });
});
