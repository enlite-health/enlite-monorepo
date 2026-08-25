/**
 * 1.12 — os nomes de campo que o mapper pede × o catálogo VIVO do ClickUp
 * (change `campos-admissao`, achado do QA-caça de 23/08).
 *
 * ── O DEFEITO, nas duas metades ───────────────────────────────────────────────
 *
 * (a) `Equipo Tratante Multidisciplinario` é `drop_down` vivo, o mapper depende dele
 *     (`buildProfessionals` → `isTeam`) e ele ficou FORA de `PATIENT_DROPDOWN_FIELDS`.
 *     Renomeá-lo no ClickUp derrubava `isTeam` para `false` em TODOS os pacientes, calado,
 *     sem disparar o preflight da 1.11 — e `patient_professionals` é DELETE + INSERT.
 *
 * (b) Seis nomes que o mapper pedia e o catálogo não tem: `Cobertura Informada` (o vivo é
 *     `'Cobertura Informada '`, com espaço no fim), `Apellido de Responsable`,
 *     `Email del Responsable`, `Número de Documento Responsable` e
 *     `Domicilio 2/3 Principal Paciente`. Cada um devolvia `undefined` para TODA tarefa, sem
 *     um único aviso. NÃO há dado perdido a recuperar: o sync é o único escritor de
 *     `patient_responsibles`, então esses campos nunca preencheram — é a causa do F5
 *     (`health_insurance_name` = 1 de 366), não uma perda.
 *
 * ── POR QUE A TRAVA ANTIGA NÃO PEGAVA, E O QUE MUDOU AQUI ────────────────────
 *
 * A trava de deriva da 1.11 varre o FONTE atrás de `resolveDropdown\(\s*'([^']+)'`. O campo da
 * metade (a) é `drop_down` mas não passa por `resolveDropdown` — logo, invisível. Régua que
 * enxerga UM padrão sintático deixa passar o próximo campo pelo mesmo motivo (D155/D160).
 *
 * O fecho da CLASSE, aqui, tem dois lados:
 *   1. QUEM PERGUNTA: o `Proxy` de `buildCustomFieldMap` anota cada nome PEDIDO em tempo de
 *      execução — pedido, não encontrado, e independente de quem lê (`resolveDropdown`,
 *      `asString`, `parseClickUpBoolean`, nome vindo de variável ou de laço).
 *   2. QUEM DECIDE: a obrigação de declarar passa a vir do CATÁLOGO — se o campo pedido é
 *      `drop_down` lá, ele TEM de estar em `PATIENT_DROPDOWN_FIELDS`. Não é mais a função que
 *      o lê que decide.
 *
 * Dois harvesters independentes (runtime + fonte) e a UNIÃO deles é o conjunto verificado: se
 * um morrer, o outro ainda enxerga, e a contagem de cada um aparece na saída (D157/F19).
 *
 * ── LIMITE DECLARADO ──────────────────────────────────────────────────────────
 * O catálogo é uma FOTO (`tests/fixtures/clickup/catalogo-pacientes-fase0.ts`, medição de
 * 23/08). Papel não chama a API do ClickUp. Este teste prova que código e foto casam; ele não
 * pode provar que a foto é o ClickUp de hoje.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import {
  ClickUpPatientMapper,
  PATIENT_DROPDOWN_FIELDS,
} from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { ClickUpUnreadableFieldError } from '../../../src/modules/integration/infrastructure/clickup/helpers/dropdownCatalogGuard';
import { CATALOG_TYPES_SUPPORTED } from '../../../src/modules/integration/infrastructure/clickup/helpers/resolveCatalogValue';
import type { ClickUpTask, ClickUpTaskCustomField } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import {
  CATALOGO_PACIENTES_FASE0,
  type ClickUpCatalogField,
} from '../../fixtures/clickup/catalogo-pacientes-fase0';

// ── Os nomes ERRADOS de antes desta task — usados como CONTROLE POSITIVO ──────
const NOMES_ERRADOS_ANTES_DA_1_12 = [
  'Apellido de Responsable',
  'Email del Responsable',
  'Número de Documento Responsable',
  'Domicilio 2 Principal Paciente',
  'Domicilio 3 Principal Paciente',
] as const;

/** O 8º campo — a metade (a). */
const CAMPO_DA_EQUIPE = 'Equipo Tratante Multidisciplinario';

/** Valor clínico plantado. C1/lex: não pode aparecer em NENHUMA linha de log. */
const SENTINELA_CLINICO = 'SENTINELA-CLINICO-XYZ';

const FONTE_DO_MAPPER = path.join(
  __dirname,
  '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts',
);

// ── Catálogo → resposta da rota /field (o resolver REAL consome isto) ─────────

function respostaDoCatalogo(campos: readonly ClickUpCatalogField[]) {
  return {
    fields: campos.map((f, i) => ({
      id: `cf-${i}`,
      name: f.name,
      type: f.type,
      type_config:
        f.type === 'drop_down' || f.type === 'labels'
          ? { options: [{ id: `op-${i}`, name: `OPCAO-SINTETICA-${i}`, orderindex: 1 }] }
          : {},
    })),
  };
}

async function resolverReal(campos: readonly ClickUpCatalogField[]): Promise<ClickUpFieldResolver> {
  const fetchFalso = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => respostaDoCatalogo(campos),
  })) as unknown as typeof fetch;

  const resolver = await ClickUpFieldResolver.fromList('lista-sintetica', {
    token: 'token-sintetico',
    fetchImpl: fetchFalso,
  });
  expect(resolver).toBeInstanceOf(ClickUpFieldResolver); // a CLASSE real, não um stub meu
  return resolver;
}

/** O catálogo com UM campo renomeado — a sabotagem que o preflight tem de pegar. */
function catalogoComRenome(de: string, para: string): ClickUpCatalogField[] {
  const out = CATALOGO_PACIENTES_FASE0.map(f => (f.name === de ? { name: para, type: f.type } : { ...f }));
  expect(out.some(f => f.name === para)).toBe(true); // a sabotagem existe mesmo
  return out;
}

// ── Tarefa sintética: TODO campo do catálogo, com valor do tipo certo ─────────
// Valores inventados. Nenhuma ficha real, nenhum id de paciente do ClickUp.

function valorSintetico(campo: ClickUpCatalogField): unknown {
  switch (campo.type) {
    case 'location':   return { formatted_address: `RUA SINTETICA ${campo.name}`, lat: -34.6, lng: -58.4 };
    case 'date':       return '1700000000000';
    case 'number':     return '1';
    case 'checkbox':   return 'true';
    case 'labels':     return [];
    case 'drop_down':  return '1';
    default:           return `SINTETICO-${campo.name.trim()}`;
  }
}

function tarefaComTodoOCatalogo(campos: readonly ClickUpCatalogField[]): ClickUpTask {
  return tarefa(
    campos.map(c => ({ name: c.name, value: valorSintetico(c), type: c.type })),
  );
}

function tarefa(campos: { name: string; value: unknown; type?: string }[]): ClickUpTask {
  return {
    id: 'sintetica-1-12',
    name: 'SOBRENOME-SINTETICO, NOME-SINTETICO',
    status: { status: 'activo', color: '#000', type: 'custom' },
    parent: null,
    custom_fields: campos.map((f, i) => ({
      id: `cft-${i}`,
      name: f.name,
      type: f.type ?? 'short_text',
      value: f.value,
    })) as ClickUpTaskCustomField[],
    url: 'https://app.clickup.com/t/sintetica-1-12',
    date_created: '1700000000000',
    date_updated: '1700100000000',
  };
}

// ── Os dois harvesters ────────────────────────────────────────────────────────

/** (1) RUNTIME: o que o mapper PEDIU ao mapa de custom fields, medido enquanto ele roda. */
async function nomesPedidosEmRuntime(): Promise<string[]> {
  const mapper = new ClickUpPatientMapper(await resolverReal(CATALOGO_PACIENTES_FASE0));
  const resultado = mapper.map(tarefaComTodoOCatalogo(CATALOGO_PACIENTES_FASE0));
  expect(resultado).not.toBeNull(); // se o map() devolvesse null, nada teria sido lido
  return [...mapper.getRequestedFieldNames()];
}

/**
 * Tira COMENTÁRIO do fonte antes de varrer. Sem isto, o `cf['<old name>']` que mora no
 * docstring de `PATIENT_DROPDOWN_FIELDS` entra na lista como se fosse campo pedido — foi o
 * mesmo ruído que o QA-caça teve de descontar à mão ao medir. Ruído em harvester não é
 * inofensivo: ele produz acusação falsa e ensina quem lê a ignorar a régua.
 */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

/**
 * Os padrões que a varredura sintática conhece. Os TRÊS de `slot` existem porque o mapper lê
 * `cf[slot.nameCf]` — nome vindo de VARIÁVEL. Cada padrão novo desses é uma regra escrita à mão
 * DEPOIS que alguém percebeu o buraco; é exatamente assim que a trava anterior ficou cega.
 */
const PADROES_DE_SLOT = [
  /\bnameCf:\s*'([^']+)'/g,
  /\bphoneCf:\s*'([^']+)'/g,
  /\bemailCf:\s*'([^']+)'/g,
];

/** (2) FONTE: os literais do arquivo. Instrumento independente do de cima. */
function nomesPedidosNoFonte(comPadroesDeSlot = true): string[] {
  const fonte = semComentarios(fs.readFileSync(FONTE_DO_MAPPER, 'utf-8'));
  const padroes = [
    /cf\['([^']+)'\]/g,          // cf['Nombre de Paciente']
    /f\.name === '([^']+)'/g,    // extractCaseNumber
    /resolveDropdown\(\s*'([^']+)'/g,
    ...(comPadroesDeSlot ? PADROES_DE_SLOT : []),
  ];
  const out = new Set<string>();
  for (const p of padroes) for (const m of fonte.matchAll(p)) out.add(m[1]);
  return [...out];
}

// ── O cruzamento (é ele que tem de ACUSAR no controle positivo) ───────────────

const CATALOGO_POR_NOME_APARADO = new Map(
  CATALOGO_PACIENTES_FASE0.map(f => [f.name.trim(), f.type]),
);

/**
 * O tipo que o catálogo dá ao nome pedido, ou `null` se o catálogo não tem esse campo.
 * A comparação apara as pontas dos DOIS lados — é a mesma regra que
 * `buildCustomFieldMap` aplica em runtime (o alias sem espaço). Se as duas regras
 * divergissem, este teste passaria e a produção continuaria lendo `undefined`.
 */
function tipoNoCatalogo(nomePedido: string): string | null {
  return CATALOGO_POR_NOME_APARADO.get(nomePedido.trim()) ?? null;
}

function foraDoCatalogo(nomes: readonly string[]): string[] {
  return nomes.filter(n => tipoNoCatalogo(n) === null).sort();
}

/**
 * ⚠️ DEFEITO 5 do QA-caça da 2.2 (2ª rodada): a régua era condicionada a
 * `tipoNoCatalogo(n) === 'drop_down'` — e esta fase é justamente a que TIRA
 * `Segmentos Clínicos` de `drop_down`. Medido pelo QA: com o catálogo em `drop_down` a régua
 * acusa o campo removido da lista declarada; com o catálogo em `labels` — o mundo que a
 * Fase 2 constrói — ela fica MUDA. Depois da virada, tirar o campo mais clínico do preflight
 * não acenderia nada.
 *
 * A pergunta certa nunca foi "é `drop_down`?". É **"é um tipo que o mapper sabe ler de
 * catálogo?"**, e essa lista já existe e é UMA (`CATALOG_TYPES_SUPPORTED`) — a mesma que o
 * despacho de `resolveCatalogValue` usa. Uma segunda lista aqui divergiria em silêncio, que é
 * o F20/F49/F51 desta casa.
 */
function tipoDeCatalogoLegivel(nomePedido: string, tipo = tipoNoCatalogo(nomePedido)): boolean {
  return tipo !== null && (CATALOG_TYPES_SUPPORTED as readonly string[]).includes(tipo);
}

function catalogoNaoDeclarados(
  nomes: readonly string[],
  declarados: readonly string[],
  tipoDe: (n: string) => string | null = tipoNoCatalogo,
): string[] {
  return nomes.filter(n => tipoDeCatalogoLegivel(n, tipoDe(n)) && !declarados.includes(n)).sort();
}

// ── Espião de console.warn ────────────────────────────────────────────────────

let linhas: string[] = [];
let spyWarn: jest.SpyInstance;

beforeEach(() => {
  linhas = [];
  spyWarn = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    linhas.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
});

afterEach(() => spyWarn.mockRestore());

// ─────────────────────────────────────────────────────────────────────────────

describe('1.12 — os nomes que o mapper pede casam com o catálogo vivo, e todo drop_down pedido é declarado', () => {
  it('a foto do catálogo é a medição da fase 0, com o espaço no fim preservado', () => {
    const comEspaco = CATALOGO_PACIENTES_FASE0.filter(f => f.name !== f.name.trim()).map(f => f.name);
    console.log(
      `>>> 1.12/catálogo | campos=${CATALOGO_PACIENTES_FASE0.length} | drop_down=${
        CATALOGO_PACIENTES_FASE0.filter(f => f.type === 'drop_down').length
      } | nomes com espaço nas pontas=${JSON.stringify(comEspaco)}`,
    );
    expect(CATALOGO_PACIENTES_FASE0).toHaveLength(74); // a fase 1 mediu 74 na mesma rota
    expect(comEspaco).toEqual(['Cobertura Informada ']); // o ⚠ do F15, vivo na foto
  });

  it('CRUZAMENTO: todo nome que o mapper pede existe no catálogo — com controle positivo', async () => {
    const runtime = await nomesPedidosEmRuntime();
    const fonte = nomesPedidosNoFonte();
    const pedidos = [...new Set([...runtime, ...fonte])].sort();
    const ausentes = foraDoCatalogo(pedidos);

    console.log(
      `>>> 1.12/cruzamento | pedidos=${pedidos.length} (runtime=${runtime.length} | fonte=${fonte.length} | só no runtime=${
        JSON.stringify(runtime.filter(n => !fonte.includes(n)))
      } | só no fonte=${JSON.stringify(fonte.filter(n => !runtime.includes(n)))}) | catálogo=${
        CATALOGO_PACIENTES_FASE0.length
      } | FORA DO CATÁLOGO=${ausentes.length} ${JSON.stringify(ausentes)}`,
    );

    // Contagem zero é falha, nunca sucesso (F19): os dois instrumentos têm de ter medido algo.
    expect(runtime.length).toBeGreaterThan(0);
    expect(fonte.length).toBeGreaterThan(0);
    expect(pedidos.length).toBeGreaterThan(30);

    // CONTROLE POSITIVO: o MESMO cruzamento, sobre os nomes de ANTES desta task + 1 inventado.
    const controle = [...NOMES_ERRADOS_ANTES_DA_1_12, 'Cobertura Informada Que Nao Existe'];
    const acusados = foraDoCatalogo(controle);
    console.log(`>>> 1.12/cruzamento/controle+ | entradas=${controle.length} | acusadas=${acusados.length} ${JSON.stringify(acusados)}`);
    expect(acusados).toHaveLength(controle.length); // o cruzamento ACUSA quando há o que acusar

    // E só então a diferença vazia vale alguma coisa.
    expect(ausentes).toEqual([]);
  });

  it('os nomes pedidos são canônicos (aparados) — o alias sem espaço é o que casa com o vivo', async () => {
    const pedidos = [...new Set([...(await nomesPedidosEmRuntime()), ...nomesPedidosNoFonte()])];
    const comEspaco = pedidos.filter(n => n !== n.trim());
    console.log(`>>> 1.12/canônico | pedidos com espaço nas pontas=${comEspaco.length} ${JSON.stringify(comEspaco)}`);
    expect(pedidos.length).toBeGreaterThan(0);
    expect(comEspaco).toEqual([]);
  });

  it('o harvester de RUNTIME enxerga nome vindo de VARIÁVEL; a varredura de fonte só com regra dedicada', async () => {
    const runtime = await nomesPedidosEmRuntime();
    const fonteCompleta = nomesPedidosNoFonte(true);
    const fonteSemRegraDeSlot = nomesPedidosNoFonte(false);

    // CONTROLE POSITIVO da cegueira: tirando as 3 regras escritas à mão para `slot.*Cf`, a
    // varredura de fonte PERDE campos que o mapper lê de verdade — e o runtime não perde nenhum.
    const perdidosPelaFonte = fonteCompleta.filter(n => !fonteSemRegraDeSlot.includes(n)).sort();
    const perdidosPeloRuntime = perdidosPelaFonte.filter(n => !runtime.includes(n));

    console.log(
      `>>> 1.12/variável | fonte com regra de slot=${fonteCompleta.length} | sem=${fonteSemRegraDeSlot.length}` +
      ` | a fonte perde ${perdidosPelaFonte.length} ${JSON.stringify(perdidosPelaFonte.slice(0, 3))}…` +
      ` | desses, o runtime perde=${perdidosPeloRuntime.length}`,
    );

    expect(perdidosPelaFonte.length).toBeGreaterThan(0); // contagem zero não provaria nada
    expect(perdidosPeloRuntime).toEqual([]);
  });

  it('FECHO DA CLASSE: todo campo pedido de um tipo de catálogo LEGÍVEL está declarado — com controle positivo', async () => {
    const pedidos = [...new Set([...(await nomesPedidosEmRuntime()), ...nomesPedidosNoFonte()])];
    const declarados = PATIENT_DROPDOWN_FIELDS as readonly string[];

    const catalogoPedidos = pedidos.filter(n => tipoDeCatalogoLegivel(n)).sort();
    const naoDeclarados = catalogoNaoDeclarados(pedidos, declarados);
    const declaradosQueNinguemPede = declarados.filter(n => !pedidos.includes(n)).sort();

    console.log(
      `>>> 1.12/fecho | tipos legíveis=${JSON.stringify([...CATALOG_TYPES_SUPPORTED])} | pedidos de catálogo=${catalogoPedidos.length} | declarados=${declarados.length} | pedidos e NÃO declarados=${
        naoDeclarados.length
      } ${JSON.stringify(naoDeclarados)} | declarados que ninguém pede=${declaradosQueNinguemPede.length}`,
    );

    expect(catalogoPedidos.length).toBeGreaterThan(0); // contagem zero seria instrumento morto
    expect(naoDeclarados).toEqual([]);
    expect(declaradosQueNinguemPede).toEqual([]); // declarar campo que ninguém lê para o sync à toa

    // CONTROLE POSITIVO — é literalmente o defeito (a): a MESMA régua, com o 8º campo fora da
    // lista declarada, tem de acusar exatamente ele. Nenhuma varredura de `resolveDropdown`
    // conseguia: este campo não passa por lá.
    const semOOitavo = declarados.filter(n => n !== CAMPO_DA_EQUIPE);
    const acusados = catalogoNaoDeclarados(pedidos, semOOitavo);
    console.log(`>>> 1.12/fecho/controle+ | com o 8º campo removido da lista → acusados=${JSON.stringify(acusados)}`);
    expect(acusados).toEqual([CAMPO_DA_EQUIPE]);
  });

  /**
   * ⚠️ DEFEITO 5 do QA-caça da 2.2 (2ª rodada), medido: a régua acima ficava MUDA no mundo
   * que esta fase constrói. O QA rodou a mesma simulação nos dois catálogos e obteve
   * `a régua da 1.12 ACUSA? true` com `drop_down` e `false` com `labels`.
   *
   * Este teste é essa medição virada em régua permanente: a acusação tem de ser IDÊNTICA nos
   * dois mundos. Se alguém voltar a condicionar a régua a um tipo, o mundo `labels` reprova.
   */
  it('DEFEITO 5: a régua acusa IGUAL depois da virada para `labels` (a 2ª metade do mundo desta fase)', async () => {
    const pedidos = [...new Set([...(await nomesPedidosEmRuntime()), ...nomesPedidosNoFonte()])];
    const declarados = PATIENT_DROPDOWN_FIELDS as readonly string[];
    const CAMPO_DA_FASE = 'Segmentos Clínicos';
    const semOCampoDaFase = declarados.filter(n => n !== CAMPO_DA_FASE);

    for (const tipoVirado of ['drop_down', 'labels'] as const) {
      // O catálogo do dia: igual ao vivo, com UM campo virado — é a virada da D-C.
      const tipoDe = (n: string): string | null =>
        n.trim() === CAMPO_DA_FASE ? tipoVirado : tipoNoCatalogo(n);

      const aindaDeclarado = catalogoNaoDeclarados(pedidos, declarados, tipoDe);
      const acusados       = catalogoNaoDeclarados(pedidos, semOCampoDaFase, tipoDe);

      console.log(
        `>>> 1.12/d5 | catálogo diz que '${CAMPO_DA_FASE}' é ${tipoVirado}` +
        ` | com a lista COMPLETA acusa=${JSON.stringify(aindaDeclarado)} (esperado [])` +
        ` | com o campo FORA da lista acusa=${JSON.stringify(acusados)} (esperado ["${CAMPO_DA_FASE}"])`,
      );

      expect(aindaDeclarado).toEqual([]);            // sem falso positivo
      expect(acusados).toEqual([CAMPO_DA_FASE]);     // <<< e ACUSA nos DOIS mundos
    }
  });
});

describe('1.12 (a) — o 8º campo dispara o preflight como os outros 7', () => {
  it('CONTROLE POSITIVO: com o catálogo de hoje, nada é lançado e o campo da equipe é lido', async () => {
    const mapper = new ClickUpPatientMapper(await resolverReal(CATALOGO_PACIENTES_FASE0));
    const t = tarefa([
      { name: 'Nombre de Paciente', value: 'NOME-SINTETICO' },
      { name: 'Apellido del Paciente', value: 'SOBRENOME-SINTETICO' },
      { name: 'Profesional Tratante Principal', value: 'PROF-SINTETICO' },
      { name: CAMPO_DA_EQUIPE, value: 'true', type: 'drop_down' },
    ]);

    const out = mapper.map(t)!;
    const pediuOCampo = mapper.getRequestedFieldNames().includes(CAMPO_DA_EQUIPE);
    console.log(
      `>>> 1.12/preflight/controle+ | lançou=NAO | pediu "${CAMPO_DA_EQUIPE}"=${pediuOCampo} | isTeam=${out.professionals![0].isTeam} | avisos=${linhas.length}`,
    );
    expect(pediuOCampo).toBe(true);
    expect(out.professionals![0].isTeam).toBe(true);
    expect(linhas).toHaveLength(0);
  });

  it('renomear QUALQUER um dos campos declarados — o da equipe inclusive — para a task inteira', async () => {
    const resultados: string[] = [];

    for (const campo of PATIENT_DROPDOWN_FIELDS) {
      linhas = [];
      const renomeado = `${campo} (RENOMEADO PELO JAVIER)`;
      const mapper = new ClickUpPatientMapper(await resolverReal(catalogoComRenome(campo, renomeado)));
      const t = tarefaComTodoOCatalogo(catalogoComRenome(campo, renomeado));

      let erro: unknown = null;
      try {
        mapper.map(t);
      } catch (e) {
        erro = e;
      }

      const ok =
        erro instanceof ClickUpUnreadableFieldError &&
        erro.fields.length === 1 &&
        erro.fields[0].field === campo &&
        erro.fields[0].status === 'missing';
      resultados.push(`${ok ? 'PAROU' : 'PASSOU'}:${campo}(avisos=${linhas.length})`);

      expect(erro).toBeInstanceOf(ClickUpUnreadableFieldError);
      expect((erro as ClickUpUnreadableFieldError).fields.map(f => f.field)).toEqual([campo]);
      expect(linhas.length).toBeGreaterThan(0);
    }

    console.log(`>>> 1.12/preflight | declarados=${PATIENT_DROPDOWN_FIELDS.length} | pararam o sync=${resultados.filter(r => r.startsWith('PAROU')).length}`);
    for (const r of resultados) console.log(`>>> 1.12/preflight |   ${r}`);
    // ⚠️ O número vem da LISTA, não chumbado. Estava `8` e virou `9` quando a task 3.2
    // declarou `Cobertura Verificada` — o teste reprovou por contar, não por defeito.
    // Número chumbado aqui é uma segunda lista escrita à mão, que é o F20/F49/F51 desta casa:
    // ela diverge da primeira em silêncio, e o dia em que divergir para MENOS ninguém percebe.
    expect(resultados).toHaveLength(PATIENT_DROPDOWN_FIELDS.length);
    expect(resultados.filter(r => r.startsWith('PAROU'))).toHaveLength(PATIENT_DROPDOWN_FIELDS.length);
    expect(PATIENT_DROPDOWN_FIELDS.length).toBeGreaterThan(0);   // contagem zero reprova (F19)
  });

  it('o campo da equipe virando `labels` no ClickUp (o cenário F33) também para — wrong_type', async () => {
    const catalogo = CATALOGO_PACIENTES_FASE0.map(f =>
      f.name === CAMPO_DA_EQUIPE ? { name: f.name, type: 'labels' } : { ...f },
    );
    const mapper = new ClickUpPatientMapper(await resolverReal(catalogo));

    let erro: ClickUpUnreadableFieldError | null = null;
    try {
      mapper.map(tarefaComTodoOCatalogo(catalogo));
    } catch (e) {
      erro = e as ClickUpUnreadableFieldError;
    }

    console.log(
      `>>> 1.12/wrong_type | lançou=${erro ? 'SIM' : 'NAO'} | campo=${erro?.fields[0].field} | status=${erro?.fields[0].status} | catalogType=${erro?.fields[0].catalogType}`,
    );
    expect(erro).toBeInstanceOf(ClickUpUnreadableFieldError);
    // `expected` é a lista de tipos que o LEITOR deste campo sabe ler (defeito 1 do QA-caça da
    // 2.2): para os 7 campos comuns continua sendo só `drop_down` — a folga é de UM campo.
    expect(erro!.fields).toEqual([{ field: CAMPO_DA_EQUIPE, status: 'wrong_type', catalogType: 'labels', expected: ['drop_down'] }]);
  });

  it('C1/lex: o aviso do 8º campo não carrega valor cru, rótulo nem id de paciente (com controle positivo do detector)', async () => {
    const renomeado = `${CAMPO_DA_EQUIPE} (RENOMEADO)`;
    const catalogo = catalogoComRenome(CAMPO_DA_EQUIPE, renomeado);
    const mapper = new ClickUpPatientMapper(await resolverReal(catalogo));

    const t = tarefa([
      { name: 'Nombre de Paciente', value: 'NOME-SINTETICO' },
      { name: 'Apellido del Paciente', value: 'SOBRENOME-SINTETICO' },
      { name: 'Segmentos Clínicos', value: SENTINELA_CLINICO, type: 'drop_down' },
      { name: renomeado, value: SENTINELA_CLINICO, type: 'drop_down' },
    ]);

    expect(() => mapper.map(t)).toThrow(ClickUpUnreadableFieldError);

    const proibido = (ls: readonly string[]) =>
      ls.filter(l => l.includes(SENTINELA_CLINICO) || l.includes('sintetica-1-12'));

    // CONTROLE POSITIVO do detector: numa linha PLANTADA, ele acha.
    const plantada = [`[fake] {"field":"x","value":"${SENTINELA_CLINICO}","taskId":"sintetica-1-12"}`];
    console.log(`>>> 1.12/C1 | detector em linha PLANTADA: ${proibido(plantada).length} (esperado 1)`);
    expect(proibido(plantada)).toHaveLength(1);

    console.log(`>>> 1.12/C1 | linhas emitidas=${linhas.length} | com dado proibido=${proibido(linhas).length} (esperado 0)`);
    for (const l of linhas) console.log(`>>> 1.12/C1 |   ${l}`);
    expect(linhas.length).toBeGreaterThan(0); // espião morto não prova nada (F19)
    expect(proibido(linhas)).toHaveLength(0);
  });
});

describe('1.12 (b) — os nomes corrigidos entregam o dado que nunca chegava', () => {
  const VIVOS = [
    { name: 'Nombre de Paciente', value: 'NOME-SINTETICO' },
    { name: 'Apellido del Paciente', value: 'SOBRENOME-SINTETICO' },
    { name: 'Cobertura Informada ', value: 'OBRA-SOCIAL-SINTETICA' }, // ⚠ espaço no fim: o nome VIVO
    { name: 'Nombre de Responsable', value: 'NOME-RESP-SINTETICO' },
    { name: 'Apellido del Responsable', value: 'SOBRENOME-RESP-SINTETICO' },
    { name: 'Email Responsable', value: 'resp@exemplo.invalido' },
    { name: 'Número do Documento Responsable', value: '00000000' },
    { name: 'Domicilio 1 Principal Paciente', value: { formatted_address: 'RUA SINTETICA 1' } },
    { name: 'Domicilio 2 Paciente', value: { formatted_address: 'RUA SINTETICA 2' } },
    { name: 'Domicilio 3 Paciente', value: { formatted_address: 'RUA SINTETICA 3' } },
  ];

  /** A MESMA tarefa, com os nomes que o código pedia ANTES desta task. */
  const ANTES = VIVOS.map(f => {
    const antigo: Record<string, string> = {
      // `Cobertura Informada ` NÃO entra aqui de propósito: o defeito dela é do lado do CÓDIGO
      // (pedia o nome aparado; a tarefa traz o espaço), e trocar a chave da TAREFA encenaria
      // outro defeito. Ela tem teste próprio, abaixo.
      'Apellido del Responsable': 'Apellido de Responsable',
      'Email Responsable': 'Email del Responsable',
      'Número do Documento Responsable': 'Número de Documento Responsable',
      'Domicilio 2 Paciente': 'Domicilio 2 Principal Paciente',
      'Domicilio 3 Paciente': 'Domicilio 3 Principal Paciente',
    };
    return { ...f, name: antigo[f.name] ?? f.name };
  });

  it('com os nomes VIVOS o dado chega; com os nomes de antes, some — os dois lados na mesma saída', async () => {
    const mapper = new ClickUpPatientMapper(await resolverReal(CATALOGO_PACIENTES_FASE0));

    const foto = (rotulo: string, campos: typeof VIVOS) => {
      const out = mapper.map(tarefa(campos))!;
      const r = out.responsibles![0];
      const linha =
        `${rotulo} | healthInsuranceName=${JSON.stringify(out.healthInsuranceName)}` +
        ` | resp.lastName=${JSON.stringify(r.lastName)}` +
        ` | resp.email=${JSON.stringify(r.email)}` +
        ` | resp.documentNumber=${JSON.stringify(r.documentNumber)}` +
        ` | addresses=${out.addresses!.length}`;
      console.log(`>>> 1.12/nomes | ${linha}`);
      return out;
    };

    const depois = foto('NOMES VIVOS (o código de hoje) ', VIVOS);
    const antes = foto('NOMES DE ANTES (o defeito)     ', ANTES);

    // Depois: o dado chega.
    expect(depois.responsibles![0].lastName).toBe('SOBRENOME-RESP-SINTETICO');
    expect(depois.responsibles![0].email).toBe('resp@exemplo.invalido');
    expect(depois.responsibles![0].documentNumber).toBe('00000000');
    expect(depois.addresses).toHaveLength(3);

    // Antes: o `undefined` calado — é a reprodução do achado, e é o que prova que as asserções
    // de cima não passariam sozinhas.
    expect(antes.responsibles![0].lastName).toBe('');
    expect(antes.responsibles![0].email).toBeNull();
    expect(antes.responsibles![0].documentNumber).toBeNull();
    expect(antes.addresses).toHaveLength(1);
  });

  it('o ESPAÇO no fim: o valor chega pelo nome VIVO, e a chave aparada não existe na tarefa', async () => {
    const mapper = new ClickUpPatientMapper(await resolverReal(CATALOGO_PACIENTES_FASE0));

    const t = tarefa([
      { name: 'Nombre de Paciente', value: 'NOME-SINTETICO' },
      { name: 'Apellido del Paciente', value: 'SOBRENOME-SINTETICO' },
      { name: 'Cobertura Informada ', value: 'OBRA-SOCIAL-SINTETICA' },
    ]);

    // A tarefa NÃO tem a chave aparada — o valor só pode ter chegado pelo alias.
    const chaves = t.custom_fields.map(f => f.name);
    expect(chaves).toContain('Cobertura Informada ');
    expect(chaves).not.toContain('Cobertura Informada');

    const out = mapper.map(t)!;

    // CONTROLE POSITIVO: com o campo sob OUTRO nome, o mesmo caminho devolve null — a asserção
    // de cima não passa por acidente, e o alias não é um "casa com qualquer coisa parecida".
    const outro = mapper.map(tarefa([
      { name: 'Nombre de Paciente', value: 'NOME-SINTETICO' },
      { name: 'Apellido del Paciente', value: 'SOBRENOME-SINTETICO' },
      { name: 'Cobertura Informada XYZ', value: 'OBRA-SOCIAL-SINTETICA' },
    ]))!;

    console.log(
      `>>> 1.12/espaço | chave "Cobertura Informada " (viva) → healthInsuranceName=${JSON.stringify(out.healthInsuranceName)}` +
      ` | controle+ chave "Cobertura Informada XYZ" → ${JSON.stringify(outro.healthInsuranceName)}`,
    );
    expect(out.healthInsuranceName).toBe('OBRA-SOCIAL-SINTETICA');
    expect(outro.healthInsuranceName).toBeNull();
  });

  it('nenhum dos nomes de antes sobrou no fonte do mapper', () => {
    const fonte = fs.readFileSync(FONTE_DO_MAPPER, 'utf-8');
    const sobreviventes = NOMES_ERRADOS_ANTES_DA_1_12.filter(n => fonte.includes(`cf['${n}']`));
    console.log(`>>> 1.12/fonte | nomes antigos ainda usados como chave=${sobreviventes.length} ${JSON.stringify(sobreviventes)}`);

    // CONTROLE POSITIVO da própria busca: um nome que SABIDAMENTE está no fonte.
    expect(fonte.includes("cf['Nombre de Paciente']")).toBe(true);
    expect(sobreviventes).toEqual([]);
  });
});
