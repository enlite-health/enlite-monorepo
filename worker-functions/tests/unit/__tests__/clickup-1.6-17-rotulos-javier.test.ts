/**
 * TASK 1.6 (Critério) — os 17 rótulos da lista do Javier, e NENHUM vira nulo SILENCIOSO.
 *
 * ── REGISTRO DE ACESSO (C7 do parecer do `lex` de 23/08/2026) ────────────────
 *   Autorizado por: Gabriel — task 1.6 da change `campos-admissao`.
 *   O que esta fixture lê: NADA em runtime. Zero rede, zero banco, zero API do
 *     ClickUp, zero ficha de paciente. Os 17 rótulos abaixo são o CATÁLOGO proposto
 *     — a descrição de uma task de especificação do space Technology (`86ak0jz2w`),
 *     copiada de `medicoes/campos-admissao/fase0/lista-javier.txt`. Catálogo, não
 *     ficha: é exatamente a fonte que a C2 do parecer manda usar para responder
 *     "qual opção não mapeia", com ZERO pacientes envolvidos.
 *   O paciente sintético do nível B tem nome inventado. Identidade de token: NENHUMA.
 *
 * ── O DEFEITO QUE ELA TRANCA (F33 — o maior risco da change) ─────────────────
 *   O mapa é indexado por STRING EXATA. Das 17 opções da lista, 1 casa com as 14
 *   chaves de hoje; as outras 16 caem no `?? null`. Antes da 1.3 esse fallback era
 *   MUDO. No dia em que o Javier aplicar a lista no ClickUp, os 266 classificados
 *   começam a virar `null` a cada re-sync — sem erro, sem log. Este teste é o que
 *   garante que, nesse dia, alguém GRITA.
 *
 * ── DUAS SAÍDAS DIFERENTES, E A DIFERENÇA É A C1 ────────────────────────────
 *   A saída DESTE TESTE mostra, por rótulo, o que aconteceu — é o que a task 1.6
 *   exige, e é legítimo: catálogo, zero pacientes (C2).
 *   A saída da APLICAÇÃO (as linhas de `console.warn` que o código emite) NÃO pode
 *   conter rótulo nenhum — é a C1, que é PARE. O teste C1 lá embaixo prova as duas
 *   coisas ao mesmo tempo: o relatório por rótulo existe AQUI, e o log emitido pelo
 *   código não tem rótulo NENHUM.
 *
 * ── INDEPENDÊNCIA DELIBERADA DA TASK 1.11 ───────────────────────────────────
 *   A direção da 1.11 (hoje `map()` LANÇA quando um campo fica ilegível) ainda não
 *   está decidida. NENHUM caso deste arquivo depende desse lançamento: o catálogo
 *   sintético do nível B declara os 7 `drop_down` que o mapper pede, então o
 *   preflight passa e o caminho de exceção nunca é exercitado. Se a 1.11 mudar de
 *   direção, este arquivo continua medindo a mesma coisa. Provado, não alegado:
 *   o teste "o preflight da 1.11 NÃO é o que faz este arquivo passar".
 */

import * as util from 'util';
import { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import {
  ClickUpPatientMapper,
  PATIENT_DROPDOWN_FIELDS,
} from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { findUnreadableDropdownFields } from '../../../src/modules/integration/infrastructure/clickup/helpers/dropdownCatalogGuard';
import { mapClickUpClinicalSpecialty } from '../../../src/modules/integration/infrastructure/clickup/mappings';
import {
  getUnmappedLabelCount,
  getUnmappedLabelCounts,
  resetUnmappedLabelCounts,
} from '../../../src/modules/integration/infrastructure/clickup/helpers/unmappedLabelCounter';
import type { ClickUpTask, ClickUpTaskCustomField } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { completaCatalogo } from '../../fixtures/clickup/completaCatalogo';

const CAMPO = 'Segmentos Clínicos';

/**
 * Os 17 rótulos de `SEGMENTOS`, LITERAIS, de
 * `medicoes/campos-admissao/fase0/lista-javier.txt` (task ClickUp `86ak0jz2w`).
 *
 * ⚠️ Cinco deles terminam em `\u00A0` — NO-BREAK SPACE, NÃO o espaço comum `\u0020`.
 * Medido no arquivo, não suposto. Está escrito como escape justamente porque o
 * caractere é invisível e qualquer editor o aparia sem avisar. Aparar seria maquiar o
 * defeito: um rótulo terminado em NBSP é ainda mais difícil de casar por string exata
 * do que um terminado em espaço. O teste `fidelidade da lista` conta os cinco e exige
 * que NENHUM termine em espaço comum — se alguém normalizar, ele quebra alto.
 */
const ROTULOS_JAVIER: readonly string[] = [
  'AT para pacientes con discapacidad intelectual',
  'AT para Pacientes con Enfermedades Neurológicas',
  'AT para pacientes con limitaciones motrices',
  'AT para pacientes con TEA\u00A0',
  'AT para pacientes con trastornos psiquiatricos',
  'AT para personas con vulnerabilidad social\u00A0',
  'AT para personas mayores\u00A0',
  'AT en Adicciones y Consumos Problemáticos',
  'Cuidado integral de pacientes con discapacidad intelectual\u00A0',
  'Cuidado integral en enfermedades neurologicas',
  'Cuidado Integral en Trastorno del Espectro Autista (TEA)',
  'Cuidado Integral en Personas Mayores',
  'Cuidado Integral en Limitaciones Motrices',
  'Cuidado Integral en Trastornos Psiquiátricos',
  'Cuidado Integral en Contextos de Vulnerabilidad Social',
  'Cuidado Integral en Adicciones',
  'Cuidado Humano Integral\u00A0',
];

/**
 * O CONTROLE POSITIVO, e ele mora dentro dos 17: é o único da lista que casa com uma
 * chave do mapa de hoje (F33: "1 casa com as 14 chaves atuais"). Ele prova que o
 * instrumento distingue os dois lados — que "grita" não é "grita sempre".
 */
const CONTROLE_POSITIVO = 'AT para Pacientes con Enfermedades Neurológicas';
const DERIVADO_ESPERADO = 'NEUROLOGICAL';

// ── Espião de console.warn ────────────────────────────────────────────────────
let emitidas: string[] = [];
let spyWarn: jest.SpyInstance;

beforeEach(() => {
  resetUnmappedLabelCounts();
  emitidas = [];
  spyWarn = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    emitidas.push(args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 6 }))).join(' '));
  });
});

afterEach(() => spyWarn.mockRestore());

/** Avisos que nomeiam o campo clínico — os que provam que o descarte não foi mudo. */
function avisosDoCampo(): string[] {
  return emitidas.filter(l => l.includes(CAMPO));
}

type Desfecho = 'DERIVOU' | 'NULO_COM_AVISO' | 'NULO_MUDO';

/** Roda UM rótulo pelo mapa REAL e classifica o desfecho pelo que o código fez. */
function desfechoDe(rotulo: string): { desfecho: Desfecho; derivado: string | null; avisos: number } {
  emitidas = [];
  const derivado = mapClickUpClinicalSpecialty(rotulo);
  const avisos = avisosDoCampo().length;
  if (derivado !== null) return { desfecho: 'DERIVOU', derivado, avisos };
  return { desfecho: avisos > 0 ? 'NULO_COM_AVISO' : 'NULO_MUDO', derivado, avisos };
}

// ── Catálogo SINTÉTICO para o nível B ─────────────────────────────────────────
// Encena o DIA SEGUINTE: o Javier aplicou a lista, e as 17 opções novas são o
// catálogo de `Segmentos Clínicos`. Os outros 6 `drop_down` que o mapper pede
// existem, para que o preflight da 1.11 passe e não seja ele o assunto aqui.
function catalogoDepoisDaLista() {
  return {
    fields: completaCatalogo([
      {
        id: 'cf-seg', name: CAMPO, type: 'drop_down',
        type_config: { options: ROTULOS_JAVIER.map((name, orderindex) => ({ id: `o-${orderindex}`, name, orderindex })) },
      },
      { id: 'cf-dep', name: 'Dependencia', type: 'drop_down', type_config: { options: [{ id: 'd-0', name: 'GRAVE', orderindex: 0 }] } },
      { id: 'cf-sex', name: 'Sexo Asignado al Nacer (Uso Clínico)', type: 'drop_down', type_config: { options: [{ id: 's-0', name: 'Femenino', orderindex: 0 }] } },
      { id: 'cf-ser', name: 'Servicio', type: 'drop_down', type_config: { options: [{ id: 'v-0', name: 'Acompañante Terapéutico', orderindex: 0 }] } },
      { id: 'cf-dop', name: 'Tipo de Documento Paciente', type: 'drop_down', type_config: { options: [{ id: 't-0', name: 'DNI', orderindex: 0 }] } },
      { id: 'cf-rel', name: 'Relación con el Paciente', type: 'drop_down', type_config: { options: [{ id: 'r-0', name: 'Hijo / Hija', orderindex: 0 }] } },
      { id: 'cf-dor', name: 'Tipo de Documento Responsable', type: 'drop_down', type_config: { options: [{ id: 'u-0', name: 'DNI', orderindex: 0 }] } },
      // Task 1.12: o 8º `drop_down` declarado. Fixture, não asserção.
      { id: 'cf-equ', name: 'Equipo Tratante Multidisciplinario', type: 'drop_down', type_config: { options: [{ id: 'e-0', name: 'No', orderindex: 0 }] } },
    ] as never),
  };
}

async function mapperReal(): Promise<ClickUpPatientMapper> {
  const resolver = await ClickUpFieldResolver.fromList('lista-sintetica', {
    token: 'token-sintetico',
    fetchImpl: (async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => catalogoDepoisDaLista(),
    } as unknown as Response)) as unknown as typeof fetch,
  });
  expect(resolver).toBeInstanceOf(ClickUpFieldResolver);   // a CLASSE real (C4 do parecer)
  return new ClickUpPatientMapper(resolver);
}

function tarefaComSegmento(orderindex: number): ClickUpTask {
  const campos = [
    { name: 'Nombre de Paciente',    value: 'NOME-SINTETICO' },
    { name: 'Apellido del Paciente', value: 'SOBRENOME-SINTETICO' },
    { name: CAMPO,                   value: orderindex },
  ];
  return {
    id: 'sintetica-1-6',
    name: 'SOBRENOME-SINTETICO, NOME-SINTETICO',
    status: { status: 'activo', color: '#000', type: 'custom' },
    parent: null,
    custom_fields: campos.map(f => ({ id: `cf-${f.name}`, name: f.name, type: 'drop_down', value: f.value })) as ClickUpTaskCustomField[],
    url: 'https://app.clickup.com/t/sintetica-1-6',
    date_created: '1700000000000',
    date_updated: '1700100000000',
  };
}

describe('1.6 — os 17 rótulos do Javier: nenhum vira nulo silencioso', () => {
  it('fidelidade da lista: são 17, e os 5 finais em NBSP (U+00A0) do original estão preservados', () => {
    const comNbspFinal   = ROTULOS_JAVIER.filter(r => r.endsWith('\u00A0'));
    const comEspacoComum = ROTULOS_JAVIER.filter(r => r.endsWith('\u0020'));
    const distintos = new Set(ROTULOS_JAVIER).size;
    console.log(`>>> 1.6/lista | rotulos=${ROTULOS_JAVIER.length} (esperado 17) | distintos=${distintos} | terminados em NBSP=${comNbspFinal.length} (esperado 5) | terminados em espaco comum=${comEspacoComum.length} (esperado 0)`);

    expect(ROTULOS_JAVIER).toHaveLength(17);
    expect(distintos).toBe(17);
    expect(comNbspFinal).toHaveLength(5);      // contagem POSITIVA: o NBSP da fonte sobreviveu
    expect(comEspacoComum).toHaveLength(0);    // e ninguém o normalizou para espaço comum
  });

  it('NÍVEL A — os 17 pelo mapa REAL: zero nulos MUDOS, e o relatório por rótulo', () => {
    const desfechos = ROTULOS_JAVIER.map(r => ({ rotulo: r, ...desfechoDe(r) }));

    desfechos.forEach((d, i) => {
      console.log(`>>> 1.6/A | ${String(i + 1).padStart(2, '0')} | ${d.desfecho.padEnd(14)} | derivado=${String(d.derivado).padEnd(12)} | avisos=${d.avisos} | rotulo="${d.rotulo}"`);
    });

    const derivou = desfechos.filter(d => d.desfecho === 'DERIVOU').length;
    const comAviso = desfechos.filter(d => d.desfecho === 'NULO_COM_AVISO').length;
    const mudos = desfechos.filter(d => d.desfecho === 'NULO_MUDO');
    console.log(`>>> 1.6/A | TOTAL=${desfechos.length} | DERIVOU=${derivou} | NULO_COM_AVISO=${comAviso} | NULO_MUDO=${mudos.length} (esperado 0)`);

    expect(desfechos).toHaveLength(17);              // contagem POSITIVA: 17 foram exercitados
    expect(mudos).toHaveLength(0);                   // o critério da 1.6
    expect(derivou + comAviso).toBe(17);             // e as duas classes cobrem os 17
    expect(derivou).toBeGreaterThan(0);              // o instrumento NÃO grita sempre
    expect(comAviso).toBeGreaterThan(0);             // e NÃO cala sempre
  });

  it('NÍVEL A — CONTROLE POSITIVO: o rótulo conhecido DERIVA e NÃO grita', () => {
    const d = desfechoDe(CONTROLE_POSITIVO);
    console.log(`>>> 1.6/A-controle | rotulo="${CONTROLE_POSITIVO}" | desfecho=${d.desfecho} | derivado=${d.derivado} | avisos=${d.avisos} (esperado 0)`);

    expect(d.desfecho).toBe('DERIVOU');
    expect(d.derivado).toBe(DERIVADO_ESPERADO);
    expect(d.avisos).toBe(0);
    expect(getUnmappedLabelCount(CAMPO)).toBe(0);    // e o contador da 1.5 não se mexe
  });

  it('NÍVEL A — o contador da 1.5 fecha a conta dos 17: 16 descartes, 1 chave', () => {
    ROTULOS_JAVIER.forEach(r => mapClickUpClinicalSpecialty(r));

    const contagens = getUnmappedLabelCounts();
    console.log(`>>> 1.6/contador | depois dos 17: ${JSON.stringify(contagens)} | esperado {"${CAMPO}":16}`);

    expect(getUnmappedLabelCount(CAMPO)).toBe(16);
    expect(Object.keys(contagens)).toEqual([CAMPO]);
  });

  it('NÍVEL B — os 17 pelo `ClickUpPatientMapper.map()` REAL, no dia seguinte à lista aplicada', async () => {
    const mapper = await mapperReal();
    const linhas: { i: number; rotulo: string; especialidade: unknown; avisos: number; desfecho: Desfecho }[] = [];

    for (let i = 0; i < ROTULOS_JAVIER.length; i++) {
      emitidas = [];
      const input = mapper.map(tarefaComSegmento(i));     // orderindex = posição na lista nova
      const especialidade = input?.clinicalSpecialty ?? null;
      const avisos = avisosDoCampo().length;
      const desfecho: Desfecho = especialidade !== null ? 'DERIVOU' : (avisos > 0 ? 'NULO_COM_AVISO' : 'NULO_MUDO');
      linhas.push({ i: i + 1, rotulo: ROTULOS_JAVIER[i], especialidade, avisos, desfecho });
    }

    linhas.forEach(l => console.log(`>>> 1.6/B | ${String(l.i).padStart(2, '0')} | ${l.desfecho.padEnd(14)} | clinicalSpecialty=${String(l.especialidade).padEnd(12)} | avisos=${l.avisos} | rotulo="${l.rotulo}"`));

    const mudos = linhas.filter(l => l.desfecho === 'NULO_MUDO');
    const derivou = linhas.filter(l => l.desfecho === 'DERIVOU');
    console.log(`>>> 1.6/B | TOTAL=${linhas.length} | DERIVOU=${derivou.length} | NULO_COM_AVISO=${linhas.length - derivou.length - mudos.length} | NULO_MUDO=${mudos.length} (esperado 0)`);
    console.log(`>>> 1.6/B | contador apos a rodada inteira: ${JSON.stringify(getUnmappedLabelCounts())}`);

    expect(linhas).toHaveLength(17);
    expect(mudos).toHaveLength(0);
    expect(derivou).toHaveLength(1);                                   // o controle positivo, e só ele
    expect(derivou[0].rotulo).toBe(CONTROLE_POSITIVO);
    expect(derivou[0].especialidade).toBe(DERIVADO_ESPERADO);
    expect(derivou[0].avisos).toBe(0);
    expect(getUnmappedLabelCount(CAMPO)).toBe(16);
  });

  it('o preflight da 1.11 NÃO é o que faz este arquivo passar — o caminho de exceção nunca é tocado', async () => {
    const resolver = await ClickUpFieldResolver.fromList('lista-sintetica', {
      token: 'token-sintetico',
      fetchImpl: (async () => ({
        ok: true, status: 200, statusText: 'OK', json: async () => catalogoDepoisDaLista(),
      } as unknown as Response)) as unknown as typeof fetch,
    });
    const ilegiveis = findUnreadableDropdownFields(resolver, PATIENT_DROPDOWN_FIELDS);
    console.log(`>>> 1.6/independencia | campos drop_down pedidos=${PATIENT_DROPDOWN_FIELDS.length} | ilegiveis=${ilegiveis.length} (esperado 0) | logo map() nao lanca em nenhum caso deste arquivo`);

    expect(PATIENT_DROPDOWN_FIELDS.length).toBeGreaterThan(0);   // contagem POSITIVA: mediu algo
    expect(ilegiveis).toHaveLength(0);
    // E o `map()` de fato retorna, em vez de lançar, para o pior caso do arquivo:
    const mapper = new ClickUpPatientMapper(resolver);
    expect(() => mapper.map(tarefaComSegmento(0))).not.toThrow();
  });

  it('C1/lex: o relatório por rótulo é DESTE teste — o log que o CÓDIGO emite não tem rótulo nenhum (com controle positivo do detector)', () => {
    const SENTINELA = 'SENTINELA-CLINICO-XYZ';

    // Controle positivo do DETECTOR: linha PLANTADA com a sentinela tem de ser pega.
    const achadasNaPlantada = [`[qualquer] { label: '${SENTINELA}' }`].filter(l => l.includes(SENTINELA)).length;
    console.log(`>>> 1.6/C1 | detector em linha PLANTADA: ${achadasNaPlantada} (esperado 1)`);
    expect(achadasNaPlantada).toBe(1);

    // Prova 1: a sentinela como rótulo — nenhuma linha emitida pode contê-la.
    emitidas = [];
    mapClickUpClinicalSpecialty(SENTINELA);
    const comSentinela = emitidas.filter(l => l.includes(SENTINELA));
    console.log(`>>> 1.6/C1 | linhas emitidas=${emitidas.length} | com a sentinela=${comSentinela.length} (esperado 0)`);
    emitidas.forEach(l => console.log(`>>> 1.6/C1 | ${l}`));

    expect(emitidas.length).toBeGreaterThan(0);      // houve o que inspecionar
    expect(comSentinela).toHaveLength(0);

    // Prova 2: NENHUM dos 17 rótulos reais aparece em NENHUMA linha emitida pelos 17.
    emitidas = [];
    ROTULOS_JAVIER.forEach(r => mapClickUpClinicalSpecialty(r));
    const vazando = ROTULOS_JAVIER.filter(r => emitidas.some(l => l.includes(r.trim())));
    console.log(`>>> 1.6/C1 | linhas emitidas pelos 17=${emitidas.length} | rotulos vazados=${vazando.length} (esperado 0)`);

    expect(emitidas.length).toBeGreaterThan(0);
    expect(vazando).toHaveLength(0);
  });
});
