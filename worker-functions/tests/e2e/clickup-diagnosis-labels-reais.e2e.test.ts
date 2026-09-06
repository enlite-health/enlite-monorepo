/**
 * O mapa `Tipo de Patología` → CID-11 só pode conter rótulos que EXISTEM no ClickUp.
 *
 * 🔴 Por que este teste existe: a migration 326 semeou o mapa com dois rótulos INVENTADOS
 * ("Trastorno del Espectro Autista" e "Parálisis Cerebral"), porque a lista viva não estava
 * acessível na hora. Rótulo inventado é pior que rótulo ausente — ele nunca casa com nada, então
 * o espelho parece configurado e não mapeia paciente nenhum, sem ninguém perceber. Nenhum teste
 * da F4 pegava isso: todos exercitavam o MECANISMO com dado sintético, e o mecanismo estava certo.
 * O que estava errado era o CONTEÚDO — e conteúdo errado passa por qualquer teste de mecanismo.
 *
 * A régua aqui é POSITIVA: cada linha do mapa é confrontada com a lista real, e a lista real é
 * confrontada com o mapa (para acusar rótulo novo que a operação criar no ClickUp).
 */
import { Pool } from 'pg';

/**
 * As 10 opções do dropdown, LIDAS da API do ClickUp em 04/09/2026:
 *   GET https://api.clickup.com/api/v2/list/901304883903/field
 *   → campo "Tipo de Patología" (type=drop_down), `type_config.options[].name`
 *
 * ⚠️ Se a operação acrescentar ou renomear uma opção no ClickUp, este teste falha — e é isso que
 * se quer: o mapa precisa saber que mudou. Recapturar pela API, nunca editar de cabeça.
 */
const OPCOES_REAIS_DO_CLICKUP = [
  'Psicosis',
  'Trastorno Alimentario',
  'Trastorno Bipolaridad',
  'Trastorno de Ansiedad',
  'Trastorno de Discapacidad Intelectual',
  'Trastorno Depresivo',
  'Trastorno Neurológico',
  'Trastorno Opositor Desafiante',
  'Trastorno Psicológico',
  'Trastorno Psiquiátrico',
] as const;

/**
 * ⚖️ Decisão de PRODUTO pendente (Ana/Marcel), não lacuna de engenharia: os dois são genéricos e
 * o único alvo defensável para ambos seria o mesmo código de capítulo (`6E8Z`). Mapear duas opções
 * DISTINTAS do dropdown para o MESMO código apaga uma distinção que a operação escolheu fazer.
 * Enquanto não houver decisão, caem no caminho "não mapeado": não gravam nada e ficam registrados.
 */
const AGUARDANDO_DECISAO = ['Trastorno Psicológico', 'Trastorno Psiquiátrico'] as const;

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';

describe('mapa Tipo de Patología → CID-11: só rótulo REAL, e sempre resolvível', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  it('todo rótulo do mapa EXISTE no dropdown do ClickUp (pega rótulo inventado)', async () => {
    const { rows } = await pool.query<{ label: string }>(
      `SELECT label FROM clickup_diagnosis_labels WHERE source = 'clickup' AND active ORDER BY label`,
    );
    const noMapa = rows.map((r) => r.label);
    expect(noMapa.length).toBeGreaterThan(0); // contagem zero é falha, nunca sucesso

    const inventados = noMapa.filter((l) => !OPCOES_REAIS_DO_CLICKUP.includes(l as never));
    expect(inventados).toEqual([]);
  });

  it('todo rótulo do mapa aponta para uma entidade que EXISTE no catálogo e é diagnosticável', async () => {
    const { rows } = await pool.query<{ label: string; code: string | null; kind: string | null }>(
      `SELECT l.label, e.code, e.kind
         FROM clickup_diagnosis_labels l
         LEFT JOIN terminology.icd_entities e
           ON e.icd_uri = l.concept_uri AND e.release = '2026-01'
        WHERE l.source = 'clickup' AND l.active`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.code === null).map((r) => r.label)).toEqual([]);
    // `kind='stem'`: capítulo e extensão não são diagnóstico (RecordPatientDiagnosis devolve 422)
    expect(rows.filter((r) => r.kind !== 'stem').map((r) => r.label)).toEqual([]);
  });

  it('o que NÃO está mapeado é exatamente o que aguarda decisão de produto — nem mais, nem menos', async () => {
    const { rows } = await pool.query<{ label: string }>(
      `SELECT label FROM clickup_diagnosis_labels WHERE source = 'clickup' AND active`,
    );
    const mapeados = new Set(rows.map((r) => r.label));
    const faltando = OPCOES_REAIS_DO_CLICKUP.filter((o) => !mapeados.has(o));
    // Se um rótulo NOVO aparecer no ClickUp, ele cai aqui e o teste falha — que é o alarme certo.
    expect([...faltando].sort()).toEqual([...AGUARDANDO_DECISAO].sort());
  });
});
