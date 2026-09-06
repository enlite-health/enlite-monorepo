/**
 * TASK 1.5 — contador observável de rótulos não mapeados, POR CAMPO.
 *
 * ── REGISTRO DE ACESSO (C7 do parecer do `lex` de 23/08/2026) ────────────────
 *   Autorizado por: Gabriel — task 1.5 da change `campos-admissao`.
 *   O que esta fixture lê: NADA. Zero rede, zero banco, zero API do ClickUp, zero
 *     ficha de paciente. Os rótulos exercitados aqui são SINTÉTICOS (inventados) ou
 *     saem do CATÁLOGO de opções — nunca de uma ficha. Identidade de token: NENHUMA.
 *   Nada foi gravado, nada há para apagar.
 *
 * ── O QUE A 1.5 ENTREGA, E O QUE ELA NÃO É ──────────────────────────────────
 *   A 1.3 fez cada mapa GRITAR quando não reconhece um rótulo. Grito responde
 *   "alguma coisa caiu"; não responde "quanto". A pergunta do operador — e o
 *   critério 9.4 depende dela — é "o campo X descartou N valores nesta rodada".
 *
 *   A granularidade é decisão de COMPLIANCE, não de ergonomia: o contador é
 *   chaveado por CAMPO, nunca por rótulo. Um contador por rótulo em campo clínico
 *   é a C1 do `lex` violada por ACUMULAÇÃO — o conjunto de chaves de um mapa desses
 *   É a lista de valores clínicos vistos, e despejá-lo publica exatamente o que a
 *   C1 marca como PARE. O teste 3 abaixo prova essa granularidade medindo o número
 *   de CHAVES depois de 16 rótulos DISTINTOS descartados: tem de ser 1, não 16.
 *
 * ── POR QUE OS CONTROLES POSITIVOS ──────────────────────────────────────────
 *   "contador em zero" pode significar "nada caiu" ou "o instrumento está morto" —
 *   e os dois se parecem (F19/D157). Então todo teste de zero aqui vem com um par
 *   que produz N > 0 no mesmo caminho, e o detector de dado proibido é exercitado
 *   contra uma linha PLANTADA antes de ser usado como prova.
 */

import * as util from 'util';
import {
  recordUnmappedLabel,
  getUnmappedLabelCount,
  getUnmappedLabelCounts,
  resetUnmappedLabelCounts,
  formatUnmappedLabelCounts,
  logUnmappedLabelSummary,
} from '../../../src/modules/integration/infrastructure/clickup/helpers/unmappedLabelCounter';
import {
  mapClickUpClinicalSpecialty,
  mapClickUpService,
  mapClickUpDependencyLevel,
} from '../../../src/modules/integration/infrastructure/clickup/mappings';

const CAMPO_CLINICO = 'Segmentos Clínicos';
const CAMPO_SERVICO = 'Servicio';

/** Rótulo que o mapa REALMENTE conhece — o controle positivo do lado "não descarta". */
const ROTULO_CONHECIDO = 'AT para Pacientes con Enfermedades Neurológicas';
/** Rótulo inventado aqui. Não existe no ClickUp, não é de ninguém. */
const ROTULO_SINTETICO = 'SEGMENTO-SINTETICO-QUE-NAO-EXISTE';

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

afterEach(() => {
  spyWarn.mockRestore();
});

/** Só as linhas do contador — as da 1.3 continuam existindo e não são alvo daqui. */
function linhasDoContador(): string[] {
  return emitidas.filter(l => l.includes('[unmappedLabelCounter]'));
}

describe('1.5 — contador de rótulos não mapeados, por campo: aparece na saída e é consultável', () => {
  it('ZERO quando não há descarte — com controle positivo provando que o caminho foi exercitado', () => {
    // Controle positivo: um rótulo que o mapa CONHECE atravessa o mesmo caminho e deriva.
    const derivado = mapClickUpClinicalSpecialty(ROTULO_CONHECIDO);

    console.log(`>>> 1.5/zero | rotulo conhecido derivou=${derivado} | contador("${CAMPO_CLINICO}")=${getUnmappedLabelCount(CAMPO_CLINICO)} | chaves=${Object.keys(getUnmappedLabelCounts()).length} | linhas_do_contador=${linhasDoContador().length}`);
    console.log(`>>> 1.5/zero | formatUnmappedLabelCounts() = ${formatUnmappedLabelCounts()}`);

    expect(derivado).toBe('NEUROLOGICAL');            // o caminho RODOU (não é zero de teste vazio)
    expect(getUnmappedLabelCount(CAMPO_CLINICO)).toBe(0);
    expect(getUnmappedLabelCounts()).toEqual({});
    expect(linhasDoContador()).toHaveLength(0);
    // O vazio é dito em voz alta, não renderizado como um branco tranquilizador.
    expect(formatUnmappedLabelCounts()).toContain('nothing called the counter');
  });

  it('N quando há N — e o número é consultável POR CAMPO, pelo código real dos mapas', () => {
    mapClickUpClinicalSpecialty('SEGMENTO-SINTETICO-A');
    mapClickUpClinicalSpecialty('SEGMENTO-SINTETICO-B');
    mapClickUpClinicalSpecialty('SEGMENTO-SINTETICO-C');
    mapClickUpService('SERVICO-SINTETICO-A');
    const derivado = mapClickUpDependencyLevel('MUY GRAVE');   // controle positivo: este NÃO conta

    const contagens = getUnmappedLabelCounts();
    console.log(`>>> 1.5/N | contagens = ${JSON.stringify(contagens)}`);
    console.log(`>>> 1.5/N | getUnmappedLabelCount("${CAMPO_CLINICO}")=${getUnmappedLabelCount(CAMPO_CLINICO)} · getUnmappedLabelCount("${CAMPO_SERVICO}")=${getUnmappedLabelCount(CAMPO_SERVICO)}`);
    console.log(`>>> 1.5/N | dependencia derivou=${derivado} e NAO contou: getUnmappedLabelCount("Dependencia")=${getUnmappedLabelCount('Dependencia')}`);

    expect(getUnmappedLabelCount(CAMPO_CLINICO)).toBe(3);
    expect(getUnmappedLabelCount(CAMPO_SERVICO)).toBe(1);
    expect(derivado).toBe('VERY_SEVERE');
    expect(getUnmappedLabelCount('Dependencia')).toBe(0);      // campo que não descartou fica em 0
    expect(contagens).toEqual({ [CAMPO_CLINICO]: 3, [CAMPO_SERVICO]: 1 });
  });

  it('GRANULARIDADE (C1 por acumulação): 16 rótulos DISTINTOS produzem 1 chave, não 16', () => {
    for (let i = 0; i < 16; i++) mapClickUpClinicalSpecialty(`SEGMENTO-SINTETICO-DISTINTO-${i}`);

    const chaves = Object.keys(getUnmappedLabelCounts());
    console.log(`>>> 1.5/granularidade | rotulos distintos descartados=16 | chaves do contador=${chaves.length} | chaves=${JSON.stringify(chaves)} | valor=${getUnmappedLabelCount(CAMPO_CLINICO)}`);

    expect(getUnmappedLabelCount(CAMPO_CLINICO)).toBe(16);     // contagem POSITIVA: mediu 16
    expect(chaves).toEqual([CAMPO_CLINICO]);                   // e mesmo assim guarda 1 nome de CAMPO
  });

  it('APARECE NA SAÍDA: emite no 1º descarte e ao cruzar a potência de dez — com o número dentro da linha', () => {
    for (let i = 0; i < 10; i++) mapClickUpClinicalSpecialty(`SEGMENTO-SINTETICO-VOLUME-${i}`);

    const linhas = linhasDoContador();
    linhas.forEach(l => console.log(`>>> 1.5/saida | ${l}`));
    console.log(`>>> 1.5/saida | descartes=10 | linhas do contador=${linhas.length} (esperado 2: a 1ª e a 10ª) | contador exato=${getUnmappedLabelCount(CAMPO_CLINICO)}`);

    expect(getUnmappedLabelCount(CAMPO_CLINICO)).toBe(10);
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toContain('droppedThisRun: 1');
    expect(linhas[1]).toContain('droppedThisRun: 10');
    expect(linhas[1]).toContain(CAMPO_CLINICO);
  });

  it('SUMÁRIO consultável e imprimível, com o vazio dito em voz alta', () => {
    logUnmappedLabelSummary('teste/vazio');
    const vazio = linhasDoContador().at(-1);

    mapClickUpClinicalSpecialty(ROTULO_SINTETICO);
    mapClickUpService('SERVICO-SINTETICO-B');
    mapClickUpService('SERVICO-SINTETICO-C');
    logUnmappedLabelSummary('teste/cheio');
    const cheio = linhasDoContador().at(-1);

    console.log(`>>> 1.5/sumario | vazio: ${vazio}`);
    console.log(`>>> 1.5/sumario | cheio: ${cheio}`);

    expect(vazio).toContain('nothing called the counter');
    expect(cheio).toContain(`"${CAMPO_SERVICO}"=2`);
    expect(cheio).toContain(`"${CAMPO_CLINICO}"=1`);
  });

  it('C1/lex: nenhuma linha do contador carrega o rótulo, o índice ou id de paciente (com controle positivo do detector)', () => {
    const SENTINELA = 'SENTINELA-CLINICO-XYZ';

    // Controle positivo do DETECTOR: uma linha PLANTADA com a sentinela tem de ser pega.
    const plantada = `[unmappedLabelCounter] plantada { field: '${SENTINELA}' }`;
    const achadasNaPlantada = [plantada].filter(l => l.includes(SENTINELA)).length;
    console.log(`>>> 1.5/C1 | detector em linha PLANTADA: ${achadasNaPlantada} (esperado 1)`);
    expect(achadasNaPlantada).toBe(1);

    // Agora a prova: a sentinela entra como RÓTULO, e o mapa a descarta.
    mapClickUpClinicalSpecialty(SENTINELA);
    logUnmappedLabelSummary('teste/C1');

    const linhas = linhasDoContador();
    const comProibido = linhas.filter(l => l.includes(SENTINELA));
    console.log(`>>> 1.5/C1 | linhas do contador emitidas=${linhas.length} | com dado proibido=${comProibido.length} (esperado 0)`);
    linhas.forEach(l => console.log(`>>> 1.5/C1 | ${l}`));

    expect(linhas.length).toBeGreaterThan(0);   // contagem POSITIVA: houve o que inspecionar
    expect(comProibido).toHaveLength(0);
    expect(getUnmappedLabelCount(CAMPO_CLINICO)).toBe(1);
  });

  it('a chave é o nome do CAMPO fornecido pelo chamador — reset zera, e o zero depois de N é medido', () => {
    recordUnmappedLabel(CAMPO_CLINICO);
    recordUnmappedLabel(CAMPO_CLINICO);
    const antes = getUnmappedLabelCount(CAMPO_CLINICO);
    resetUnmappedLabelCounts();
    const depois = getUnmappedLabelCount(CAMPO_CLINICO);

    console.log(`>>> 1.5/reset | antes=${antes} | depois do reset=${depois}`);
    expect(antes).toBe(2);
    expect(depois).toBe(0);
  });
});
