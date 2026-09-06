/**
 * C3 — BLOQUEIO DE ENTRADA DA FASE 2: o caminho `labels` do `ClickUpFieldResolver`
 * não pode imprimir o uuid da opção no dia em que `Segmentos Clínicos` virar múltiplo.
 *
 * ── REGISTRO DE ACESSO (C7 do parecer do `lex` de 23/08/2026) ────────────────
 *   Autorizado por: Gabriel — bloqueio de entrada da Fase 2 da change `campos-admissao`,
 *     execução da condição C3 de `medicoes/campos-admissao/fase1/parecer-lex-asindexable.md`.
 *   O que esta fixture lê: NADA. Zero rede, zero banco, zero API do ClickUp, zero ficha de
 *     paciente. O `ClickUpFieldResolver` REAL é montado com um `fetchImpl` falso que devolve
 *     um catálogo 100% SINTÉTICO, escrito aqui dentro (C4 — o instrumento não pode ser um
 *     resolver artesanal que confirma a si mesmo, D157).
 *   Identidade de token: NENHUMA. `token` é a string literal 'token-sintetico'.
 *   Nada foi gravado, nada há para apagar.
 *
 * ── O QUE ELA PROVA ──────────────────────────────────────────────────────────
 *   C3/C1  nenhuma linha emitida pelos três caminhos de `labels` contém o uuid da opção,
 *          o rótulo resolvido ou o identificador da tarefa — nos DOIS mundos: o de hoje
 *          (`Tipo de Dispositivo`) e o da Fase 2 (`Segmentos Clínicos` como `labels`).
 *   controle positivo  o espião está vivo e o detector ACUSA a sentinela quando ela está
 *          presente. Sem isto, "zero linhas com a sentinela" pode ser só um espião morto —
 *          contagem zero sem controle é FALHA, nunca sucesso (D157/F19).
 *   o alarme sobrevive  a linha continua dizendo "o campo X descartou N valores", que é o
 *          que o operador precisa (C1). Silenciar não é conformidade; é outro defeito.
 */

import { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';

// ── Sentinelas ────────────────────────────────────────────────────────────────
// Nada disto pode aparecer em NENHUMA linha de log emitida.
const SENTINELA_UUID_A = 'SENTINELA-UUID-AAAA-0000-000000000001';
const SENTINELA_UUID_B = 'SENTINELA-UUID-BBBB-0000-000000000002';
const SENTINELA_LABEL  = 'SENTINELA-ROTULO-CLINICO-XYZ';
const SENTINELA_TASKID = 'SENTINELA-TASK-ID-86xyz';

// ── Catálogo SINTÉTICO — o mundo da Fase 2 ────────────────────────────────────
// `Segmentos Clínicos` aqui é `labels` (múltiplo). É exatamente a mudança que a task 2.2
// faz, e é o que transforma os warns deste arquivo em valor clínico (C3).
const CAMPO_CLINICO = 'Segmentos Clínicos';
const CAMPO_NAO_CLINICO = 'Tipo de Dispositivo';
const UUID_CONHECIDO = 'op-conhecida-0001';
const ROTULO_CONHECIDO = 'AT para Pacientes con TEA';

const CATALOGO_SINTETICO = {
  fields: [
    {
      id: 'cf-seg', name: CAMPO_CLINICO, type: 'labels',
      type_config: { options: [
        { id: UUID_CONHECIDO, label: ROTULO_CONHECIDO, orderindex: 0 },
        { id: 'op-conhecida-0002', label: 'Cuidado Integral de Pacientes con TEA', orderindex: 1 },
      ] },
    },
    {
      id: 'cf-dis', name: CAMPO_NAO_CLINICO, type: 'labels',
      type_config: { options: [{ id: 'dis-0001', label: 'Domiciliario', orderindex: 0 }] },
    },
  ],
};

let fetchChamadas = 0;
const fetchFalso = (async () => {
  fetchChamadas += 1;
  return { ok: true, status: 200, statusText: 'OK', json: async () => CATALOGO_SINTETICO } as unknown as Response;
}) as unknown as typeof fetch;

async function resolverReal(): Promise<ClickUpFieldResolver> {
  const r = await ClickUpFieldResolver.fromList('lista-sintetica', {
    token: 'token-sintetico',
    fetchImpl: fetchFalso,
  });
  expect(r).toBeInstanceOf(ClickUpFieldResolver);  // C4: a classe REAL, não um artesanal
  return r;
}

// ── Espião de console.warn ────────────────────────────────────────────────────
let linhas: string[] = [];
let spy: jest.SpyInstance;

function serializa(args: unknown[]): string {
  return args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

/** O DETECTOR. É ele que o controle positivo tem de acusar. */
function linhasComSentinela(): string[] {
  const agulhas = [SENTINELA_UUID_A, SENTINELA_UUID_B, SENTINELA_LABEL, SENTINELA_TASKID];
  return linhas.filter(l => agulhas.some(a => l.includes(a)));
}

beforeEach(() => {
  linhas = [];
  spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    linhas.push(serializa(args));
  });
});

afterEach(() => spy.mockRestore());

// ─────────────────────────────────────────────────────────────────────────────
describe('C3 — CONTROLE POSITIVO (sem ele, nenhum "zero" abaixo vale)', () => {
  it('o espião captura e o detector ACUSA a sentinela quando ela está na linha', () => {
    // Esta é LITERALMENTE a linha que o código tinha antes desta entrega:
    //   console.warn('[ClickUpFieldResolver] Unknown labels option id (value dropped):',
    //                { field: fieldName, optionId: id });
    console.warn('[CONTROLE POSITIVO — o formato ANTIGO, proibido de propósito]', {
      field: CAMPO_CLINICO, optionId: SENTINELA_UUID_A, label: SENTINELA_LABEL, taskId: SENTINELA_TASKID,
    });
    const achadas = linhasComSentinela();
    console.log(`>>> CONTROLE POSITIVO | capturadas=${linhas.length} | detector achou=${achadas.length} (esperado >0)`);
    console.log(`>>> CONTROLE POSITIVO | linha acusada: ${achadas[0]}`);
    expect(linhas.length).toBeGreaterThan(0);
    expect(achadas.length).toBeGreaterThan(0);
  });
});

describe('C3 — `resolveLabels` (o caminho que a task 2.2 abre para o segmento clínico)', () => {
  it('uuid desconhecido em campo CLÍNICO: grita, e nenhuma linha contém o uuid', async () => {
    const r = await resolverReal();
    linhas = [];
    const out = r.resolveLabels(CAMPO_CLINICO, [SENTINELA_UUID_A, SENTINELA_UUID_B]);
    const achadas = linhasComSentinela();
    console.log(`>>> C3/resolveLabels | resolvidos=${JSON.stringify(out)} | avisos=${linhas.length} | com sentinela=${achadas.length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(out).toEqual([]);
    expect(linhas.length).toBeGreaterThan(0);   // contagem zero seria espião morto, não sucesso
    expect(achadas).toEqual([]);
  });

  it('descarte parcial: pediu 3, voltou 1 — e o aviso diz N sem dizer QUAL', async () => {
    const r = await resolverReal();
    linhas = [];
    const out = r.resolveLabels(CAMPO_CLINICO, [UUID_CONHECIDO, SENTINELA_UUID_A, SENTINELA_UUID_B]);
    const achadas = linhasComSentinela();
    const comContagem = linhas.filter(l => l.includes('"droppedSoFar"') || l.includes('"resolved"'));
    console.log(`>>> C3/parcial | pediu=3 resolveu=${out.length} | avisos=${linhas.length} | com contagem=${comContagem.length} | com sentinela=${achadas.length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(out).toEqual([ROTULO_CONHECIDO]);
    expect(achadas).toEqual([]);
    // O alarme TEM de sobreviver: silenciar não é cumprir a C1, é trocar de defeito.
    expect(comContagem.length).toBeGreaterThan(0);
    // Um aviso POR ITEM descartado — array curto parece completo (F39).
    expect(linhas.filter(l => l.includes('value dropped')).length).toBe(2);
  });

  it('campo `labels` desconhecido (renomeado/apagado): grita sem vazar o uuid pedido', async () => {
    const r = await resolverReal();
    linhas = [];
    const out = r.resolveLabels('Campo Que Nao Existe', [SENTINELA_UUID_A]);
    console.log(`>>> C3/campo-desconhecido/labels | out=${JSON.stringify(out)} | avisos=${linhas.length} | com sentinela=${linhasComSentinela().length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(out).toEqual([]);
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhasComSentinela()).toEqual([]);
  });

  it('CONTROLE NEGATIVO: uuid conhecido resolve e NÃO grita (a trava não é "calar sempre")', async () => {
    const r = await resolverReal();
    linhas = [];
    const out = r.resolveLabels(CAMPO_CLINICO, [UUID_CONHECIDO]);
    console.log(`>>> C3/controle-negativo | out=${JSON.stringify(out)} | avisos=${linhas.length} (esperado 0)`);
    expect(out).toEqual([ROTULO_CONHECIDO]);
    expect(linhas.length).toBe(0);
  });
});

describe('C3 — `resolveLabel` (o caminho de valor único)', () => {
  it('uuid desconhecido: grita, e nenhuma linha contém o uuid', async () => {
    const r = await resolverReal();
    linhas = [];
    const out = r.resolveLabel(CAMPO_CLINICO, SENTINELA_UUID_A);
    console.log(`>>> C3/resolveLabel | out=${JSON.stringify(out)} | avisos=${linhas.length} | com sentinela=${linhasComSentinela().length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(out).toBeNull();
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhasComSentinela()).toEqual([]);
  });

  it('campo `labels` desconhecido: grita sem vazar o uuid pedido', async () => {
    const r = await resolverReal();
    linhas = [];
    const out = r.resolveLabel('Campo Que Nao Existe', SENTINELA_UUID_A);
    console.log(`>>> C3/campo-desconhecido/label | out=${JSON.stringify(out)} | avisos=${linhas.length} | com sentinela=${linhasComSentinela().length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(out).toBeNull();
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhasComSentinela()).toEqual([]);
  });

  it('CONTROLE NEGATIVO: uuid conhecido resolve e NÃO grita', async () => {
    const r = await resolverReal();
    linhas = [];
    const out = r.resolveLabel(CAMPO_CLINICO, UUID_CONHECIDO);
    console.log(`>>> C3/controle-negativo/label | out=${JSON.stringify(out)} | avisos=${linhas.length} (esperado 0)`);
    expect(out).toBe(ROTULO_CONHECIDO);
    expect(linhas.length).toBe(0);
  });
});

describe('C3 — a trava é INCONDICIONAL, não uma lista de campos clínicos', () => {
  it('o campo NÃO-clínico de hoje (`Tipo de Dispositivo`) também não vaza o uuid', async () => {
    const r = await resolverReal();
    linhas = [];
    r.resolveLabels(CAMPO_NAO_CLINICO, [SENTINELA_UUID_A]);
    console.log(`>>> C3/incondicional | avisos=${linhas.length} | com sentinela=${linhasComSentinela().length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhasComSentinela()).toEqual([]);
  });

  it('varredura do FONTE: nenhuma linha de log do resolver carrega o valor cru', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const alvo = path.join(__dirname, '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver.ts');
    const fonte = fs.readFileSync(alvo, 'utf8');
    // Só as linhas de emissão — comentários citam os nomes proibidos de propósito.
    const linhasDeLog = fonte.split('\n').filter(l => /console\.(warn|error|log)|logger\./.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
    const proibidas = linhasDeLog.filter(l => /optionId\s*:|orderindex\s*:|\blabel\s*:|taskId\s*:/.test(l));
    console.log(`>>> C3/fonte | linhas de emissão=${linhasDeLog.length} | com campo proibido=${proibidas.length} (esperado 0)`);
    proibidas.forEach(l => console.log(`    PROIBIDA: ${l.trim()}`));
    expect(linhasDeLog.length).toBeGreaterThan(0);   // contagem zero = varredura que não mediu
    expect(proibidas).toEqual([]);
  });
});
