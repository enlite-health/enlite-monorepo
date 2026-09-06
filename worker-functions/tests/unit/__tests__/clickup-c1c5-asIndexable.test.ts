/**
 * FIXTURE C4 — `asIndexable`, o guard da C5 e o formato de aviso da C1.
 *
 * ── REGISTRO DE ACESSO (C7 do parecer do `lex` de 23/08/2026) ────────────────
 *   Autorizado por: Gabriel — task 1.3 da change `campos-admissao`, execução do
 *     parecer CONDICIONADO `medicoes/campos-admissao/fase1/parecer-lex-asindexable.md`.
 *   O que esta fixture lê: NADA. Zero rede, zero banco, zero API do ClickUp,
 *     zero ficha de paciente. O `ClickUpFieldResolver` real é montado com um
 *     `fetchImpl` falso que devolve um catálogo 100% SINTÉTICO, escrito aqui dentro.
 *   Identidade de token: NENHUMA. `token` é a string literal 'token-sintetico';
 *     `CLICKUP_API_TOKEN` não é lido (é passado por `opts.token`).
 *   Nada foi gravado, nada há para apagar.
 *
 * ── POR QUE ELA EXISTE (C4 do parecer) ───────────────────────────────────────
 *   A medição anterior (`medicoes/campos-admissao/fase1/medicao-asindexable.txt`)
 *   rodava contra um `makeResolver` ARTESANAL — o instrumento confirmava a si
 *   mesmo (D157). Como a resposta desta fixture é o que dispara — ou não — o dever
 *   de retificação do art. 16 da Ley 25.326, ela roda contra a CLASSE REAL.
 *
 * ── O QUE ELA PROVA ──────────────────────────────────────────────────────────
 *   C1  o valor cru de campo clínico NÃO entra em log, nos DOIS formatos que
 *       passam por ali: o orderindex (hoje) e o uuid de opção / array (Fase 2).
 *       Com CONTROLE POSITIVO: sem ele, "nenhuma linha contém a sentinela" pode
 *       significar apenas que o espião está morto (D157/F19).
 *   C5  o guard é lista de permissão, não guard de array: `[]`, `''`, `'   '`,
 *       `false`, `{}`, `NaN`, `Infinity` e `['uuid']` NÃO fabricam mais o
 *       orderindex 0 — que é a 1ª opção do catálogo clínico.
 */

import { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpTask, ClickUpTaskCustomField } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { completaCatalogo } from '../../fixtures/clickup/completaCatalogo';

// ── Sentinelas ────────────────────────────────────────────────────────────────
// Strings/números que NÃO podem aparecer em nenhuma linha de log emitida.
const SENTINELA_LABEL = 'SENTINELA-CLINICO-XYZ';                     // o rótulo resolvido
const SENTINELA_UUID  = 'SENTINELA-UUID-4f2a-9c11-000000000001';     // formato Fase 2 (labels)
const SENTINELA_INDEX = 987654321;                                   // formato de hoje (orderindex)

// ── Catálogo SINTÉTICO devolvido pelo fetch falso ─────────────────────────────
// orderindex 0 do campo clínico é a opção que a coerção fabricava.
const PRIMEIRA_OPCAO_CLINICA = 'AT para Pacientes con Discapacidad Intelectual';

const CATALOGO_SINTETICO = {
  fields: completaCatalogo([
    {
      id: 'cf-1', name: 'Segmentos Clínicos', type: 'drop_down',
      type_config: { options: [
        { id: 'o-0', name: PRIMEIRA_OPCAO_CLINICA, orderindex: 0 },
        { id: 'o-1', name: 'AT para Pacientes con TEA',       orderindex: 1 },
        // Opção existente no ClickUp mas AUSENTE do mapa: resolve e cai no fallback do mapa.
        { id: 'o-7', name: SENTINELA_LABEL,                    orderindex: 7 },
      ] },
    },
    { id: 'cf-2', name: 'Dependencia', type: 'drop_down',
      type_config: { options: [{ id: 'd-0', name: 'GRAVE', orderindex: 0 }] } },
    { id: 'cf-3', name: 'Sexo Asignado al Nacer (Uso Clínico)', type: 'drop_down',
      type_config: { options: [{ id: 's-0', name: 'Femenino', orderindex: 0 }] } },
    { id: 'cf-4', name: 'Servicio', type: 'drop_down',
      type_config: { options: [{ id: 'v-0', name: 'Acompañante Terapéutico', orderindex: 0 }] } },
    { id: 'cf-5', name: 'Tipo de Documento Paciente', type: 'drop_down',
      type_config: { options: [{ id: 't-0', name: 'DNI', orderindex: 0 }] } },
    { id: 'cf-6', name: 'Relación con el Paciente', type: 'drop_down',
      type_config: { options: [{ id: 'r-0', name: 'Hijo / Hija', orderindex: 0 }] } },
    { id: 'cf-7', name: 'Tipo de Documento Responsable', type: 'drop_down',
      type_config: { options: [{ id: 'u-0', name: 'DNI', orderindex: 0 }] } },
    // Task 1.12: o 8º `drop_down` declarado — o preflight da 1.11 exige que ele exista no
    // catálogo. Fixture, não asserção: nenhum caso deste arquivo mudou.
    { id: 'cf-8', name: 'Equipo Tratante Multidisciplinario', type: 'drop_down',
      type_config: { options: [{ id: 'e-0', name: 'No', orderindex: 0 }] } },
  ] as never),
};

let fetchChamadas = 0;
const fetchFalso = (async () => {
  fetchChamadas += 1;
  return {
    ok: true, status: 200, statusText: 'OK',
    json: async () => CATALOGO_SINTETICO,
  } as unknown as Response;
}) as unknown as typeof fetch;

// ── Espião de console.warn ────────────────────────────────────────────────────
let linhas: string[] = [];
let spy: jest.SpyInstance;

function serializa(args: unknown[]): string {
  return args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

/** O DETECTOR. É ele que o controle positivo tem de acusar. */
function linhasComSentinela(): string[] {
  const agulhas = [SENTINELA_LABEL, SENTINELA_UUID, String(SENTINELA_INDEX)];
  return linhas.filter(l => agulhas.some(a => l.includes(a)));
}

beforeEach(() => {
  linhas = [];
  spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    linhas.push(serializa(args));
  });
});

afterEach(() => spy.mockRestore());

// ── Task sintética ────────────────────────────────────────────────────────────
function tarefa(campos: Array<{ name: string; value: unknown }>): ClickUpTask {
  return {
    id: 'sintetico-1',
    name: 'SOBRENOME, Nome',
    status: { status: 'activo', color: '#000', type: 'custom' },
    parent: null,
    custom_fields: campos.map(f => ({
      id: `cf-${f.name}`, name: f.name, type: 'drop_down', value: f.value,
    })) as ClickUpTaskCustomField[],
    url: 'https://app.clickup.com/t/sintetico-1',
    date_created: '1700000000000',
    date_updated: '1700100000000',
  };
}

async function mapperReal(): Promise<ClickUpPatientMapper> {
  const resolver = await ClickUpFieldResolver.fromList('lista-sintetica', {
    token: 'token-sintetico',
    fetchImpl: fetchFalso,
  });
  expect(resolver).toBeInstanceOf(ClickUpFieldResolver);   // C4: a classe REAL
  return new ClickUpPatientMapper(resolver);
}

function mapa(m: ClickUpPatientMapper, valorSegmento: unknown) {
  return m.map(tarefa([
    { name: 'Nombre de Paciente', value: 'Nome' },
    { name: 'Segmentos Clínicos', value: valorSegmento },
  ]));
}

// ─────────────────────────────────────────────────────────────────────────────
describe('C4 — a fixture roda contra a classe real', () => {
  it('monta o ClickUpFieldResolver real com fetchImpl falso, sem rede', async () => {
    const antes = fetchChamadas;
    await mapperReal();
    console.log(`>>> C4 | ClickUpFieldResolver REAL montado | fetchImpl falso chamado ${fetchChamadas - antes}x | rede: 0`);
    expect(fetchChamadas).toBe(antes + 1);
  });
});

describe('C1 — CONTROLE POSITIVO do espião e do detector', () => {
  it('o detector ACUSA a sentinela quando ela está presente (se falhasse aqui, o teste da C1 não valeria nada)', () => {
    // Emissão DELIBERADA no formato PROIBIDO — é exatamente o que a C1 barra.
    console.warn('[CONTROLE POSITIVO — formato proibido de propósito]', {
      field: 'Segmentos Clínicos', label: SENTINELA_LABEL, optionId: SENTINELA_UUID, orderindex: SENTINELA_INDEX,
    });
    const achadas = linhasComSentinela();
    console.log(`>>> CONTROLE POSITIVO | linhas capturadas=${linhas.length} | detector achou=${achadas.length} (esperado >0)`);
    console.log(`>>> CONTROLE POSITIVO | linha acusada: ${achadas[0]}`);
    expect(linhas.length).toBeGreaterThan(0);   // o espião está vivo
    expect(achadas.length).toBeGreaterThan(0);  // o detector enxerga a sentinela
  });
});

describe('C1 — o valor cru de campo clínico NÃO entra em log', () => {
  it('FORMATO 1 (hoje): orderindex numérico não reconhecido', async () => {
    const m = await mapperReal();
    linhas = [];
    const r = mapa(m, SENTINELA_INDEX);
    const achadas = linhasComSentinela();
    console.log(`>>> C1/orderindex | derivado=${JSON.stringify(r?.clinicalSpecialty)} | avisos=${linhas.length} | com sentinela=${achadas.length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(linhas.length).toBeGreaterThan(0);   // contagem zero seria espião morto, não sucesso
    expect(achadas).toEqual([]);
    expect(r?.clinicalSpecialty).toBeNull();
  });

  it('FORMATO 2 (Fase 2): array de uuid de opção', async () => {
    const m = await mapperReal();
    linhas = [];
    const r = mapa(m, [SENTINELA_UUID, SENTINELA_UUID]);
    const achadas = linhasComSentinela();
    console.log(`>>> C1/array-uuid | derivado=${JSON.stringify(r?.clinicalSpecialty)} | avisos=${linhas.length} | com sentinela=${achadas.length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(linhas.length).toBeGreaterThan(0);
    expect(achadas).toEqual([]);
    expect(r?.clinicalSpecialty).toBeNull();
  });

  it('FORMATO 3: o RÓTULO RESOLVIDO de opção que existe no ClickUp e não está no mapa', async () => {
    const m = await mapperReal();
    linhas = [];
    // orderindex 7 resolve para SENTINELA_LABEL no catálogo sintético e cai no
    // fallback do clinicalSpecialtyMap — é o caminho que logava o rótulo.
    const r = mapa(m, 7);
    const achadas = linhasComSentinela();
    console.log(`>>> C1/rotulo | derivado=${JSON.stringify(r?.clinicalSpecialty)} | avisos=${linhas.length} | com sentinela=${achadas.length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(linhas.length).toBeGreaterThan(0);
    expect(achadas).toEqual([]);
    expect(r?.clinicalSpecialty).toBeNull();
  });

  it('nenhum aviso carrega o identificador do paciente (task.id)', async () => {
    const m = await mapperReal();
    linhas = [];
    mapa(m, SENTINELA_INDEX);
    const comId = linhas.filter(l => l.includes('sintetico-1'));
    console.log(`>>> C1/task.id | avisos=${linhas.length} | com task.id=${comId.length} (esperado 0)`);
    expect(linhas.length).toBeGreaterThan(0);
    expect(comId).toEqual([]);
  });
});

describe('C5 — as portas da fabricação, contra a classe real', () => {
  // CONTROLE POSITIVO da fixture: com orderindex 0 LEGÍTIMO o derivado SAI.
  // Sem isto, "todas as portas dão null" poderia ser só um mapper quebrado.
  it('CONTROLE POSITIVO: orderindex 0 legítimo produz o derivado (o instrumento consegue produzir não-nulo)', async () => {
    const m = await mapperReal();
    linhas = [];
    const r = mapa(m, 0);
    console.log(`>>> C5/controle | valor=0 (number) → derivado=${JSON.stringify(r?.clinicalSpecialty)} | avisos=${linhas.length}`);
    expect(r?.clinicalSpecialty).toBe('INTELLECTUAL_DISABILITY');
    expect(linhas.length).toBe(0);   // valor válido não grita (sabotagem, lado A)
  });

  it("CONTROLE POSITIVO: string numérica '0' também é aceita pela lista de permissão", async () => {
    const m = await mapperReal();
    linhas = [];
    const r = mapa(m, '0');
    console.log(`>>> C5/controle | valor='0' (string numérica) → derivado=${JSON.stringify(r?.clinicalSpecialty)} | avisos=${linhas.length}`);
    expect(r?.clinicalSpecialty).toBe('INTELLECTUAL_DISABILITY');
    expect(linhas.length).toBe(0);
  });

  const PORTAS: Array<[string, unknown]> = [
    ['array vazio        []', []],
    ['array de uuid      [uuid]', ['uuid-a', 'uuid-b']],
    ["string vazia       ''", ''],
    ["string em branco   '   '", '   '],
    ['false', false],
    ['objeto vazio       {}', {}],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ["string não-numérica 'abc'", 'abc'],
  ];

  it.each(PORTAS)('porta %s → null, com aviso, e SEM fabricar a 1ª opção', async (rotulo, valor) => {
    const m = await mapperReal();
    linhas = [];
    const r = mapa(m, valor);
    console.log(`>>> C5 | ${String(rotulo).padEnd(28)} → derivado=${JSON.stringify(r?.clinicalSpecialty)} | avisos=${linhas.length} | ${linhas[0] ?? '(sem aviso)'}`);
    expect(r?.clinicalSpecialty).toBeNull();       // não fabricou
    expect(linhas.length).toBeGreaterThan(0);      // e não caiu calado
    expect(linhasComSentinela()).toEqual([]);      // nem vazou nada
  });

  it('ausente e null continuam CALADOS — é a única forma de vazio que a API entrega (1424/1690)', async () => {
    const m = await mapperReal();
    linhas = [];
    const ausente = m.map(tarefa([{ name: 'Nombre de Paciente', value: 'Nome' }]));
    const avisosAusente = linhas.length;
    linhas = [];
    const nulo = mapa(m, null);
    console.log(`>>> C5/vazio legítimo | ausente → ${JSON.stringify(ausente?.clinicalSpecialty)} avisos=${avisosAusente} | null → ${JSON.stringify(nulo?.clinicalSpecialty)} avisos=${linhas.length}`);
    expect(ausente?.clinicalSpecialty).toBeNull();
    expect(nulo?.clinicalSpecialty).toBeNull();
    expect(avisosAusente).toBe(0);
    expect(linhas.length).toBe(0);
  });
});
