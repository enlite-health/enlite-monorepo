/**
 * Task 2.2 — segmento CRU múltiplo, teto 3, e o rótulo literal gravado mesmo com derivado nulo.
 *
 * ── REGISTRO DE ACESSO (C7 do parecer do `lex` de 23/08/2026) ────────────────
 *   Autorizado por: Gabriel — task 2.2 da change `campos-admissao`, escopo "implementar e
 *     verificar, sem merge e sem rodar em produção".
 *   O que esta fixture lê: NADA. Zero rede, zero banco (o `pg` é um duplo), zero API do
 *     ClickUp, zero ficha de paciente. Todo rótulo aqui é SINTÉTICO, escrito neste arquivo.
 *   Nada foi gravado, nada há para apagar.
 *
 * ── O QUE ELA PROVA ──────────────────────────────────────────────────────────
 *   teto      o 4º rótulo é RECUSADO com registro, e os 3 primeiros seguem intactos —
 *             nos dois caminhos: substituição (o sync) e acréscimo (a 4ª classificação).
 *   literal   o rótulo vai para o banco EXATAMENTE como veio, inclusive com NBSP no fim,
 *             e é gravado quando o mapa NÃO deriva nada (é o ponto inteiro da D-A.2).
 *   C1        a linha de log não carrega o rótulo nem o identificador do paciente — com
 *             CONTROLE POSITIVO, porque contagem zero sem controle é falha (D157/F19).
 *
 * ── E, DESDE A RODADA DE CONSERTO, OS DEFEITOS DO QA-CAÇA ────────────────────
 *   defeito 1  o dia em que `Segmentos Clínicos` virar `labels` — o PLANO desta fase — não
 *              pode parar o sync inteiro; e não pode, também, voltar a apagar dado.
 *   defeito 2  origem ILEGÍVEL não apaga o cru; vazio LEGÍTIMO continua apagando (D-E).
 *   defeito 3  o registro durável da recusa não sai pela transação do chamador.
 *   defeito 4  o par DELETE+INSERT é serializado por (paciente, campo).
 *   defeito 7  a trava de alvo lê a URL com o parser de QUEM CONECTA.
 *   defeito 8  a recusa repetida não vira linha nova nem aviso novo.
 *
 * ⚠️ O TETO DE VERDADE É O DO BANCO (migration 304: PK + CHECK, sem quarta posição). Este
 *    arquivo prova a camada que grita e trunca com registro; a prova de que o BANCO recusa
 *    está em `scripts/verificar-2.2-teto-no-banco.ts`, e a dos defeitos 2/3/4/8 contra um
 *    Postgres de verdade está em `scripts/verificar-2.2-defeitos.ts` — ambos rodados contra
 *    o Postgres local em docker.
 */

import { parse as parseConnectionString } from 'pg-connection-string';

// Pela PORTA da frente: o barrel `@modules/case` é a única entrada permitida ao módulo
// (`.eslintrc.js` proíbe importar de `case/infrastructure/*` direto). Importar daqui é o
// que torna a linha de export uma peça VIVA — arrancá-la do barrel derruba esta suíte, em
// vez de passar despercebida.
import {
  PatientSourceLabelRepository,
  PatientSourceLabelCeilingError,
  PATIENT_SOURCE_LABEL_CEILING,
  sourceLabelsRead,
  sourceLabelsUnreadable,
} from '@modules/case';
// `classify` é interna: não faz parte da superfície pública do módulo, e o teste do puro
// tem de alcançá-la sem inflar o barrel.
import { classify } from '../../../src/modules/case/infrastructure/PatientSourceLabelRepository';
import { mapClickUpClinicalSpecialty } from '../../../src/modules/integration/infrastructure/clickup/mappings/clinicalSpecialtyMap';
import { assertLocalDatabaseTarget, LOCAL_DB_HOSTS, LOCAL_DB_PORTS, LOCAL_DB_NAME } from '../../../src/shared/database/assertLocalDatabaseTarget';
import { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { ClickUpUnreadableFieldError } from '../../../src/modules/integration/infrastructure/clickup/helpers/dropdownCatalogGuard';
import { resolveCatalogValue } from '../../../src/modules/integration/infrastructure/clickup/helpers/resolveCatalogValue';
import { CATALOGO_PACIENTES_FASE0, type ClickUpCatalogField } from '../../fixtures/clickup/catalogo-pacientes-fase0';
import type { ClickUpTask, ClickUpTaskCustomField } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';

// ── Sentinelas: nada disto pode aparecer em linha de log ──────────────────────
const PACIENTE = 'SENTINELA-PACIENTE-0000-0000-000000000001';
const CAMPO = 'Segmentos Clínicos';
const S1 = 'AT para Pacientes con TEA';
const S2 = 'Cuidado Integral de Pacientes con TEA';
const S3 = 'AT para Pacientes con Enfermedades Neurológicas';
const S4_RECUSADO = 'SENTINELA-SEGMENTO-RECUSADO-XYZ';
// Rótulo da lista do Javier que termina em NBSP ( ) — task 1.6.
const COM_NBSP = 'Cuidado Humano Integral ';

// ── Duplo do `pg` ─────────────────────────────────────────────────────────────
// `via` existe por causa do DEFEITO 3: não basta saber que a recusa foi gravada, é preciso
// saber POR QUAL CONEXÃO — gravar pela transação do chamador é exatamente o defeito.
interface Chamada { sql: string; params: unknown[]; via: string }

function makeMockPool(respostas: (sql: string) => { rows: unknown[] } = () => ({ rows: [] })) {
  const chamadas: Chamada[] = [];
  let nConexoes = 0;

  const padrao = (sql: string): { rows: unknown[] } => {
    const r = respostas(sql);
    // A recusa devolve `occurrences` (1 = inédita) e `warn_now` (o BANCO decidiu que esta
    // recusa deve gritar nesta rodada). Sem isto, o duplo mentiria dizendo que toda recusa é
    // repetida e o aviso da C1 nunca sairia (defeito 8 ao contrário). Quem quiser simular a
    // REPETIÇÃO ou a REACENSÃO devolve os seus próprios valores e vence este padrão.
    //
    // ⚠️ `warn_now` NÃO é derivado de `occurrences` aqui de propósito: o conserto do defeito 4
    // da 2ª rodada é exatamente ter dessolidarizado as duas coisas (uma recusa na 40ª
    // ocorrência PODE gritar, se a janela venceu). Um duplo que derivasse um do outro não
    // conseguiria distinguir o conserto do defeito.
    if (sql.trim().startsWith('INSERT INTO patient_source_label_rejections') && r.rows.length === 0) {
      return { rows: [{ occurrences: 1, warn_now: true }] };
    }
    return r;
  };

  const fazQuery = (via: string) => jest.fn(async (sql: unknown, params?: unknown[]) => {
    const texto = String(sql);
    chamadas.push({ sql: texto.replace(/\s+/g, ' ').trim(), params: params ?? [], via });
    return padrao(texto);
  });

  const pool = {
    query: fazQuery('pool'),
    connect: jest.fn(async () => {
      nConexoes += 1;
      const via = `own-${nConexoes}`;
      return { query: fazQuery(via), release: jest.fn() };
    }),
  };
  return { pool, chamadas };
}

/** O client do CHAMADOR — a transação que `PatientService.runUpsertTransaction` abre. */
function makeCallerClient(chamadas: Chamada[], respostas: (sql: string) => { rows: unknown[] } = () => ({ rows: [] })) {
  return {
    query: jest.fn(async (sql: unknown, params?: unknown[]) => {
      const texto = String(sql);
      chamadas.push({ sql: texto.replace(/\s+/g, ' ').trim(), params: params ?? [], via: 'caller' });
      if (texto.trim().startsWith('INSERT INTO patient_source_label_rejections')) return { rows: [{ occurrences: 1, warn_now: true }] };
      return respostas(texto);
    }),
    release: jest.fn(),
  };
}

function makeRepo(pool: unknown): PatientSourceLabelRepository {
  const repo = Object.create(PatientSourceLabelRepository.prototype);
  (repo as { pool: unknown }).pool = pool;
  return repo as PatientSourceLabelRepository;
}

const inserts = (c: Chamada[]) => c.filter(x => x.sql.startsWith('INSERT INTO patient_source_labels '));
const rejeicoes = (c: Chamada[]) => c.filter(x => x.sql.startsWith('INSERT INTO patient_source_label_rejections'));
const deletes = (c: Chamada[]) => c.filter(x => x.sql.startsWith('DELETE FROM patient_source_labels'));
const locks = (c: Chamada[]) => c.filter(x => x.sql.includes('pg_advisory_xact_lock'));

// ── Espião de console.warn ────────────────────────────────────────────────────
let linhas: string[] = [];
let spy: jest.SpyInstance;
const serializa = (args: unknown[]) => args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
const AGULHAS = [PACIENTE, S1, S2, S3, S4_RECUSADO, 'Cuidado Humano Integral'];
const linhasComSentinela = () => linhas.filter(l => AGULHAS.some(a => l.includes(a)));

beforeEach(() => {
  linhas = [];
  spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { linhas.push(serializa(args)); });
});
afterEach(() => spy.mockRestore());

// ─────────────────────────────────────────────────────────────────────────────
describe('2.2 — a premissa do desenho: o mapa NÃO deriva estes rótulos', () => {
  it('CONTROLE: `Cuidado Humano Integral` não tem eixo de especialidade → derivado NULO', () => {
    const derivado = mapClickUpClinicalSpecialty(COM_NBSP);
    const derivadoConhecido = mapClickUpClinicalSpecialty(S1);
    console.log(`>>> 2.2/premissa | '${COM_NBSP.replace(/ /g, '<NBSP>')}' → derivado=${JSON.stringify(derivado)}`);
    console.log(`>>> 2.2/premissa | CONTROLE POSITIVO '${S1}' → derivado=${JSON.stringify(derivadoConhecido)}`);
    expect(derivado).toBeNull();          // é o caso que existia para perder o dado
    expect(derivadoConhecido).not.toBeNull();  // e o mapa não está simplesmente morto
  });
});

describe('2.2 — o rótulo LITERAL é gravado mesmo quando o derivado é nulo (D-A.2)', () => {
  it('grava o rótulo com NBSP no fim, sem aparar, e sem depender do derivado', async () => {
    const { pool, chamadas } = makeMockPool();
    await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([COM_NBSP]) });

    const gravados = inserts(chamadas);
    const rotuloGravado = gravados[0].params[3] as string;
    console.log(`>>> 2.2/literal | INSERTs=${gravados.length} | ordinal=${gravados[0].params[2]}`);
    console.log(`>>> 2.2/literal | gravado=${JSON.stringify(rotuloGravado)} (termina em NBSP? ${rotuloGravado.endsWith(' ')})`);
    console.log(`>>> 2.2/literal | derivado do mesmo rótulo=${JSON.stringify(mapClickUpClinicalSpecialty(rotuloGravado))}`);
    expect(gravados).toHaveLength(1);
    expect(rotuloGravado).toBe(COM_NBSP);             // literal: byte a byte
    expect(rotuloGravado.endsWith(' ')).toBe(true);
    expect(mapClickUpClinicalSpecialty(rotuloGravado)).toBeNull();  // e o derivado segue nulo
  });

  it('os dois tiers do MESMO eixo ficam DISTINTOS no cru (F32 — o defeito que a fase conserta)', async () => {
    const a = makeMockPool(); const b = makeMockPool();
    await makeRepo(a.pool).replaceForField({ patientId: PACIENTE + '-a', fieldName: CAMPO, read: sourceLabelsRead([S1]) });
    await makeRepo(b.pool).replaceForField({ patientId: PACIENTE + '-b', fieldName: CAMPO, read: sourceLabelsRead([S2]) });
    const cruA = inserts(a.chamadas)[0].params[3];
    const cruB = inserts(b.chamadas)[0].params[3];
    console.log(`>>> 2.2/tiers | derivado A=${mapClickUpClinicalSpecialty(S1)} B=${mapClickUpClinicalSpecialty(S2)} (iguais: ${mapClickUpClinicalSpecialty(S1) === mapClickUpClinicalSpecialty(S2)})`);
    console.log(`>>> 2.2/tiers | cru A=${JSON.stringify(cruA)} | cru B=${JSON.stringify(cruB)} (diferentes: ${cruA !== cruB})`);
    expect(mapClickUpClinicalSpecialty(S1)).toBe(mapClickUpClinicalSpecialty(S2)); // o derivado colapsa
    expect(cruA).not.toBe(cruB);                                                   // o cru não
  });
});

describe('2.2 — o teto de 3 no caminho de SUBSTITUIÇÃO (o sync)', () => {
  it('4 rótulos → 3 gravados + 1 recusado com registro, e nada é descartado calado', async () => {
    const { pool, chamadas } = makeMockPool();
    const r = await makeRepo(pool).replaceForField({
      patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3, S4_RECUSADO]),
    });
    const gravados = inserts(chamadas);
    const registros = rejeicoes(chamadas);
    console.log(`>>> 2.2/teto | teto=${PATIENT_SOURCE_LABEL_CEILING} recebidos=${r.received} aceitos=${r.accepted.length} recusados=${r.rejected.length}`);
    console.log(`>>> 2.2/teto | ordinais gravados=${JSON.stringify(gravados.map(g => g.params[2]))}`);
    console.log(`>>> 2.2/teto | motivo do recusado=${JSON.stringify(r.rejected.map(x => x.reason))} | INSERTs de recusa=${registros.length}`);
    expect(gravados).toHaveLength(3);
    expect(gravados.map(g => g.params[2])).toEqual([1, 2, 3]);
    expect(gravados.map(g => g.params[3])).toEqual([S1, S2, S3]);   // os 3 primeiros, na ordem
    expect(r.rejected).toEqual([{ rawLabel: S4_RECUSADO, reason: 'ceiling' }]);
    expect(registros).toHaveLength(1);                              // registro DURÁVEL, no banco
    expect(registros[0].params[3]).toBe('ceiling');
    expect(deletes(chamadas)).toHaveLength(1);                      // substitui, não acumula
    expect(r.outcome).toBe('written');
  });

  it('duplicata exata não vira segunda linha, e é registrada', async () => {
    const { pool, chamadas } = makeMockPool();
    const r = await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S1, S2]) });
    console.log(`>>> 2.2/duplicata | aceitos=${JSON.stringify(r.accepted)} | recusados=${JSON.stringify(r.rejected)}`);
    expect(r.accepted).toEqual([S1, S2]);
    expect(r.rejected).toEqual([{ rawLabel: S1, reason: 'duplicate' }]);
    expect(inserts(chamadas)).toHaveLength(2);
  });

  it('vazio legítimo (null/undefined) é AUSÊNCIA, não recusa — e não gera registro nem aviso', async () => {
    const { pool, chamadas } = makeMockPool();
    const r = await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([null, undefined]) });
    console.log(`>>> 2.2/vazio | recebidos=${r.received} vazios=${r.empty} aceitos=${r.accepted.length} recusados=${r.rejected.length} avisos=${linhas.length}`);
    expect(r.empty).toBe(2);
    expect(r.rejected).toEqual([]);
    expect(rejeicoes(chamadas)).toHaveLength(0);
    expect(linhas).toHaveLength(0);
  });

  it('valor que NÃO é rótulo (número, array, string em branco) é recusado, não coagido (C5)', async () => {
    const { pool } = makeMockPool();
    const r = await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([0, [], '   ', false]) });
    console.log(`>>> 2.2/C5 | aceitos=${r.accepted.length} | recusados=${JSON.stringify(r.rejected.map(x => x.reason))}`);
    r.rejected.forEach(x => console.log(`    recusado: ${JSON.stringify(x)}`));
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map(x => x.reason)).toEqual(['blank', 'blank', 'blank', 'blank']);
  });

  it('idempotente: a mesma lista duas vezes produz os mesmos 3 INSERTs e nenhuma recusa', async () => {
    const a = makeMockPool(); const b = makeMockPool();
    const repoA = makeRepo(a.pool); const repoB = makeRepo(b.pool);
    await repoA.replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3]) });
    await repoB.replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3]) });
    const pa = inserts(a.chamadas).map(x => [x.params[2], x.params[3]]);
    const pb = inserts(b.chamadas).map(x => [x.params[2], x.params[3]]);
    console.log(`>>> 2.2/idempotente | 1ª=${JSON.stringify(pa)} | 2ª=${JSON.stringify(pb)} | iguais=${JSON.stringify(pa) === JSON.stringify(pb)}`);
    expect(pb).toEqual(pa);
    expect(rejeicoes(a.chamadas)).toHaveLength(0);
  });
});

describe('2.2 — o teto de 3 no caminho de ACRÉSCIMO (a "quarta classificação" da spec)', () => {
  const tresCheios = { rows: [
    { ordinal: 1, raw_label: S1 }, { ordinal: 2, raw_label: S2 }, { ordinal: 3, raw_label: S3 },
  ] };

  it('o 4º é RECUSADO com erro nomeado + registro, e os 3 anteriores ficam INTACTOS', async () => {
    const { pool, chamadas } = makeMockPool(sql => (sql.trim().startsWith('SELECT') ? tresCheios : { rows: [] }));
    const repo = makeRepo(pool);
    let erro: unknown = null;
    try {
      await repo.appendForField({ patientId: PACIENTE, fieldName: CAMPO, label: S4_RECUSADO });
    } catch (e) { erro = e; }

    console.log(`>>> 2.2/append | erro=${(erro as Error)?.name} | msg=${(erro as Error)?.message}`);
    console.log(`>>> 2.2/append | INSERTs em patient_source_labels=${inserts(chamadas).length} (esperado 0 — os 3 intactos)`);
    console.log(`>>> 2.2/append | INSERTs de recusa=${rejeicoes(chamadas).length} | motivo=${JSON.stringify(rejeicoes(chamadas)[0]?.params[3])}`);
    console.log(`>>> 2.2/append | DELETEs=${deletes(chamadas).length} (esperado 0 — recusar não apaga)`);
    expect(erro).toBeInstanceOf(PatientSourceLabelCeilingError);
    expect(inserts(chamadas)).toHaveLength(0);      // nada gravado
    expect(deletes(chamadas)).toHaveLength(0);      // e nada apagado: os 3 seguem lá
    expect(rejeicoes(chamadas)).toHaveLength(1);
    expect(rejeicoes(chamadas)[0].params[3]).toBe('ceiling');
  });

  it('CONTROLE POSITIVO: com 2 gravados, o 3º ENTRA (a trava não é "recusar sempre")', async () => {
    const dois = { rows: [{ ordinal: 1, raw_label: S1 }, { ordinal: 2, raw_label: S2 }] };
    const { pool, chamadas } = makeMockPool(sql => (sql.trim().startsWith('SELECT') ? dois : { rows: [] }));
    const r = await makeRepo(pool).appendForField({ patientId: PACIENTE, fieldName: CAMPO, label: S3 });
    console.log(`>>> 2.2/append-controle | aceito=${JSON.stringify(r.accepted)} | ordinal=${inserts(chamadas)[0]?.params[2]}`);
    expect(r.accepted).toEqual([S3]);
    expect(inserts(chamadas)).toHaveLength(1);
    expect(inserts(chamadas)[0].params[2]).toBe(3);
  });
});

describe('2.2 — C1: a linha de log não carrega rótulo nem paciente', () => {
  it('CONTROLE POSITIVO: o detector ACUSA a sentinela quando ela está na linha', () => {
    console.warn('[CONTROLE POSITIVO — formato proibido de propósito]', {
      field: CAMPO, patientId: PACIENTE, rawLabel: S4_RECUSADO,
    });
    const achadas = linhasComSentinela();
    console.log(`>>> 2.2/C1-controle | capturadas=${linhas.length} | detector achou=${achadas.length} (esperado >0)`);
    console.log(`>>> 2.2/C1-controle | linha acusada: ${achadas[0]}`);
    expect(linhas.length).toBeGreaterThan(0);
    expect(achadas.length).toBeGreaterThan(0);
  });

  it('a recusa do teto GRITA — com campo e contagem, sem rótulo e sem paciente', async () => {
    const { pool } = makeMockPool();
    linhas = [];
    await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3, S4_RECUSADO]) });
    const achadas = linhasComSentinela();
    console.log(`>>> 2.2/C1 | avisos=${linhas.length} | com sentinela=${achadas.length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(linhas.length).toBeGreaterThan(0);          // não descartou calado
    expect(achadas).toEqual([]);                        // e não vazou nada
    expect(linhas.some(l => l.includes('"rejected":1'))).toBe(true);   // o operador sabe QUANTOS
    expect(linhas.some(l => l.includes(CAMPO))).toBe(true);            // e em QUAL campo
  });

  it('a recusa no ACRÉSCIMO também grita sem vazar', async () => {
    const tres = { rows: [{ ordinal: 1, raw_label: S1 }, { ordinal: 2, raw_label: S2 }, { ordinal: 3, raw_label: S3 }] };
    const { pool } = makeMockPool(sql => (sql.trim().startsWith('SELECT') ? tres : { rows: [] }));
    linhas = [];
    await makeRepo(pool).appendForField({ patientId: PACIENTE, fieldName: CAMPO, label: S4_RECUSADO }).catch((e: Error) => {
      console.log(`>>> 2.2/C1-append | mensagem do erro: ${e.message}`);
      expect(e.message).not.toContain(S4_RECUSADO);
      expect(e.message).not.toContain(PACIENTE);
    });
    console.log(`>>> 2.2/C1-append | avisos=${linhas.length} | com sentinela=${linhasComSentinela().length} (esperado 0)`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhasComSentinela()).toEqual([]);
  });
});

describe('2.2 — `classify` puro: a lista de permissão', () => {
  it('tabela de casos', () => {
    const casos: Array<[string, unknown[], number, number]> = [
      ['3 distintos', [S1, S2, S3], 3, 0],
      ['4 distintos', [S1, S2, S3, S4_RECUSADO], 3, 1],
      ['5 distintos', [S1, S2, S3, S4_RECUSADO, 'X'], 3, 2],
      ['1 só', [S1], 1, 0],
      ['nenhum', [], 0, 0],
      ['null/undefined', [null, undefined], 0, 0],
    ];
    for (const [nome, entrada, aceitos, recusados] of casos) {
      const r = classify(entrada);
      console.log(`>>> classify | ${nome.padEnd(16)} → aceitos=${r.accepted.length} recusados=${r.rejected.length} vazios=${r.empty}`);
      expect(r.accepted).toHaveLength(aceitos);
      expect(r.rejected).toHaveLength(recusados);
    }
    expect(casos.length).toBeGreaterThan(0);   // tabela vazia seria "não mediu"
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFEITO 2 — "não consegui ler" NUNCA pode virar "está vazio"
// ═════════════════════════════════════════════════════════════════════════════
/**
 * O QA mediu: com 3 rótulos gravados, `replaceForField({labels: []})` e `{labels: null}`
 * deixavam a tabela VAZIA, devolviam sucesso e não registravam nada. E `[]` é o que
 * `ClickUpFieldResolver.resolveLabels` devolve QUANDO NÃO CONSEGUE LER O CAMPO — a mesma
 * forma para as duas coisas. O rename na origem, que é o evento contra o qual esta tabela
 * existe, era o evento que a esvaziava.
 *
 * A régua aqui mede o DELETE: apagar é o dano, então é o DELETE que tem de sumir.
 */
describe('2.2/defeito 2 — origem ILEGÍVEL não apaga o cru', () => {
  it('origem ilegível: ZERO DELETE, ZERO INSERT, e o aviso diz por quê', async () => {
    const { pool, chamadas } = makeMockPool();
    const r = await makeRepo(pool).replaceForField({
      patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsUnreadable('field-not-in-catalog'),
    });
    console.log(`>>> 2.2/d2 | outcome=${r.outcome} | DELETEs=${deletes(chamadas).length} | INSERTs=${inserts(chamadas).length} | avisos=${linhas.length}`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));
    expect(r.outcome).toBe('skipped-unreadable');
    expect(deletes(chamadas)).toHaveLength(0);      // <<< o dano medido pelo QA
    expect(inserts(chamadas)).toHaveLength(0);
    expect(linhas.length).toBeGreaterThan(0);       // ilegível não é silêncio
    expect(linhas.some(l => l.includes('field-not-in-catalog'))).toBe(true);
    expect(linhasComSentinela()).toEqual([]);       // C1: sem rótulo, sem paciente
  });

  it('CONTROLE POSITIVO: vazio LEGÍTIMO continua apagando — a D-E proíbe congelar', async () => {
    const { pool, chamadas } = makeMockPool();
    const r = await makeRepo(pool).replaceForField({
      patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([]),
    });
    console.log(`>>> 2.2/d2-controle | outcome=${r.outcome} | DELETEs=${deletes(chamadas).length} (esperado 1) | INSERTs=${inserts(chamadas).length}`);
    expect(r.outcome).toBe('written');
    expect(deletes(chamadas)).toHaveLength(1);      // não é COALESCE: vazio se escreve
    expect(inserts(chamadas)).toHaveLength(0);
  });

  it('a distinção é do TIPO, não da boa vontade do chamador: as duas formas existem e diferem', () => {
    const lido = sourceLabelsRead([]);
    const ilegivel = sourceLabelsUnreadable('wrong-type');
    console.log(`>>> 2.2/d2-tipo | lido=${JSON.stringify(lido)} | ilegível=${JSON.stringify(ilegivel)}`);
    expect(lido.readable).toBe(true);
    expect(ilegivel.readable).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFEITO 3 — o registro durável não sai pela transação do chamador
// ═════════════════════════════════════════════════════════════════════════════
/**
 * O QA mediu, contra o Postgres de verdade: a recusa era gravada com o client do chamador e
 * o `ROLLBACK` de `PatientService.runUpsertTransaction:211` a levava junto (recusas: 1 → 0).
 * Sobrava o `console.warn` com contagem — o alarme cujo endereço foi apagado.
 *
 * Aqui a régua é de ROTEAMENTO: a linha de recusa NÃO pode sair pela conexão do chamador.
 * A prova contra um banco real (a linha sobrevive ao ROLLBACK) está em
 * `scripts/verificar-2.2-defeitos.ts`.
 */
describe('2.2/defeito 3 — a recusa é gravada FORA da transação do chamador', () => {
  const tresCheios = { rows: [
    { ordinal: 1, raw_label: S1 }, { ordinal: 2, raw_label: S2 }, { ordinal: 3, raw_label: S3 },
  ] };

  it('append do 4º dentro da transação do chamador: a recusa sai por OUTRA conexão', async () => {
    const { pool, chamadas } = makeMockPool();
    const caller = makeCallerClient(chamadas, sql => (sql.trim().startsWith('SELECT') ? tresCheios : { rows: [] }));

    await makeRepo(pool)
      .appendForField({ patientId: PACIENTE, fieldName: CAMPO, label: S4_RECUSADO }, caller as never)
      .catch(() => { /* o `PatientSourceLabelCeilingError` é esperado e já tem régua acima */ });

    const reg = rejeicoes(chamadas);
    const leituraDosGravados = chamadas.filter(c => c.sql.startsWith('SELECT ordinal, raw_label'));
    console.log(`>>> 2.2/d3 | INSERTs de recusa=${reg.length} | via=${JSON.stringify(reg.map(x => x.via))} (esperado: NENHUM "caller")`);
    console.log(`>>> 2.2/d3 | CONTROLE POSITIVO — a leitura dos gravados saiu por=${JSON.stringify(leituraDosGravados.map(x => x.via))} (tem de ser "caller")`);
    expect(reg).toHaveLength(1);
    expect(reg.map(x => x.via)).not.toContain('caller');   // <<< o defeito
    expect(reg[0].via.startsWith('own-')).toBe(true);      // conexão própria do pool
    // Controle positivo do instrumento: o resto do trabalho REALMENTE passou pelo chamador —
    // se tudo estivesse saindo por conexão própria, a régua acima passaria sem medir nada.
    expect(leituraDosGravados.map(x => x.via)).toEqual(['caller']);
  });

  it('a recusa gravada fora traz paciente e valor — as duas metades da spec, cada uma no seu destino', async () => {
    const { pool, chamadas } = makeMockPool();
    const caller = makeCallerClient(chamadas, sql => (sql.trim().startsWith('SELECT') ? tresCheios : { rows: [] }));
    await makeRepo(pool)
      .appendForField({ patientId: PACIENTE, fieldName: CAMPO, label: S4_RECUSADO }, caller as never)
      .catch(() => { /* esperado */ });

    const reg = rejeicoes(chamadas)[0];
    console.log(`>>> 2.2/d3-spec | no BANCO: paciente=${JSON.stringify(reg.params[0])} rótulo=${JSON.stringify(reg.params[2])} motivo=${JSON.stringify(reg.params[3])}`);
    console.log(`>>> 2.2/d3-spec | no LOG: ${linhas.join(' | ')}`);
    expect(reg.params[0]).toBe(PACIENTE);        // spec: "identificando o paciente"
    expect(reg.params[2]).toBe(S4_RECUSADO);     // spec: "e o valor recusado"
    expect(linhasComSentinela()).toEqual([]);    // C1: e nada disso no log
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFEITO 4 — DELETE+INSERT serializado por (paciente, campo)
// ═════════════════════════════════════════════════════════════════════════════
describe('2.2/defeito 4 — o par DELETE+INSERT é serializado', () => {
  it('o lock consultivo é tomado ANTES do DELETE, com a chave (paciente, campo)', async () => {
    const { pool, chamadas } = makeMockPool();
    await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S2]) });

    const iLock = chamadas.findIndex(c => c.sql.includes('pg_advisory_xact_lock'));
    const iDelete = chamadas.findIndex(c => c.sql.startsWith('DELETE FROM patient_source_labels'));
    console.log(`>>> 2.2/d4 | locks=${locks(chamadas).length} | índice do lock=${iLock} | índice do DELETE=${iDelete}`);
    console.log(`>>> 2.2/d4 | chave do lock=${JSON.stringify(locks(chamadas)[0]?.params)}`);
    expect(locks(chamadas)).toHaveLength(1);
    expect(iLock).toBeGreaterThanOrEqual(0);
    expect(iDelete).toBeGreaterThan(iLock);              // <<< tomar depois não protegeria nada
    expect(locks(chamadas)[0].params).toContain(PACIENTE);
    expect(locks(chamadas)[0].params).toContain(CAMPO);
    expect(locks(chamadas)[0].sql).toContain('_xact_');  // solta no fim da transação, sempre
  });

  it('o caminho de ACRÉSCIMO toma o MESMO lock (senão os dois caminhos não se serializam entre si)', async () => {
    const dois = { rows: [{ ordinal: 1, raw_label: S1 }, { ordinal: 2, raw_label: S2 }] };
    const { pool, chamadas } = makeMockPool(sql => (sql.trim().startsWith('SELECT ordinal') ? dois : { rows: [] }));
    await makeRepo(pool).appendForField({ patientId: PACIENTE, fieldName: CAMPO, label: S3 });

    const iLock = chamadas.findIndex(c => c.sql.includes('pg_advisory_xact_lock'));
    const iSelect = chamadas.findIndex(c => c.sql.startsWith('SELECT ordinal, raw_label'));
    console.log(`>>> 2.2/d4-append | índice do lock=${iLock} | índice da leitura=${iSelect} | locks=${locks(chamadas).length}`);
    expect(locks(chamadas)).toHaveLength(1);
    expect(iSelect).toBeGreaterThan(iLock);   // ler-e-decidir tem de estar DENTRO do lock
  });

  it('sem transação NENHUMA o lock seria inútil: o caminho sem client abre a sua', async () => {
    const { pool, chamadas } = makeMockPool();
    await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1]) });
    const begins = chamadas.filter(c => c.sql === 'BEGIN');
    const commits = chamadas.filter(c => c.sql === 'COMMIT');
    console.log(`>>> 2.2/d4-tx | BEGIN=${begins.length} COMMIT=${commits.length} | via=${JSON.stringify(begins.map(b => b.via))}`);
    expect(begins.length).toBeGreaterThanOrEqual(1);
    expect(commits.length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFEITO 8 — a recusa repetida não vira linha nova nem aviso novo
// ═════════════════════════════════════════════════════════════════════════════
describe('2.2/defeito 8 — recusa repetida não acumula linha nem afoga o alarme', () => {
  it('o INSERT de recusa é um UPSERT por (paciente, campo, rótulo, motivo), com contador', async () => {
    const { pool, chamadas } = makeMockPool();
    await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3, S4_RECUSADO]) });
    const sql = rejeicoes(chamadas)[0].sql;
    console.log(`>>> 2.2/d8 | SQL da recusa: ${sql}`);
    expect(sql).toContain('ON CONFLICT (patient_id, field_name, raw_label, reason) DO UPDATE');
    expect(sql).toContain('occurrences = patient_source_label_rejections.occurrences + 1');
    expect(sql).toContain('RETURNING occurrences');
    // Defeito 4 da 2ª rodada: o silêncio é uma JANELA decidida no banco, não `occurrences = 1`.
    expect(sql).toContain('last_warned_at = CASE');
    expect(sql).toContain('(last_warned_at >= NOW()) AS warn_now');
  });

  it('recusa INÉDITA grita; a MESMA recusa de novo não grita (e o contador é quem cresce)', async () => {
    const inedita = makeMockPool();
    linhas = [];
    const r1 = await makeRepo(inedita.pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3, S4_RECUSADO]) });
    const avisosInedita = linhas.length;

    // 2ª rodada: o banco devolve `occurrences: 4` e `warn_now: false` — é a MESMA recusa, pela
    // 4ª vez, DENTRO da janela de silêncio. Quem decide é o banco (`last_warned_at`).
    const repetida = makeMockPool(sql =>
      sql.trim().startsWith('INSERT INTO patient_source_label_rejections')
        ? { rows: [{ occurrences: 4, warn_now: false }] } : { rows: [] });
    linhas = [];
    const r2 = await makeRepo(repetida.pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3, S4_RECUSADO]) });
    const avisosRepetida = linhas.length;

    console.log(`>>> 2.2/d8-alarme | 1ª vez: recusas=${r1.rejected.length} inéditas=${r1.newlyRejected} avisos=${avisosInedita}`);
    console.log(`>>> 2.2/d8-alarme | repetida: recusas=${r2.rejected.length} inéditas=${r2.newlyRejected} avisos=${avisosRepetida}`);
    console.log(`>>> 2.2/d8-alarme | linhas de recusa gravadas na repetição=${rejeicoes(repetida.chamadas).length} (1 UPSERT, não 1 linha nova)`);
    expect(r1.newlyRejected).toBe(1);
    expect(avisosInedita).toBeGreaterThan(0);   // CONTROLE POSITIVO: o alarme funciona
    expect(r2.newlyRejected).toBe(0);
    expect(avisosRepetida).toBe(0);             // <<< 5 re-syncs não são 5 avisos
    expect(rejeicoes(repetida.chamadas)).toHaveLength(1);
  });

  // ⚠️ O índice único que torna o dedupe ESTRUTURAL vive na migration 304, e a régua dele NÃO
  // mora aqui de propósito: a árvore-sombra do guardian é montada com `src`, `tests`,
  // `jest.config.js`, `tsconfig.json` e `package.json` — `migrations/` não entra, e um teste que
  // lesse aquele arquivo ficaria vermelho na sombra por ausência do arquivo, não por defeito.
  // A prova dele é MELHOR onde está: `scripts/verificar-2.2-defeitos.ts` confere o índice no
  // catálogo do Postgres (`pg_indexes`), isto é, no banco de verdade, e não num arquivo.
});

// ═════════════════════════════════════════════════════════════════════════════
// DEFEITO 1 — o dia em que `Segmentos Clínicos` virar `labels`
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Este bloco monta o `ClickUpFieldResolver` REAL (via `fromList` com `fetchImpl` falso — zero
 * rede) e roda o `ClickUpPatientMapper` REAL, nos DOIS mundos: o catálogo de hoje
 * (`drop_down`) e o catálogo depois da virada da Fase 2 (`labels`). É a mesma montagem que o
 * QA usou para medir o defeito, e é a C4 do parecer (a fixture tem de medir o código real).
 */
describe('2.2/defeito 1 — a virada de `drop_down` para `labels` não pode parar o sync', () => {
  const UUID_TEA = 'op-uuid-sintetico-tea';
  const UUID_DESCONHECIDO = 'op-uuid-sintetico-que-nao-existe';

  function respostaDoCatalogo(campos: readonly ClickUpCatalogField[]) {
    return {
      fields: campos.map((f, i) => ({
        id: `cf-${i}`,
        name: f.name,
        type: f.type,
        type_config:
          f.name === CAMPO
            ? { options: [{ id: UUID_TEA, name: S1, label: S1, orderindex: 1 }] }
            : (f.type === 'drop_down' || f.type === 'labels'
                ? { options: [{ id: `op-${i}`, name: `OPCAO-SINTETICA-${i}`, orderindex: 1 }] }
                : {}),
      })),
    };
  }

  async function resolverReal(campos: readonly ClickUpCatalogField[]): Promise<ClickUpFieldResolver> {
    const fetchFalso = (async () => ({
      ok: true, status: 200, statusText: 'OK', json: async () => respostaDoCatalogo(campos),
    })) as unknown as typeof fetch;
    const r = await ClickUpFieldResolver.fromList('lista-sintetica', { token: 'token-sintetico', fetchImpl: fetchFalso });
    expect(r).toBeInstanceOf(ClickUpFieldResolver);   // a CLASSE real, não um stub
    return r;
  }

  const catalogoComTipo = (tipo: string): ClickUpCatalogField[] =>
    CATALOGO_PACIENTES_FASE0.map(f => (f.name === CAMPO ? { name: f.name, type: tipo } : { ...f }));

  const catalogoSemOCampo = (): ClickUpCatalogField[] =>
    CATALOGO_PACIENTES_FASE0.map(f => (f.name === CAMPO ? { name: `${f.name} (RENOMEADO)`, type: f.type } : { ...f }));

  function tarefa(valorDoSegmento: unknown, tipoDoSegmento: string): ClickUpTask {
    return {
      id: 'sintetica-2-2',
      name: 'SOBRENOME-SINTETICO, NOME-SINTETICO',
      status: { status: 'activo', color: '#000', type: 'custom' },
      parent: null,
      custom_fields: [
        { id: 'a', name: 'Nombre de Paciente', type: 'short_text', value: 'NOME-SINTETICO' },
        { id: 'b', name: 'Apellido del Paciente', type: 'short_text', value: 'SOBRENOME-SINTETICO' },
        { id: 'c', name: CAMPO, type: tipoDoSegmento, value: valorDoSegmento },
      ] as ClickUpTaskCustomField[],
      url: 'https://app.clickup.com/t/sintetica-2-2',
      date_created: '1700000000000',
      date_updated: '1700100000000',
    };
  }

  it('CONTROLE POSITIVO — mundo de HOJE (`drop_down`): mapeia e deriva, exatamente como antes', async () => {
    const mapper = new ClickUpPatientMapper(await resolverReal(catalogoComTipo('drop_down')));
    const out = mapper.map(tarefa('1', 'drop_down'));
    console.log(`>>> 2.2/d1-hoje | tipo=drop_down | lançou=NAO | clinicalSpecialty=${JSON.stringify(out?.clinicalSpecialty)}`);
    expect(out).not.toBeNull();
    expect(out!.clinicalSpecialty).toBe(mapClickUpClinicalSpecialty(S1));
    expect(out!.clinicalSpecialty).not.toBeNull();   // o mundo de hoje não regrediu
  });

  it('mundo da FASE 2 (`labels`): NÃO lança, NÃO para o sync, e o derivado continua saindo', async () => {
    const mapper = new ClickUpPatientMapper(await resolverReal(catalogoComTipo('labels')));
    let erro: unknown = null;
    let out = null;
    try { out = mapper.map(tarefa([UUID_TEA], 'labels')); } catch (e) { erro = e; }

    console.log(`>>> 2.2/d1-fase2 | tipo=labels | lançou=${erro ? (erro as Error).name : 'NAO'}`);
    console.log(`>>> 2.2/d1-fase2 | clinicalSpecialty=${JSON.stringify(out?.clinicalSpecialty)} (esperado: o MESMO do mundo drop_down)`);
    expect(erro).toBeNull();                         // <<< o defeito: aqui o sync inteiro parava
    expect(out).not.toBeNull();
    expect(out!.clinicalSpecialty).toBe(mapClickUpClinicalSpecialty(S1));
  });

  it('DEFEITO ALTA (rodada 4 do QA-caça): uuid desconhecido NÃO pode apagar o derivado — o mapper declara ILEGÍVEL', async () => {
    // ⚠️ O QUE ESTE TESTE ERA, E POR QUE MUDOU DE LADO.
    //
    // A versão anterior tinha o título "o derivado NÃO é apagado" e a asserção
    // `expect(out!.clinicalSpecialty).toBeNull()`. As duas coisas se contradizem: o mapper
    // devolvia `null` e `PatientClinicalRepository` fazia `clinical_specialty = $11` com
    // `?? null`, gravando esse `null` POR CIMA de um `'ASD'` já guardado. O teste consagrava
    // o defeito em vez de pegá-lo — título certo, asserção do comportamento errado.
    //
    // Um `null` aqui significava DUAS coisas, que é exatamente o que a D167 proíbe:
    //   - "a origem não preencheu"          → vazio legítimo, e a D-E manda GRAVAR;
    //   - "a origem mandou e eu não traduzi" → leitura impossível, e gravar APAGA.
    // O cru já sabia diferenciar (`skipped-unreadable`). O derivado não — e era apagado no
    // MESMO webhook em que o cru era protegido: o paciente perdia o dado sem ganhar nada.
    const mapper = new ClickUpPatientMapper(await resolverReal(catalogoComTipo('labels')));
    linhas = [];
    const out = mapper.map(tarefa([UUID_DESCONHECIDO], 'labels'));
    console.log(`>>> 2.2/d1-desconhecido | clinicalSpecialty=${JSON.stringify(out?.clinicalSpecialty)} | readable=${JSON.stringify(out?.clinicalSpecialtyReadable)} | avisos=${linhas.length}`);
    linhas.forEach(l => console.log(`    aviso: ${l}`));

    expect(out).not.toBeNull();
    // O valor derivado continua sendo `null` — não há o que derivar de um uuid que não resolve.
    expect(out!.clinicalSpecialty).toBeNull();
    // <<< O CONSERTO: o mapper agora DIZ que não conseguiu ler, e é essa bandeira que impede a
    //     escrita. Sem ela, o `null` acima vira UPDATE e apaga.
    expect(out!.clinicalSpecialtyReadable).toBe(false);
    expect(linhas.length).toBeGreaterThan(0);        // gritou (D-A.1)
    expect(linhas.some(l => l.includes(UUID_DESCONHECIDO))).toBe(false);  // C1/C3: uuid retido
  });

  it('CONTROLE POSITIVO do conserto: vazio LEGÍTIMO continua declarando leitura possível — e portanto ainda apaga (D-E)', async () => {
    // A trava não pode virar "nunca escrever". Campo que a origem deixou em branco é vazio de
    // verdade, e vazio se grava: congelar o valor antigo faria dado velho PARECER dado atual,
    // que é o que a D-E existe para impedir. Sem este controle, o conserto acima passaria
    // igualmente com um `readable:false` chumbado.
    const mapper = new ClickUpPatientMapper(await resolverReal(catalogoComTipo('labels')));
    const out = mapper.map(tarefa(null, 'labels'));
    console.log(`>>> 2.2/d1-vazio-legitimo | clinicalSpecialty=${JSON.stringify(out?.clinicalSpecialty)} | readable=${JSON.stringify(out?.clinicalSpecialtyReadable)}`);
    expect(out).not.toBeNull();
    expect(out!.clinicalSpecialty).toBeNull();
    expect(out!.clinicalSpecialtyReadable).toBe(true);   // <<< o outro lado da distinção
  });

  it('CONTROLE POSITIVO da proteção da 1.11: o campo SUMIR do catálogo continua parando tudo', async () => {
    const mapper = new ClickUpPatientMapper(await resolverReal(catalogoSemOCampo()));
    let erro: unknown = null;
    try { mapper.map(tarefa('1', 'drop_down')); } catch (e) { erro = e; }
    const campos = erro instanceof ClickUpUnreadableFieldError ? erro.fields.map(f => `${f.field}/${f.status}`) : [];
    console.log(`>>> 2.2/d1-renome | lançou=${erro ? (erro as Error).name : 'NAO'} | campos=${JSON.stringify(campos)}`);
    expect(erro).toBeInstanceOf(ClickUpUnreadableFieldError);
    expect(campos).toEqual([`${CAMPO}/missing`]);    // alargar o tipo não afrouxou o rename
  });

  it('CONTROLE POSITIVO: um tipo que o leitor NÃO sabe ler continua parando tudo (wrong_type)', async () => {
    const mapper = new ClickUpPatientMapper(await resolverReal(catalogoComTipo('short_text')));
    let erro: unknown = null;
    try { mapper.map(tarefa('texto livre sintético', 'short_text')); } catch (e) { erro = e; }
    const campos = erro instanceof ClickUpUnreadableFieldError ? erro.fields.map(f => `${f.field}/${f.status}/${f.catalogType}`) : [];
    console.log(`>>> 2.2/d1-texto | lançou=${erro ? (erro as Error).name : 'NAO'} | campos=${JSON.stringify(campos)}`);
    expect(erro).toBeInstanceOf(ClickUpUnreadableFieldError);
    expect(campos).toEqual([`${CAMPO}/wrong_type/short_text`]);
  });

  it('os OUTROS campos continuam aceitando SÓ `drop_down` — a folga é de um campo, não da lista', async () => {
    const catalogo = CATALOGO_PACIENTES_FASE0.map(f =>
      f.name === 'Servicio' ? { name: f.name, type: 'labels' } : { ...f });
    const mapper = new ClickUpPatientMapper(await resolverReal(catalogo));
    let erro: unknown = null;
    try { mapper.map(tarefa('1', 'drop_down')); } catch (e) { erro = e; }
    const campos = erro instanceof ClickUpUnreadableFieldError ? erro.fields.map(f => `${f.field}/${f.status}`) : [];
    console.log(`>>> 2.2/d1-outros | 'Servicio' virou labels → lançou=${erro ? (erro as Error).name : 'NAO'} | campos=${JSON.stringify(campos)}`);
    expect(erro).toBeInstanceOf(ClickUpUnreadableFieldError);
    expect(campos).toEqual(['Servicio/wrong_type']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * A TRAVA DE ALVO do `scripts/verificar-2.2-teto-no-banco.ts`.
 *
 * O script ESCREVE. Há um `cloud-sql-proxy` VIVO em `localhost:5436` apontando para
 * PRODUÇÃO e outro em `localhost:5434` apontando para stage. A trava é o que separa
 * "verificação local" de "escrita em produção" — e trava que nunca foi vista recusando
 * não está provada.
 *
 * Estes casos exercitam a função REAL do script e NÃO abrem conexão nenhuma: a recusa
 * acontece antes de qualquer socket. É de propósito que a prova viva aqui, e não numa
 * execução do script contra a porta 5436.
 */
describe('2.2 — a trava de alvo do script de verificação recusa produção', () => {

  const RECUSAR: Array<[string, string]> = [
    ['PRODUÇÃO (cloud-sql-proxy 5436)', 'postgresql://u:p@localhost:5436/enlite_e2e'],
    ['STAGE (cloud-sql-proxy 5434)',    'postgresql://u:p@localhost:5434/enlite_e2e'],
    ['host remoto',                     'postgresql://u:p@10.20.30.40:5432/enlite_e2e'],
    ['base errada',                     'postgresql://u:p@localhost:5432/enlite-ar-db'],
    ['sem DATABASE_URL',                ''],
    // ── DEFEITO 7 do QA-caça: as formas em que a trava lia diferente de quem conecta ──
    ['?port= redireciona a porta',      'postgresql://u:p@localhost:5432/enlite_e2e?port=5436'],
    ['?host= redireciona para cloudsql','postgresql://u:p@localhost:5432/enlite_e2e?host=/cloudsql/proj:region:inst'],
    ['?port= para o stage',             'postgresql://u:p@localhost:5432/enlite_e2e?port=5434'],
    ['query string inócua também',      'postgresql://u:p@localhost:5432/enlite_e2e?application_name=x'],
    ['socket unix direto',              '/cloudsql/proj:region:inst enlite_e2e'],
  ];

  it.each(RECUSAR)('recusa %s', (nome, url) => {
    let erro: Error | null = null;
    try { assertLocalDatabaseTarget(url || undefined); } catch (e) { erro = e as Error; }
    console.log(`>>> trava | ${String(nome).padEnd(34)} → ${erro ? erro.message : 'PASSOU (não recusou!)'}`);
    expect(erro).not.toBeNull();
    expect(erro!.message).toContain('TRAVA');
  });

  it('CONTROLE POSITIVO: o alvo local legítimo PASSA (a trava não é "recusar sempre")', () => {
    const alvo = assertLocalDatabaseTarget('postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e');
    console.log(`>>> trava | CONTROLE POSITIVO local → ${alvo}`);
    expect(alvo).toBe('localhost:5432/enlite_e2e');
  });

  /**
   * A régua que fecha a CLASSE, e não as duas formas que o QA encontrou: a trava só pode
   * aprovar uma URL cujo alvo EFETIVO — o que `pg` vai abrir, lido com o parser que o `pg`
   * usa — seja o docker local. Qualquer divergência futura entre as duas leituras cai aqui,
   * inclusive uma forma que ninguém pensou em listar.
   */
  it('DEFEITO 7 — o que a trava aprova é o que `pg` REALMENTE abriria', () => {
    const URLS = [
      ...RECUSAR.map(([, u]) => u).filter(Boolean),
      'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e',
      'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e',
      'postgresql://u:p@127.0.0.1:5432/enlite_e2e',
    ];
    let aprovadas = 0;
    let divergencias = 0;

    for (const url of URLS) {
      let passou = true;
      try { assertLocalDatabaseTarget(url); } catch { passou = false; }
      const efetivo = parseConnectionString(url);
      const alvoReal = `${efetivo.host ?? ''}:${(efetivo.port ?? '') || '5432'}/${efetivo.database ?? ''}`;
      const ehLocal =
        (LOCAL_DB_HOSTS as readonly string[]).includes(efetivo.host ?? '') &&
        (LOCAL_DB_PORTS as readonly string[]).includes(((efetivo.port ?? '') || '5432') as string) &&
        efetivo.database === LOCAL_DB_NAME;

      if (passou) aprovadas += 1;
      if (passou && !ehLocal) divergencias += 1;
      console.log(`>>> d7 | trava=${passou ? 'PASSOU ' : 'RECUSOU'} | pg abriria ${alvoReal} | local=${ehLocal}`);
    }

    console.log(`>>> d7 | URLs medidas=${URLS.length} | aprovadas pela trava=${aprovadas} | aprovadas que NÃO eram locais=${divergencias}`);
    expect(URLS.length).toBeGreaterThan(0);
    expect(aprovadas).toBeGreaterThan(0);   // contagem zero seria régua morta: nada foi aprovado
    expect(divergencias).toBe(0);           // <<< o defeito era exatamente isto valer 2
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RODADA 3 — os defeitos que o QA-caça achou NA RODADA DE CONSERTO
// ═════════════════════════════════════════════════════════════════════════════

/**
 * DEFEITO 1 (2ª rodada) — a união discriminada declarava `readable: true` quando o CAMPO
 * existe mas NENHUMA das OPÇÕES resolve. O D167 voltava um nível abaixo, dentro do conserto
 * que existe para fechá-lo: uma opção recriada no ClickUp (o uuid muda, o nome do campo não)
 * fazia `resolveLabels` devolver `[]`, o chamador fiel à união chamava
 * `sourceLabelsRead([])` e os rótulos crus eram APAGADOS com `outcome:'written'`.
 *
 * A distinção que faltava tem TRÊS estados, e este bloco os separa um do outro:
 *   (1) li e está VAZIO DE VERDADE      → apagar é correto (D-E)
 *   (2) li e as opções NÃO RESOLVERAM   → não escrever nada, nem apagar
 *   (3) NÃO CONSEGUI LER (campo sumido) → idem, com outra razão
 *
 * E o PARCIAL (pediu 3, resolvem 2 — F39) é caso (2), nunca (1): gravar os 2 que resolveram
 * apaga o 3º, e uma lista mais curta escrita por cima é perda, não atualização.
 */
describe('2.2/rodada3/defeito 1 — três estados, não dois', () => {
  const U1 = 'op-uuid-sintetico-1';
  const U2 = 'op-uuid-sintetico-2';
  const U3 = 'op-uuid-sintetico-3';
  const U_MORTO_A = 'op-uuid-sintetico-recriado-A';
  const U_MORTO_B = 'op-uuid-sintetico-recriado-B';

  /** Catálogo com `Segmentos Clínicos` em `labels` e TRÊS opções conhecidas. */
  async function resolverComTresOpcoes(tipoDoCampo = 'labels', nomeDoCampo = CAMPO): Promise<ClickUpFieldResolver> {
    const fields = CATALOGO_PACIENTES_FASE0.map((f, i) => {
      const ehONosso = f.name === CAMPO;
      return {
        id: `cf-${i}`,
        name: ehONosso ? nomeDoCampo : f.name,
        type: ehONosso ? tipoDoCampo : f.type,
        type_config: ehONosso
          ? { options: [
              { id: U1, name: S1, label: S1, orderindex: 0 },
              { id: U2, name: S2, label: S2, orderindex: 1 },
              { id: U3, name: S3, label: S3, orderindex: 2 },
            ] }
          : (f.type === 'drop_down' || f.type === 'labels'
              ? { options: [{ id: `op-${i}`, name: `OPCAO-SINTETICA-${i}`, orderindex: 0 }] }
              : {}),
      };
    });
    const fetchFalso = (async () => ({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ fields }),
    })) as unknown as typeof fetch;
    const r = await ClickUpFieldResolver.fromList('lista-sintetica', { token: 'tok', fetchImpl: fetchFalso });
    expect(r).toBeInstanceOf(ClickUpFieldResolver);   // a CLASSE real, não um stub
    return r;
  }

  it('OS TRÊS ESTADOS, lado a lado, com resultados DIFERENTES', async () => {
    const resolver = await resolverComTresOpcoes();
    const sumido   = await resolverComTresOpcoes('labels', `${CAMPO} (RENOMEADO)`);

    const vazioLegitimo = resolveCatalogValue(resolver, CAMPO, undefined);
    const vazioArray    = resolveCatalogValue(resolver, CAMPO, []);
    const parcial       = resolveCatalogValue(resolver, CAMPO, [U1, U_MORTO_A, U_MORTO_B]);
    const nenhuma       = resolveCatalogValue(resolver, CAMPO, [U_MORTO_A, U_MORTO_B]);
    const campoSumido   = resolveCatalogValue(sumido,   CAMPO, [U1]);
    const controle      = resolveCatalogValue(resolver, CAMPO, [U1, U2, U3]);

    const linha = (rot: string, r: typeof vazioLegitimo) =>
      console.log(`>>> 2.2/r3/d1 | ${rot.padEnd(34)} → ${JSON.stringify(r)}`);
    linha('(1) vazio LEGÍTIMO (origem calada)', vazioLegitimo);
    linha('(1) vazio LEGÍTIMO (array vazio)',   vazioArray);
    linha('(2) PARCIAL — pediu 3, resolve 1',   parcial);
    linha('(2) NENHUMA opção resolve',          nenhuma);
    linha('(3) o CAMPO sumiu do catálogo',      campoSumido);
    linha('CONTROLE+ — as 3 conhecidas',        controle);

    // (1) vazio legítimo: LEITURA. É o único que pode apagar (D-E).
    expect(vazioLegitimo).toEqual({ readable: true, catalogType: 'labels', labels: [], requested: 0, resolved: 0 });
    expect(vazioArray).toEqual(vazioLegitimo);

    // (2) parcial — F39: "pediu 3, voltam 2, e array curto parece completo". NÃO é leitura.
    expect(parcial.readable).toBe(false);
    expect(parcial).toMatchObject({ reason: 'options_partially_resolved', requested: 3, resolved: 1 });

    // (2) nenhuma resolve — era ISTO que virava `{readable:true, labels:[]}`.
    expect(nenhuma.readable).toBe(false);
    expect(nenhuma).toMatchObject({ reason: 'options_unresolved', requested: 2, resolved: 0 });

    // (3) campo sumido — distinto dos dois de cima pela RAZÃO.
    expect(campoSumido.readable).toBe(false);
    expect(campoSumido).toMatchObject({ reason: 'missing', catalogType: null });

    // Os três estados são de fato TRÊS: nenhuma razão se repete e o vazio não é ilegível.
    const razoes = [parcial, nenhuma, campoSumido].map(r => (r.readable ? 'READABLE' : r.reason));
    expect(new Set(razoes).size).toBe(3);

    // CONTROLE POSITIVO: contagem zero em régua é instrumento morto (F19).
    expect(controle).toEqual({
      readable: true, catalogType: 'labels', labels: [S1, S2, S3], requested: 3, resolved: 3,
    });
  });

  it('o INVARIANTE: `readable === true` implica `resolved === requested` — em toda a tabela', async () => {
    const resolver = await resolverComTresOpcoes();
    const casos: Array<[string, unknown]> = [
      ['ausente', undefined], ['null', null], ['array vazio', []],
      ['1 conhecida', [U1]], ['3 conhecidas', [U1, U2, U3]],
      ['1 morta', [U_MORTO_A]], ['2 de 3', [U1, U2, U_MORTO_A]],
      ['lixo (número)', [7]], ['lixo misturado', [U1, 7, null]],
      ['string solta conhecida', U1],
    ];
    let lidos = 0;
    for (const [rot, raw] of casos) {
      const r = resolveCatalogValue(resolver, CAMPO, raw);
      console.log(`>>> 2.2/r3/d1-inv | ${rot.padEnd(24)} → readable=${r.readable} requested=${r.requested} resolved=${r.resolved}` +
                  `${r.readable ? '' : ` reason=${r.reason}`}`);
      if (r.readable) { lidos += 1; expect(r.resolved).toBe(r.requested); }
      else expect(r.resolved).toBeLessThan(Math.max(r.requested, 1));
    }
    expect(lidos).toBeGreaterThan(0);   // zero seria a régua aprovando no vácuo (F19)
  });

  it('o mesmo buraco existia no `drop_down`: orderindex que não resolve NÃO é campo vazio', async () => {
    const resolver = await resolverComTresOpcoes('drop_down');
    const conhecido    = resolveCatalogValue(resolver, CAMPO, 0);
    const desconhecido = resolveCatalogValue(resolver, CAMPO, 97);
    const ausente      = resolveCatalogValue(resolver, CAMPO, null);
    const lixo         = resolveCatalogValue(resolver, CAMPO, '');

    console.log(`>>> 2.2/r3/d1-dd | conhecido=${JSON.stringify(conhecido)}`);
    console.log(`>>> 2.2/r3/d1-dd | orderindex DESCONHECIDO=${JSON.stringify(desconhecido)}`);
    console.log(`>>> 2.2/r3/d1-dd | ausente (vazio legítimo)=${JSON.stringify(ausente)}`);
    console.log(`>>> 2.2/r3/d1-dd | '' (a porta de fabricação da C5)=${JSON.stringify(lixo)}`);

    expect(conhecido).toMatchObject({ readable: true, labels: [S1], requested: 1, resolved: 1 });
    expect(desconhecido).toMatchObject({ readable: false, reason: 'options_unresolved', requested: 1 });
    expect(ausente).toMatchObject({ readable: true, labels: [], requested: 0 });
    expect(lixo).toMatchObject({ readable: false, reason: 'value_not_indexable' });
  });

  it('a FIAÇÃO fiel da 2.3 dá TRÊS resultados diferentes no banco — e só um apaga', async () => {
    const resolver = await resolverComTresOpcoes();
    const sumido   = await resolverComTresOpcoes('labels', `${CAMPO} (RENOMEADO)`);

    // É literalmente a linha que a task 2.3 tem de escrever, e o QA a citou:
    const fiacaoDa23 = (read: ReturnType<typeof resolveCatalogValue>) =>
      read.readable ? sourceLabelsRead(read.labels) : sourceLabelsUnreadable(read.reason);

    const rodar = async (raw: unknown, r: ClickUpFieldResolver) => {
      const { pool, chamadas } = makeMockPool();
      const res = await makeRepo(pool).replaceForField({
        patientId: PACIENTE, fieldName: CAMPO, read: fiacaoDa23(resolveCatalogValue(r, CAMPO, raw)),
      });
      return { res, deletes: deletes(chamadas).length, inserts: inserts(chamadas).length };
    };

    const vazio    = await rodar(undefined, resolver);
    const parcial  = await rodar([U1, U_MORTO_A, U_MORTO_B], resolver);
    const nenhuma  = await rodar([U_MORTO_A], resolver);
    const sumiu    = await rodar([U1], sumido);
    const controle = await rodar([U1, U2, U3], resolver);

    const linha = (rot: string, x: typeof vazio) =>
      console.log(`>>> 2.2/r3/d1-banco | ${rot.padEnd(30)} → outcome=${x.res.outcome} DELETEs=${x.deletes} INSERTs=${x.inserts}`);
    linha('(1) vazio LEGÍTIMO', vazio);
    linha('(2) PARCIAL (3 pedidos, 1 resolve)', parcial);
    linha('(2) NENHUMA resolve', nenhuma);
    linha('(3) o CAMPO sumiu', sumiu);
    linha('CONTROLE+ (as 3 conhecidas)', controle);

    // (1) o vazio legítimo APAGA — a D-E proíbe congelar, congelado *parece* dado.
    expect(vazio.res.outcome).toBe('written');
    expect(vazio.deletes).toBe(1);
    expect(vazio.inserts).toBe(0);

    // (2) e (3) NÃO tocam em nada. O parcial é o caso que o QA exigiu ver separado: gravar
    // "os que resolveram" apagaria os outros dois com `outcome:'written'`.
    for (const [rot, x] of [['parcial', parcial], ['nenhuma', nenhuma], ['sumiu', sumiu]] as const) {
      expect([rot, x.res.outcome]).toEqual([rot, 'skipped-unreadable']);
      expect([rot, x.deletes, x.inserts]).toEqual([rot, 0, 0]);
    }

    // CONTROLE POSITIVO: a trava não é "nunca escrever".
    expect(controle.res.outcome).toBe('written');
    expect(controle.res.accepted).toEqual([S1, S2, S3]);
    expect(controle.inserts).toBe(3);
  });

  it('SEGUNDA FACE: `sourceLabelsRead(null|undefined)` não é mais "li e está vazio"', () => {
    // `null`/`undefined` é EXATAMENTE a forma que `cf['Segmentos Clínicos']` tem quando o
    // campo some da tarefa. O tipo agora recusa; o `as never` abaixo é o que um `any`, um
    // `JSON.parse` ou o `require` do `dist` fariam por baixo dele — e o runtime também recusa.
    const comNull      = sourceLabelsRead(null as never);
    const comUndefined = sourceLabelsRead(undefined as never);
    const vazioDeVerdade = sourceLabelsRead([]);

    console.log(`>>> 2.2/r3/d1-acucar | sourceLabelsRead(null)      → ${JSON.stringify(comNull)}`);
    console.log(`>>> 2.2/r3/d1-acucar | sourceLabelsRead(undefined) → ${JSON.stringify(comUndefined)}`);
    console.log(`>>> 2.2/r3/d1-acucar | sourceLabelsRead([])        → ${JSON.stringify(vazioDeVerdade)} (CONTROLE+: este É leitura)`);

    expect(comNull).toEqual({ readable: false, reason: 'not-a-list' });
    expect(comUndefined).toEqual({ readable: false, reason: 'not-a-list' });
    expect(vazioDeVerdade).toEqual({ readable: true, labels: [] });
  });

  it('C1: o aviso da leitura ilegível leva campo, razão e CONTAGEM — nunca uuid nem rótulo', async () => {
    const resolver = await resolverComTresOpcoes();
    linhas = [];
    resolveCatalogValue(resolver, CAMPO, [U1, U_MORTO_A, U_MORTO_B]);

    const meus = linhas.filter(l => l.includes('[resolveCatalogValue]'));
    meus.forEach(l => console.log(`    aviso: ${l}`));
    console.log(`>>> 2.2/r3/d1-C1 | avisos do leitor=${meus.length} | com uuid ou rótulo=${
      meus.filter(l => [U1, U_MORTO_A, U_MORTO_B, S1, PACIENTE].some(a => l.includes(a))).length}`);

    expect(meus.length).toBeGreaterThan(0);                              // F19
    expect(meus.some(l => l.includes('options_partially_resolved'))).toBe(true);
    expect(meus.some(l => l.includes('"requested":3') && l.includes('"resolved":1'))).toBe(true);
    expect(meus.filter(l => [U1, U_MORTO_A, U_MORTO_B, S1, PACIENTE].some(a => l.includes(a)))).toEqual([]);
  });
});

/**
 * DEFEITOS 2, 3 e 4 (2ª rodada) — o registro durável da recusa.
 *
 * 2 — sob pool saturado o conserto se desligava sozinho e cobrava o `connectionTimeoutMillis`
 *     INTEIRO de cada sync (10.222 ms e 10.543 ms, medidos), com `sqlstate: null` no aviso;
 * 3 — sem `client` do chamador, uma falha do registro fazia `replaceForField` LANÇAR DEPOIS de
 *     já ter commitado a substituição, e o aviso da C1 nunca saía;
 * 4 — o registro não tinha LEITOR, e o dedupe era PERMANENTE (grita uma vez na vida e cala
 *     para sempre, inclusive depois de restart).
 */
describe('2.2/rodada3/defeitos 2-3-4 — o registro durável da recusa', () => {
  let erros: string[] = [];
  let spyErro: jest.SpyInstance;
  beforeEach(() => {
    erros = [];
    spyErro = jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { erros.push(serializa(a)); });
  });
  afterEach(() => spyErro.mockRestore());

  const QUATRO = [S1, S2, S3, S4_RECUSADO];

  /** Pool cuja `connect()` NUNCA responde a tempo — é o pool no teto do defeito 2. */
  function poolQueNaoConecta(atrasoMs: number) {
    const releases: jest.Mock[] = [];
    const pool = {
      query: jest.fn(async () => ({ rows: [] })),
      connect: jest.fn(() => new Promise(resolve => {
        const t = setTimeout(() => {
          const release = jest.fn();
          releases.push(release);
          resolve({ query: jest.fn(async () => ({ rows: [{ occurrences: 1, warn_now: true }] })), release });
        }, atrasoMs);
        (t as unknown as { unref?: () => void }).unref?.();
      })),
    };
    return { pool, releases };
  }

  it('DEFEITO 2: a espera pela 2ª conexão tem prazo PRÓPRIO — não o do pool (10 s)', async () => {
    const { pool } = poolQueNaoConecta(30_000);   // o pool jamais entrega
    const caller = makeCallerClient([]);
    const t0 = Date.now();
    const r = await makeRepo(pool).replaceForField(
      { patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead(QUATRO) },
      caller as never,
    );
    const gasto = Date.now() - t0;

    const aviso = linhas.find(l => l.includes('registro durável da recusa FORA da transação FALHOU')) ?? '';
    console.log(`>>> 2.2/r3/d2 | tempo até desistir=${gasto}ms (produção esperava 10000ms) | durabilidade=${r.rejectionsDurable}`);
    console.log(`    aviso: ${aviso}`);

    expect(gasto).toBeLessThan(4_000);                       // <<< não paga mais o prazo do pool
    expect(gasto).toBeGreaterThanOrEqual(500);               // e não é "desistiu na hora" (F19)
    expect(aviso).toContain('"cause":"connect-timeout"');    // a causa é NOMEADA (era sqlstate:null)
    expect(r.rejectionsDurable).toBe('caller-transaction');  // e o retorno DIZ que não é durável
    expect(r.outcome).toBe('written');
  }, 15_000);

  it('DEFEITO 2: a conexão que chega ATRASADA é devolvida ao pool, não vazada', async () => {
    const { pool, releases } = poolQueNaoConecta(1_400);
    const caller = makeCallerClient([]);
    await makeRepo(pool).replaceForField(
      { patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead(QUATRO) },
      caller as never,
    );
    await new Promise(r => setTimeout(r, 900));   // deixa a conexão atrasada chegar
    console.log(`>>> 2.2/r3/d2-vaza | conexões entregues DEPOIS do prazo=${releases.length} | release() chamado em=${releases.filter(r => r.mock.calls.length > 0).length}`);
    expect(releases.length).toBe(1);                                     // ela chegou (F19)
    expect(releases.filter(r => r.mock.calls.length > 0)).toHaveLength(1); // e foi devolvida
  }, 15_000);

  it('DEFEITO 3: falha do registro SEM plano B não lança — e o alarme da C1 SAI', async () => {
    // Conexão própria concedida, mas o INSERT da recusa explode (23503, o caso medido).
    const pool = {
      query: jest.fn(async () => ({ rows: [] })),
      connect: jest.fn(async () => ({
        query: jest.fn(async (sql: unknown) => {
          if (String(sql).trim().startsWith('INSERT INTO patient_source_label_rejections')) {
            const e = new Error('insert or update violates foreign key constraint') as Error & { code?: string };
            e.code = '23503';
            throw e;
          }
          return { rows: [] };
        }),
        release: jest.fn(),
      })),
    };

    let lancou: unknown = null;
    let r: Awaited<ReturnType<PatientSourceLabelRepository['replaceForField']>> | null = null;
    try {
      // SEM `client`: é o caminho em que a versão anterior lançava DEPOIS do COMMIT.
      r = await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead(QUATRO) });
    } catch (e) { lancou = e; }

    const alarmeC1 = linhas.filter(l => l.includes('rótulos crus recusados'));
    const semPlanoB = erros.filter(l => l.includes('NÃO HÁ plano B'));
    console.log(`>>> 2.2/r3/d3 | lançou=${lancou ? (lancou as Error).name : 'NAO'} | outcome=${r?.outcome} | durabilidade=${r?.rejectionsDurable}`);
    console.log(`>>> 2.2/r3/d3 | o aviso da C1 sobre as recusas SAIU? ${alarmeC1.length > 0} (o QA mediu: false)`);
    semPlanoB.forEach(l => console.log(`    erro:  ${l}`));
    alarmeC1.forEach(l => console.log(`    aviso: ${l}`));

    expect(lancou).toBeNull();                       // <<< não lança depois de ter commitado
    expect(r!.outcome).toBe('written');
    expect(r!.rejectionsDurable).toBe('none');       // e não finge durabilidade
    expect(alarmeC1.length).toBeGreaterThan(0);      // <<< o alarme da C1 sai
    expect(semPlanoB.length).toBe(1);
    // E não descreve um fallback que não houve — era a 2ª metade do defeito 3.
    expect(semPlanoB[0]).toContain('"fallback":"none"');
    expect(semPlanoB[0]).toContain('"sqlstate":"23503"');
    expect(erros.some(l => l.includes('caindo para a transação do chamador'))).toBe(false);
    // C1: nem no erro nem no aviso pode haver rótulo ou paciente.
    expect([...erros, ...linhas].filter(l => AGULHAS.some(a => l.includes(a)))).toEqual([]);
  });

  it('DEFEITO 4: o alarme RE-ACENDE quando a janela vence — mesmo na 9ª ocorrência', async () => {
    // O banco decidiu `warn_now` por `last_warned_at`, NÃO por `occurrences`. É a diferença
    // entre "desduplicar" e "desligar": a versão anterior gritava só com `occurrences === 1`.
    const dentroDaJanela = makeMockPool(sql => sql.trim().startsWith('INSERT INTO patient_source_label_rejections')
      ? { rows: [{ occurrences: 9, warn_now: false }] } : { rows: [] });
    linhas = [];
    await makeRepo(dentroDaJanela.pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead(QUATRO) });
    const calado = linhas.filter(l => l.includes('rótulos crus recusados')).length;

    const janelaVencida = makeMockPool(sql => sql.trim().startsWith('INSERT INTO patient_source_label_rejections')
      ? { rows: [{ occurrences: 9, warn_now: true }] } : { rows: [] });
    linhas = [];
    const r = await makeRepo(janelaVencida.pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead(QUATRO) });
    const reacendeu = linhas.filter(l => l.includes('rótulos crus recusados'));

    console.log(`>>> 2.2/r3/d4-janela | 9ª ocorrência DENTRO da janela → avisos=${calado} (esperado 0)`);
    console.log(`>>> 2.2/r3/d4-janela | 9ª ocorrência com a janela VENCIDA → avisos=${reacendeu.length} (esperado 1) | newlyRejected=${r.newlyRejected}`);
    reacendeu.forEach(l => console.log(`    aviso: ${l}`));

    expect(calado).toBe(0);                     // repetição não afoga o alarme (defeito 8)
    expect(reacendeu).toHaveLength(1);          // <<< e não cala para sempre (defeito 4)
    expect(r.newlyRejected).toBe(0);            // não é inédita: quem decide é a JANELA
  });

  it('DEFEITO 4: o registro durável é LIDO — e o acumulado sai no alarme, em contagem', async () => {
    const { pool, chamadas } = makeMockPool(sql =>
      sql.trim().startsWith('SELECT COUNT(*)::int AS labels') ? { rows: [{ labels: 4, occurrences: 37 }] } : { rows: [] });
    linhas = [];
    const r = await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead(QUATRO) });

    const leituras = chamadas.filter(c => c.sql.includes('FROM patient_source_label_rejections') && c.sql.startsWith('SELECT'));
    const alarme = linhas.filter(l => l.includes('rótulos crus recusados'));
    console.log(`>>> 2.2/r3/d4-leitor | consultas ao registro durável no caminho vivo=${leituras.length} (o QA mediu 0 leitores)`);
    console.log(`>>> 2.2/r3/d4-leitor | via=${JSON.stringify(leituras.map(l => l.via))} (a MESMA conexão do registro)`);
    alarme.forEach(l => console.log(`    aviso: ${l}`));

    expect(leituras.length).toBe(1);                             // F19: zero seria "não mediu"
    expect(alarme).toHaveLength(1);
    expect(alarme[0]).toContain('"standingLabels":4');
    expect(alarme[0]).toContain('"standingOccurrences":37');
    expect(alarme[0]).toContain('"rejectionsDurable":"own-transaction"');
    expect(r.rejectionsDurable).toBe('own-transaction');
    // C1: o leitor devolve CONTAGEM. Nem rótulo, nem paciente na linha.
    expect(linhas.filter(l => AGULHAS.some(a => l.includes(a)))).toEqual([]);
  });

  it('CONTROLE POSITIVO dos três: sem recusa nenhuma, nada é registrado, lido nem gritado', async () => {
    const { pool, chamadas } = makeMockPool();
    linhas = []; erros = [];
    const r = await makeRepo(pool).replaceForField({ patientId: PACIENTE, fieldName: CAMPO, read: sourceLabelsRead([S1, S2, S3]) });
    const leituras = chamadas.filter(c => c.sql.startsWith('SELECT COUNT(*)'));
    console.log(`>>> 2.2/r3/controle+ | recusas=${r.rejected.length} | durabilidade=${r.rejectionsDurable} | INSERTs de recusa=${rejeicoes(chamadas).length} | leituras=${leituras.length} | avisos=${linhas.length} | erros=${erros.length}`);
    expect(r.rejected).toEqual([]);
    expect(r.rejectionsDurable).toBe('not-applicable');
    expect(rejeicoes(chamadas)).toHaveLength(0);
    expect(leituras).toHaveLength(0);
    expect(linhas).toEqual([]);
    expect(erros).toEqual([]);
    expect(r.accepted).toEqual([S1, S2, S3]);   // e o caminho feliz continua escrevendo
  });
});
