/**
 * Spec 092 (F1, T103, CA-1) — fidelidade do catálogo de escalas do registro diário à planilha, no BANCO REAL.
 *
 * O esperado vem do xlsx CRU (lido aqui com `xlsx`, por cabeçalho); nada do gerador é importado (mapa de 18 rótulos, regra de
 * código e lista dos 5 avisos IMEDIATOS são declarados AQUI, independentes). O obtido vem das tabelas da 588/589.
 *   - escalas (18): nome, uso, quem responde, tipo de resposta;
 *   - opções (61 = 64 linhas da aba − "Número" da CNT − as 2 da OM): rótulo, significado, posição, nota só se a opção é número,
 *     texto do aviso literal, pede-motivo;
 *   - motivos (8 = AUT 5 + C-HIZO 3);
 *   - 128 objetivos: pergunta, escala e indicador; 254 atividades: escala.
 * Controles positivos (cada um em transação com ROLLBACK) provam que o medidor enxerga: texto de opção trocado, pergunta trocada,
 * escala de atividade trocada. Só dado de catálogo (sem paciente). A divergência sai com o id (escala/opção, UUID do objetivo/atividade).
 */
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import * as XLSX from 'xlsx';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const XLSX_PATH = path.resolve(
  __dirname,
  '../../scripts/therapeutic-catalog/fonte/Catalogo_objetivos_actividades_por_diagnostico_CIE11.xlsx',
);

const SERVICO_DO_BANCO: Readonly<Record<string, string>> = { AT: 'AT', Cuidado: 'CAREGIVER' };
const RESPONDE: Readonly<Record<string, string>> = { AT: 'AT', 'Cuidador/a': 'CAREGIVER' };
/** Rótulo da coluna "Escala del registro diario (EnLite)" -> código (declarado aqui, independente do gerador). */
const CODIGO_DO_ROTULO: Readonly<Record<string, string>> = {
  'Ánimo observado (1 a 5)': 'ANI', 'Sueño (1 a 5)': 'SUE', 'Estado general (1 a 5)': 'GEN', 'Orientación (1 a 5)': 'ORI',
  'Comunicación (1 a 5)': 'COM', 'Interés e iniciativa (1 a 5)': 'INI',
  'Desempeño: Solo / Con ayuda verbal / Con ayuda física / No lo hizo': 'AUT',
  'Frecuencia: Nunca / A veces / Seguido / Todo el tiempo': 'FRE',
  'Dolor: Sin dolor / Leve / Moderado / Intenso': 'DOL',
  'Sí / No': 'SN', 'Conteo (número)': 'CNT', 'Opción múltiple de alerta (lista del PT)': 'OM',
  'Botones: Lo hizo solo / Lo ayudé / No lo hizo': 'C-HIZO', 'Botones: Sí / No': 'C-SINO',
  'Botones: Contento / Normal / Mal': 'C-ANI', 'Botones: No le duele / Un poco / Mucho': 'C-DOL',
  'Botones: cuántas veces': 'C-CNT', 'Botones: Pasó algo / No pasó nada': 'C-ALE',
};
/** DC-5: as ÚNICAS opções com aviso imediato (escala/opção). */
const IMEDIATAS = ['C-ALE/paso_algo', 'C-DOL/mucho', 'DOL/intenso', 'FRE/todo_el_tiempo', 'GEN/1'];
const SEM_LINHA_DE_OPCAO = new Set(['CNT', 'OM']);
const PEDE_MOTIVO = 'Pide el motivo: ';
const ID_LINHA = /^(\S+)-(AT|CU)-([OA])(\d+)$/;

const slug = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function linhas(wb: XLSX.WorkBook, aba: string): Record<string, string>[] {
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[aba], { header: 1, defval: '' });
  const cab = m[0].map((c) => String(c).trim());
  return m.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => Object.fromEntries(cab.map((nome, i) => [nome, String(r[i] ?? '').trim()])));
}

interface OpcaoEsp { escala: string; pos: number; label: string; meaning: string; score: number | null; alertText: string | null; asksReason: boolean }
interface EscalaEsp { code: string; nome: string; uso: string; answeredBy: string; kind: string; opcoes: OpcaoEsp[]; motivos: string[] }
interface Esperado {
  escalas: EscalaEsp[];
  linhasDaAba: number;
  /** `serviço|título|descrição` -> {pergunta, escala, indicador} */
  objetivos: Map<string, { pergunta: string; escala: string; indicador: string }>;
  /** `serviço|título|descrição do objetivo|título|descrição da atividade` -> escala */
  atividades: Map<string, string>;
}

function esperadoDaPlanilha(): Esperado {
  const wb = XLSX.readFile(XLSX_PATH);

  const abaEscalas = linhas(wb, 'Escalas de respuesta');
  const porCodigo = new Map<string, EscalaEsp>();
  for (const l of abaEscalas) {
    const code = l['Código'];
    const e = porCodigo.get(code) ?? {
      code, nome: l['Escala'], uso: l['Para qué se usa'], answeredBy: RESPONDE[l['Quién la responde']],
      kind: code === 'CNT' ? 'COUNT' : code === 'OM' ? 'MULTI_CHOICE' : 'SINGLE_CHOICE', opcoes: [], motivos: [],
    };
    if (!SEM_LINHA_DE_OPCAO.has(code)) {
      const app = l['Qué hace la app'];
      const pede = app.startsWith(PEDE_MOTIVO);
      e.opcoes.push({
        escala: code, pos: e.opcoes.length + 1, label: l['Opción'], meaning: l['Qué significa'],
        score: /^\d+$/.test(l['Opción']) ? Number(l['Opción']) : null,
        alertText: pede || app === '—' || app === '' ? null : app, asksReason: pede,
      });
      if (pede) e.motivos = app.slice(PEDE_MOTIVO.length).split(' / ').map((s) => s.trim());
    }
    porCodigo.set(code, e);
  }

  const objLinhas = linhas(wb, 'Objetivos específicos');
  const chavePorId = new Map<string, string>();
  const objetivos = new Map<string, { pergunta: string; escala: string; indicador: string }>();
  for (const l of objLinhas) {
    const m = ID_LINHA.exec(l['ID']);
    if (!m || m[3] !== 'O') throw new Error(`ID de objetivo inesperado: ${l['ID']}`);
    const chave = `${SERVICO_DO_BANCO[l['Tipo de servicio']]}|${l['Título']}|${l['Descripción']}`;
    chavePorId.set(l['ID'], chave);
    const escala = CODIGO_DO_ROTULO[l['Escala del registro diario (EnLite)']];
    if (!escala) throw new Error(`rótulo de escala sem par: "${l['Escala del registro diario (EnLite)']}" (${l['ID']})`);
    objetivos.set(chave, { pergunta: l['Pregunta del registro diario (EnLite)'], escala, indicador: l['Indicador operativo (EnLite)'] });
  }
  const atividades = new Map<string, string>();
  for (const l of linhas(wb, 'Actividades de rutina')) {
    const m = ID_LINHA.exec(l['ID']);
    if (!m || m[3] !== 'A') throw new Error(`ID de atividade inesperado: ${l['ID']}`);
    const dono = chavePorId.get(l['ID objetivo']);
    if (!dono) throw new Error(`atividade ${l['ID']} aponta objetivo inexistente ${l['ID objetivo']}`);
    const escala = CODIGO_DO_ROTULO[l['Escala del registro diario (EnLite)']];
    if (!escala) throw new Error(`rótulo de escala sem par: "${l['Escala del registro diario (EnLite)']}" (${l['ID']})`);
    atividades.set(`${dono}|${l['Título']}|${l['Descripción']}`, escala);
  }
  return { escalas: [...porCodigo.values()], linhasDaAba: abaEscalas.length, objetivos, atividades };
}

interface Medida {
  escalas: number; opcoes: number; motivos: number; objetivos: number; atividades: number;
  noBanco: { escalas: number; opcoes: number; motivos: number; objetivosComPergunta: number; atividadesComEscala: number };
  divergencias: string[];
}

async function medir(db: Pick<Pool | PoolClient, 'query'>, esp: Esperado): Promise<Medida> {
  const div: string[] = [];
  const med = { escalas: 0, opcoes: 0, motivos: 0, objetivos: 0, atividades: 0 };
  const n = async (sql: string): Promise<number> => Number((await db.query<{ n: string }>(sql)).rows[0].n);

  type EscRow = { code: string; name_es: string; purpose_es: string; answered_by: string; answer_kind: string };
  const escDb = new Map((await db.query<EscRow>(`SELECT * FROM daily_report_scales`)).rows.map((r) => [r.code, r]));
  type OpRow = { scale_code: string; option_code: string; position: number; label_es: string; meaning_es: string; score: number | null; alert_kind: string | null; alert_text_es: string | null; asks_reason: boolean };
  const opDb = new Map((await db.query<OpRow>(`SELECT * FROM daily_report_scale_options`)).rows.map((r) => [`${r.scale_code}#${r.position}`, r]));
  type MoRow = { scale_code: string; reason_code: string; position: number; label_es: string };
  const moDb = new Map((await db.query<MoRow>(`SELECT * FROM daily_report_scale_reasons`)).rows.map((r) => [`${r.scale_code}#${r.position}`, r]));

  for (const e of esp.escalas) {
    const r = escDb.get(e.code);
    if (r && r.name_es === e.nome && r.purpose_es === e.uso && r.answered_by === e.answeredBy && r.answer_kind === e.kind) med.escalas++;
    else div.push(`escala ${e.code}`);
    for (const o of e.opcoes) {
      const id = `${e.code}/${slug(o.label)}`;
      const d = opDb.get(`${e.code}#${o.pos}`);
      const ok = d && d.option_code === slug(o.label) && d.label_es === o.label && d.meaning_es === o.meaning && d.score === o.score
        && d.alert_text_es === o.alertText && d.asks_reason === o.asksReason
        && (d.alert_kind === 'IMMEDIATE') === IMEDIATAS.includes(id) && (d.alert_kind === null) === (o.alertText === null);
      if (ok) med.opcoes++; else div.push(`opcao ${id}`);
    }
    e.motivos.forEach((label, i) => {
      const d = moDb.get(`${e.code}#${i + 1}`);
      if (d && d.label_es === label && d.reason_code === slug(label)) med.motivos++;
      else div.push(`motivo ${e.code}/${slug(label)}`);
    });
  }

  type ObRow = { id: string; service_code: string; label: string; description: string | null; daily_question: string | null; daily_scale_code: string | null; operative_indicator: string | null };
  const obDb = (await db.query<ObRow>(`SELECT id, service_code, label, description, daily_question, daily_scale_code, operative_indicator FROM therapeutic_specific_objectives WHERE active`)).rows;
  const obPorChave = new Map(obDb.map((r) => [`${r.service_code}|${r.label}|${r.description ?? ''}`, r]));
  for (const [chave, e] of esp.objetivos) {
    const r = obPorChave.get(chave);
    if (r && r.daily_question === e.pergunta && r.daily_scale_code === e.escala && r.operative_indicator === e.indicador) med.objetivos++;
    else div.push(`objetivo ${r?.id ?? chave}`);
  }
  type AtRow = { id: string; objective_id: string; label: string; description: string | null; daily_scale_code: string | null };
  const atDb = (await db.query<AtRow>(`SELECT id, objective_id, label, description, daily_scale_code FROM therapeutic_activities WHERE active`)).rows;
  const chaveObjPorId = new Map(obDb.map((r) => [r.id, `${r.service_code}|${r.label}|${r.description ?? ''}`]));
  const atPorChave = new Map(atDb.map((r) => [`${chaveObjPorId.get(r.objective_id)}|${r.label}|${r.description ?? ''}`, r]));
  for (const [chave, escala] of esp.atividades) {
    const r = atPorChave.get(chave);
    if (r && r.daily_scale_code === escala) med.atividades++;
    else div.push(`atividade ${r?.id ?? chave}`);
  }

  return {
    ...med,
    noBanco: {
      escalas: await n(`SELECT count(*) AS n FROM daily_report_scales`),
      opcoes: await n(`SELECT count(*) AS n FROM daily_report_scale_options`),
      motivos: await n(`SELECT count(*) AS n FROM daily_report_scale_reasons`),
      objetivosComPergunta: await n(`SELECT count(*) AS n FROM therapeutic_specific_objectives WHERE active AND daily_question IS NOT NULL AND daily_scale_code IS NOT NULL AND operative_indicator IS NOT NULL`),
      atividadesComEscala: await n(`SELECT count(*) AS n FROM therapeutic_activities WHERE active AND daily_scale_code IS NOT NULL`),
    },
    divergencias: div,
  };
}

describe('escalas do registro diário — fidelidade à planilha (banco real) @integration', () => {
  let pool: Pool;
  let esperado: Esperado;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    esperado = esperadoDaPlanilha();
  });
  afterAll(async () => { await pool.end(); });

  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  it('a planilha tem o tamanho esperado (a medição enxerga: 18 escalas, 64 linhas, 61 opções, 8 motivos, 128 objetivos, 254 atividades)', () => {
    expect(esperado.escalas).toHaveLength(18);
    expect(esperado.linhasDaAba).toBe(64);
    expect(esperado.escalas.reduce((s, e) => s + e.opcoes.length, 0)).toBe(61);
    expect(esperado.escalas.reduce((s, e) => s + e.motivos.length, 0)).toBe(8);
    expect(esperado.objetivos.size).toBe(128);
    expect(esperado.atividades.size).toBe(254);
    expect(esperado.escalas.flatMap((e) => e.opcoes).filter((o) => o.score !== null)).toHaveLength(33);
  });

  it('banco = planilha: nenhuma divergência e as contagens batem (CA-1)', async () => {
    const m = await medir(pool, esperado);
    expect(m.divergencias).toEqual([]);
    expect({ escalas: m.escalas, opcoes: m.opcoes, motivos: m.motivos, objetivos: m.objetivos, atividades: m.atividades })
      .toEqual({ escalas: 18, opcoes: 61, motivos: 8, objetivos: 128, atividades: 254 });
    expect(m.noBanco).toEqual({ escalas: 18, opcoes: 61, motivos: 8, objetivosComPergunta: 128, atividadesComEscala: 254 });
  });

  it('avisos: IMMEDIATE só nas 5 de DC-5; REPEAT/CHANGE/CONDITIONAL nas demais; NULL onde a planilha não tem aviso', async () => {
    const { rows } = await pool.query<{ k: string | null; n: string }>(`SELECT alert_kind AS k, count(*) AS n FROM daily_report_scale_options GROUP BY 1`);
    const por = Object.fromEntries(rows.map((r) => [r.k ?? 'NULL', Number(r.n)]));
    expect(por).toEqual({ IMMEDIATE: 5, REPEAT: 5, CHANGE: 1, CONDITIONAL: 3, NULL: 47 });
    const im = await pool.query<{ id: string }>(`SELECT scale_code || '/' || option_code AS id FROM daily_report_scale_options WHERE alert_kind = 'IMMEDIATE' ORDER BY 1`);
    expect(im.rows.map((r) => r.id)).toEqual([...IMEDIATAS].sort());
  });

  it('nota só onde a própria opção é número: 33 com nota, 28 sem (L1: a planilha não define)', async () => {
    const { rows } = await pool.query<{ com: string; sem: string }>(`SELECT count(score) AS com, count(*) - count(score) AS sem FROM daily_report_scale_options`);
    expect({ com: Number(rows[0].com), sem: Number(rows[0].sem) }).toEqual({ com: 33, sem: 28 });
  });

  describe('o medidor enxerga defeito (controles positivos, transação desfeita)', () => {
    it('texto de UMA opção trocado -> divergência nomeando a opção', async () => {
      const m = await tx(async (c) => {
        await c.query(`UPDATE daily_report_scale_options SET label_es = 'Casi solo' WHERE scale_code = 'AUT' AND option_code = 'solo'`);
        return medir(c, esperado);
      });
      expect(m.divergencias).toEqual(['opcao AUT/solo']);
      expect(m.opcoes).toBe(60);
    });
    it('pergunta de UM objetivo trocada -> divergência com o id do objetivo', async () => {
      const m = await tx(async (c) => {
        const { rows } = await c.query<{ id: string }>(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY id LIMIT 1`);
        await c.query(`UPDATE therapeutic_specific_objectives SET daily_question = daily_question || ' (editada)' WHERE id = $1`, [rows[0].id]);
        const medida = await medir(c, esperado);
        return { medida, id: rows[0].id };
      });
      expect(m.medida.divergencias).toEqual([`objetivo ${m.id}`]);
    });
    it('escala de UMA atividade trocada -> divergência com o id da atividade; motivo trocado -> divergência do motivo', async () => {
      const m = await tx(async (c) => {
        const { rows } = await c.query<{ id: string }>(`SELECT id FROM therapeutic_activities WHERE active AND daily_scale_code = 'SN' ORDER BY id LIMIT 1`);
        await c.query(`UPDATE therapeutic_activities SET daily_scale_code = 'AUT' WHERE id = $1`, [rows[0].id]);
        await c.query(`UPDATE daily_report_scale_reasons SET label_es = 'Outro motivo' WHERE scale_code = 'AUT' AND reason_code = 'rechazo'`);
        const medida = await medir(c, esperado);
        return { medida, id: rows[0].id };
      });
      expect([...m.medida.divergencias].sort()).toEqual([`atividade ${m.id}`, 'motivo AUT/rechazo'].sort());
    });
  });
});
