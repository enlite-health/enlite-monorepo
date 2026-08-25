/**
 * TASK 1.11 — o `null` sobrecarregado no nível do CAMPO.
 *
 * ── REGISTRO DE ACESSO (C7 do parecer do `lex` de 23/08/2026) ────────────────
 *   Autorizado por: Gabriel — task 1.11 da change `campos-admissao`.
 *   O que esta fixture lê: NADA. Zero rede, zero banco, zero API do ClickUp, zero
 *     ficha de paciente. O `ClickUpFieldResolver` real é montado com `fetchImpl`
 *     falso devolvendo catálogo 100% SINTÉTICO, escrito aqui dentro; o "banco" é um
 *     objeto em memória. Identidade de token: NENHUMA ('token-sintetico').
 *   Nada foi gravado, nada há para apagar.
 *
 * ── O DEFEITO QUE ELA TRANCA (achado do QA-caça, `qa-1.3b-caca.txt`) ─────────
 *   `null` significa DUAS coisas — "vazio de verdade" e "não consegui ler" — e o
 *   `UPDATE patients SET clinical_specialty = $11` (sem COALESCE) não distingue.
 *   Renomear/apagar o campo no ClickUp → a chave some da task → `asIndexable`
 *   devolve null CALADO (indistinguível das 1424/1690 legitimamente vazias) → o
 *   valor gravado é APAGADO a cada re-sync, com `kind=UPDATED` verde.
 *
 * ── O CONSERTO NÃO É COALESCE (D-E do `design.md` o proíbe) ──────────────────
 *   Valor congelado é pior que vazio porque PARECE dado. Por isso o caso 2 abaixo
 *   é tão importante quanto os casos 3 e 4: com o campo VIVO e a task sem valor, o
 *   vazio continua sendo gravado (apaga de propósito — é o vazio verificado). Só o
 *   campo ILEGÍVEL (fora do catálogo) para a escrita, e grita.
 *
 * ── POR QUE OS CONTROLES POSITIVOS ──────────────────────────────────────────
 *   "não apagou" pode significar que o teste não exercitou nada, e "zero avisos"
 *   pode significar espião morto (D157/F19). Então: caso 1 prova que o MESMO valor,
 *   com o nome de hoje, DERIVA e é gravado; o detector de sentinela é exercitado
 *   contra uma linha plantada antes de ser usado como prova.
 */

// ── Mock do logger (antes dos imports) ────────────────────────────────────────
const mockLoggerInfo  = jest.fn();
const mockLoggerWarn  = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('firebase-functions', () => ({
  logger: {
    info:  (...args: unknown[]) => mockLoggerInfo(...args),
    warn:  (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import {
  ClickUpPatientMapper,
  PATIENT_DROPDOWN_FIELDS,
} from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { ClickUpUnreadableFieldError } from '../../../src/modules/integration/infrastructure/clickup/helpers/dropdownCatalogGuard';
import { SyncPatientFromClickUpTaskUseCase } from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { SyncPatientDeps } from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { PatientService, PatientServiceUpsertInput } from '../../../src/modules/case/application/PatientService';
import type { ClickUpTask, ClickUpTaskCustomField } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { completaCatalogo } from '../../fixtures/clickup/completaCatalogo';

// ── Nomes e sentinelas ────────────────────────────────────────────────────────
const NOME_DE_HOJE   = 'Segmentos Clínicos';
const NOME_RENOMEADO = 'Segmentos Clínicos (Uso Clínico)';
const TASK_ID        = 'sintetica-1-11';
/** O valor cru do campo clínico. C1: NÃO pode aparecer em nenhuma linha de log. */
const SENTINELA_INDEX = 1;
/** O rótulo resolvido. C1: também não pode aparecer. */
const SENTINELA_LABEL = 'AT para Pacientes con TEA';
/** O derivado que o mapa produz a partir do rótulo acima. É o que está "no banco". */
const DERIVADO = 'ASD';

// ── Catálogo SINTÉTICO ────────────────────────────────────────────────────────
function catalogo(nomeDoCampoClinico: string | null) {
  const fields: unknown[] = [
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
    // Task 1.12: o 8º `drop_down` declarado. Sem ele no catálogo sintético, o preflight desta
    // fixture passaria a reprovar por um campo que NÃO é o cenário deste arquivo.
    { id: 'cf-8', name: 'Equipo Tratante Multidisciplinario', type: 'drop_down',
      type_config: { options: [{ id: 'e-0', name: 'No', orderindex: 0 }] } },
  ];
  // nomeDoCampoClinico === null → o campo foi APAGADO do ClickUp.
  if (nomeDoCampoClinico !== null) {
    fields.push({
      id: 'cf-1', name: nomeDoCampoClinico, type: 'drop_down',
      type_config: { options: [
        { id: 'o-0', name: 'AT para Pacientes con Discapacidad Intelectual', orderindex: 0 },
        { id: 'o-1', name: SENTINELA_LABEL, orderindex: SENTINELA_INDEX },
      ] },
    });
  }
  // Task 3.2 — o catálogo é COMPLETADO com os campos declarados que esta suíte não define.
  // Sem isso, declarar um campo novo no mapper derruba esta suíte por contagem, não por
  // defeito: o preflight da 1.11 (que é o que este arquivo testa) lança por campo ausente.
  // O campo clínico que ESTA suíte manipula fica de fora da reposição: quando ela o apaga
  // (`nomeDoCampoClinico === null`) ou o renomeia, é isso que o teste está provando. Repor
  // seria a ferramenta apagando o caso de teste.
  return {
    fields: completaCatalogo(fields as never, {
      exceto: [NOME_DE_HOJE, nomeDoCampoClinico],
    }),
  };
}

function fetchFalso(nomeDoCampoClinico: string | null): typeof fetch {
  return (async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => catalogo(nomeDoCampoClinico),
  } as unknown as Response)) as unknown as typeof fetch;
}

async function mapperReal(nomeNoCatalogo: string | null): Promise<ClickUpPatientMapper> {
  const resolver = await ClickUpFieldResolver.fromList('lista-sintetica', {
    token: 'token-sintetico',
    fetchImpl: fetchFalso(nomeNoCatalogo),
  });
  expect(resolver).toBeInstanceOf(ClickUpFieldResolver);   // a CLASSE real (C4)
  return new ClickUpPatientMapper(resolver);
}

// ── Task sintética ────────────────────────────────────────────────────────────
function tarefa(campoClinico: { name: string; value: unknown } | null): ClickUpTask {
  const campos = [
    { name: 'Nombre de Paciente',    value: 'NOME-SINTETICO' },
    { name: 'Apellido del Paciente', value: 'SOBRENOME-SINTETICO' },
    ...(campoClinico ? [campoClinico] : []),
  ];
  return {
    id: TASK_ID,
    name: 'SOBRENOME-SINTETICO, NOME-SINTETICO',
    status: { status: 'activo', color: '#000', type: 'custom' },
    parent: null,
    custom_fields: campos.map(f => ({
      id: `cf-${f.name}`, name: f.name, type: 'drop_down', value: f.value,
    })) as ClickUpTaskCustomField[],
    url: `https://app.clickup.com/t/${TASK_ID}`,
    date_created: '1700000000000',
    date_updated: '1700100000000',
  };
}

// ── O "banco" — espelha o UPDATE real, sem COALESCE ───────────────────────────
// `PatientClinicalRepository.upsert`:
//   UPDATE patients SET clinical_specialty = $11 …   com  input.clinicalSpecialty ?? null
// É esta linha que apaga quando o null chega por engano.
interface BancoFalso { clinical_specialty: string | null; escritas: number }

/**
 * Task 2.3 — dublê do repositório do rótulo CRU. Estes testes são sobre o preflight/recarga
 * de catálogo, não sobre a persistência do cru (que tem suíte própria). O dublê existe para
 * que nada aqui abra conexão de banco: o repositório real chama `DatabaseConnection` no
 * construtor e LANÇA sem `DATABASE_URL`.
 */

/** Task 3.3 — dublê da cobertura múltipla. Nenhuma destas suítes toca banco. */
function repoCoberturaFalso() {
  return {
    replaceForPatient: jest.fn(async () => ({
      outcome: 'written' as const, received: 0, accepted: [], rejected: [],
    })),
  } as never;
}

function repoCruFalso() {
  return {
    replaceForField: jest.fn(async ({ fieldName }: { fieldName: string }) => ({
      fieldName, outcome: 'written' as const,
      received: 0, empty: 0, accepted: [], rejected: [], newlyRejected: 0,
      rejectionsDurable: 'not-applicable' as const,
    })),
  } as never;
}


function deps(mapper: ClickUpPatientMapper, banco: BancoFalso): { deps: SyncPatientDeps; upsert: jest.Mock } {
  const upsert = jest.fn(async (input: PatientServiceUpsertInput) => {
    banco.clinical_specialty = (input.clinicalSpecialty as string | null | undefined) ?? null;
    banco.escritas += 1;
    return { id: 'patient-sintetico', created: false, flagged: false };
  });
  return {
    deps: {
      mapper,
      patientService: { upsertFromClickUp: upsert } as unknown as PatientService,
      sourceLabelRepository: repoCruFalso(),
      insuranceRepository: repoCoberturaFalso(),
    },
    upsert,
  };
}

// ── Espião de console.warn ────────────────────────────────────────────────────
let linhas: string[] = [];
let spy: jest.SpyInstance;

function serializa(args: unknown[]): string {
  return args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

/** Detector da C1: qualquer linha que carregue valor cru, rótulo ou id de paciente. */
function linhasComDadoProibido(fonte: string[]): string[] {
  const agulhas = [SENTINELA_LABEL, TASK_ID, `"value":${SENTINELA_INDEX}`, `orderindex":${SENTINELA_INDEX}`];
  return fonte.filter(l => agulhas.some(a => l.includes(a)));
}

/** Linhas do aviso novo desta task. */
function avisosDeCampoIlegivel(): string[] {
  return linhas.filter(l => l.includes('Unreadable ClickUp catalog field'));
}

beforeEach(() => {
  linhas = [];
  mockLoggerInfo.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerError.mockClear();
  spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    linhas.push(serializa(args));
  });
});
afterEach(() => spy.mockRestore());

// ─────────────────────────────────────────────────────────────────────────────
describe('1.11 — campo renomeado/apagado no ClickUp NÃO apaga o dado, e alguém grita', () => {

  it('CONTROLE POSITIVO 1: com o nome de HOJE, o valor deriva e é GRAVADO', async () => {
    const banco: BancoFalso = { clinical_specialty: DERIVADO, escritas: 0 };
    const mapper = await mapperReal(NOME_DE_HOJE);
    const { deps: d, upsert } = deps(mapper, banco);

    const r = await new SyncPatientFromClickUpTaskUseCase(d)
      .execute(tarefa({ name: NOME_DE_HOJE, value: SENTINELA_INDEX }));

    console.log(`>>> 1.11/controle-1 | kind=${r.kind} | banco.clinical_specialty=${banco.clinical_specialty} | escritas=${banco.escritas} | avisos_de_campo_ilegivel=${avisosDeCampoIlegivel().length}`);

    expect(r.kind).toBe('UPDATED');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].clinicalSpecialty).toBe(DERIVADO);
    expect(banco.clinical_specialty).toBe(DERIVADO);   // derivou normalmente
    expect(avisosDeCampoIlegivel()).toHaveLength(0);   // e não gritou à toa
  });

  it('CONTROLE POSITIVO 2 (D-E vivo): campo VIVO + task sem valor → grava o VAZIO (não congela)', async () => {
    const banco: BancoFalso = { clinical_specialty: DERIVADO, escritas: 0 };
    const mapper = await mapperReal(NOME_DE_HOJE);
    const { deps: d, upsert } = deps(mapper, banco);

    // A forma esmagadoramente comum: 1424 de 1690 tasks não têm a chave `value`.
    const r = await new SyncPatientFromClickUpTaskUseCase(d)
      .execute(tarefa({ name: NOME_DE_HOJE, value: undefined }));

    console.log(`>>> 1.11/controle-2 (D-E) | kind=${r.kind} | banco.clinical_specialty=${banco.clinical_specialty} | escritas=${banco.escritas} | avisos_de_campo_ilegivel=${avisosDeCampoIlegivel().length}`);

    expect(r.kind).toBe('UPDATED');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(banco.clinical_specialty).toBeNull();       // o vazio VERIFICADO continua apagando
    expect(avisosDeCampoIlegivel()).toHaveLength(0);
  });

  it('O DEFEITO, TRANCADO — campo RENOMEADO no catálogo E na task: nada é escrito, e grita', async () => {
    const banco: BancoFalso = { clinical_specialty: DERIVADO, escritas: 0 };
    const mapper = await mapperReal(NOME_RENOMEADO);
    const { deps: d, upsert } = deps(mapper, banco);

    const r = await new SyncPatientFromClickUpTaskUseCase(d)
      .execute(tarefa({ name: NOME_RENOMEADO, value: SENTINELA_INDEX }));

    console.log(`>>> 1.11/RENOMEADO | kind=${r.kind} | banco.clinical_specialty=${banco.clinical_specialty} (antes: ${DERIVADO}) | escritas=${banco.escritas} | avisos_de_campo_ilegivel=${avisosDeCampoIlegivel().length}`);
    console.log(`>>> 1.11/RENOMEADO | aviso: ${avisosDeCampoIlegivel()[0]}`);
    console.log(`>>> 1.11/RENOMEADO | logger.error=${mockLoggerError.mock.calls.length} evento=${JSON.stringify(mockLoggerError.mock.calls[0]?.[0])}`);

    // (a) não apagou
    expect(banco.clinical_specialty).toBe(DERIVADO);
    expect(banco.escritas).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    // (b) alguém grita — no console, nomeando o campo
    expect(avisosDeCampoIlegivel().length).toBeGreaterThan(0);
    expect(avisosDeCampoIlegivel().join(' ')).toContain(NOME_DE_HOJE);
    // (c) e grita no canal do sync: ERROR, não `kind=UPDATED` verde
    expect(r.kind).toBe('ERROR');
    expect(r.kind === 'ERROR' && r.error).toBeInstanceOf(ClickUpUnreadableFieldError);
    expect(mockLoggerError).toHaveBeenCalledWith('clickup_patient_sync.error', expect.anything());
  });

  it('mesmo fecho para o campo APAGADO — fora do catálogo e fora da task', async () => {
    const banco: BancoFalso = { clinical_specialty: DERIVADO, escritas: 0 };
    const mapper = await mapperReal(null);
    const { deps: d, upsert } = deps(mapper, banco);

    const r = await new SyncPatientFromClickUpTaskUseCase(d).execute(tarefa(null));

    console.log(`>>> 1.11/APAGADO | kind=${r.kind} | banco.clinical_specialty=${banco.clinical_specialty} (antes: ${DERIVADO}) | escritas=${banco.escritas} | avisos_de_campo_ilegivel=${avisosDeCampoIlegivel().length}`);

    expect(banco.clinical_specialty).toBe(DERIVADO);
    expect(banco.escritas).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    expect(r.kind).toBe('ERROR');
    expect(avisosDeCampoIlegivel().join(' ')).toContain(NOME_DE_HOJE);
  });

  it('C1/lex: o aviso novo NÃO carrega valor cru, rótulo nem id de paciente (com controle positivo do detector)', async () => {
    const banco: BancoFalso = { clinical_specialty: DERIVADO, escritas: 0 };
    const mapper = await mapperReal(NOME_RENOMEADO);
    const { deps: d } = deps(mapper, banco);
    await new SyncPatientFromClickUpTaskUseCase(d)
      .execute(tarefa({ name: NOME_RENOMEADO, value: SENTINELA_INDEX }));

    // CONTROLE POSITIVO do detector: se a linha proibida existir, ele ACHA.
    const plantada = [`[fake] {"field":"x","label":"${SENTINELA_LABEL}","taskId":"${TASK_ID}"}`];
    console.log(`>>> 1.11/C1 | detector em linha PLANTADA: ${linhasComDadoProibido(plantada).length} (esperado 1)`);
    expect(linhasComDadoProibido(plantada)).toHaveLength(1);

    console.log(`>>> 1.11/C1 | linhas emitidas=${linhas.length} | com dado proibido=${linhasComDadoProibido(linhas).length} (esperado 0)`);
    expect(linhas.length).toBeGreaterThan(0);           // contagem zero seria instrumento morto (F19)
    expect(linhasComDadoProibido(linhas)).toHaveLength(0);
  });

  /**
   * ⚠️ DEFEITO 5 do QA-caça da 2.2 (2ª rodada): esta varredura conhecia UMA forma de ler um
   * campo de catálogo — `resolveDropdown('<nome>')`. A rodada de conserto da 2.2 moveu
   * `Segmentos Clínicos` para `resolveCatalogValue`, e o regex passou a achar 4 nomes em vez
   * de 5: **o campo mais clínico do preflight saiu da régua sem que nada acendesse**.
   *
   * O conserto não é acrescentar o 2º regex e seguir — foi assim que a régua ficou cega da
   * primeira vez. É FECHAR a contagem: toda chamada de leitura de catálogo no fonte tem de
   * ser colhida por ALGUM padrão. Um leitor novo (um 3º nome de função) faz `colhidas` ficar
   * menor que `chamadas` e o teste reprova — sem depender de alguém lembrar de vir aqui.
   */
  it('trava de deriva: TODA leitura de catálogo do mapper é colhida e está em PATIENT_DROPDOWN_FIELDS', () => {
    const fonte = fs.readFileSync(
      path.join(__dirname, '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts'),
      'utf-8',
    );
    const semComentario = fonte
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');

    const PADROES = [
      /resolveDropdown\(\s*'([^']+)'/g,                        // this.resolver.resolveDropdown('X', …)
      /resolveCatalogValue\(\s*[^,]+,\s*'([^']+)'/g,           // resolveCatalogValue(this.resolver, 'X', …)
      /resolveLabels\(\s*'([^']+)'/g,                          // this.resolver.resolveLabels('X', …)
      /resolveLabel\(\s*'([^']+)'/g,
    ];

    // ⚠️ A ÚNICA leitura com o nome do campo em VARIÁVEL que esta régua aceita, e a aceitação
    // é condicional (task 2.3). `readSourceLabels` percorre `PATIENT_CATALOG_FIELDS` para
    // persistir o cru de TODO campo declarado — o nome vem da própria lista que a régua
    // confere, então exigir literal ali seria exigir que a lista fosse escrita DUAS vezes, que
    // é o F20/F49/F51 desta casa (duas listas à mão divergem em silêncio).
    //
    // A aceitação NÃO é "chamada com variável pode": é esta FORMA, e só enquanto o fonte de
    // fato derivar o nome da lista declarada. Se a iteração sumir, a condição abaixo cai e o
    // padrão deixa de valer — a leitura volta a ser não colhida e o teste reprova.
    const derivaDaListaDeclarada =
      /PATIENT_CATALOG_FIELDS\.map\(/.test(semComentario) &&
      /normalizeExpectation\(/.test(semComentario);
    const PADRAO_DERIVADO = /resolveCatalogValue\(\s*this\.resolver,\s*field\s*,/g;
    const derivadas = derivaDaListaDeclarada
      ? [...semComentario.matchAll(PADRAO_DERIVADO)].length
      : 0;
    const usados = new Set<string>();
    for (const p of PADROES) for (const m of semComentario.matchAll(p)) usados.add(m[1]);

    // O FECHO: quantas chamadas de leitura de catálogo existem, colhidas ou não.
    const chamadas = [...semComentario.matchAll(
      /(?:resolveDropdown|resolveLabels?|resolveCatalogValue)\s*\(/g,
    )].length;
    const colhidas = [...PADROES].reduce(
      (n, p) => n + [...semComentario.matchAll(p)].length, 0,
    ) + derivadas;

    const faltando = [...usados].filter(f => !(PATIENT_DROPDOWN_FIELDS as readonly string[]).includes(f));

    console.log(`>>> 1.11/deriva | leituras de catálogo no fonte=${chamadas} | colhidas por padrão=${colhidas} | nomes=${usados.size} | declarados=${PATIENT_DROPDOWN_FIELDS.length} | fora da lista=${faltando.length}`);
    console.log(`>>> 1.11/deriva | nomes colhidos=${JSON.stringify([...usados].sort())}`);
    console.log(`>>> 1.11/deriva | leituras derivadas da lista declarada=${derivadas} | condição ativa=${derivaDaListaDeclarada}`);

    expect(usados.size).toBeGreaterThan(0);             // contagem zero reprova (F19)
    expect(chamadas).toBeGreaterThan(0);
    expect(colhidas).toBe(chamadas);                    // <<< nenhuma leitura escapa da colheita
    expect(faltando).toEqual([]);
    // CONTROLE POSITIVO nomeado: o campo que a 2.2 moveu de leitor continua DENTRO da régua.
    // Sem ele, o teste acima passaria com o campo simplesmente ausente da varredura.
    expect([...usados]).toContain('Segmentos Clínicos');
    // A leitura derivada EXISTE — senão o `+ derivadas` acima seria soma de zero e a régua
    // estaria fechando por acidente, não por cobertura (contagem zero é falha, F19).
    expect(derivadas).toBeGreaterThan(0);
    expect(derivaDaListaDeclarada).toBe(true);
  });

  /**
   * CONTROLE POSITIVO da aceitação condicional da 2.3: a MESMA chamada, sem a iteração sobre
   * `PATIENT_CATALOG_FIELDS`, NÃO é colhida. Sem este teste, a linha `derivaDaListaDeclarada`
   * seria uma porta permanentemente aberta para qualquer `resolveCatalogValue(this.resolver,
   * field, …)` — inclusive um em que `field` viesse de outro lugar qualquer.
   */
  it('CONTROLE POSITIVO: a leitura derivada só é colhida enquanto o fonte iterar a lista declarada', () => {
    const PADRAO_DERIVADO = /resolveCatalogValue\(\s*this\.resolver,\s*field\s*,/g;

    const comIteracao = `
      PATIENT_CATALOG_FIELDS.map(expectation => {
        const { field } = normalizeExpectation(expectation);
        return resolveCatalogValue(this.resolver, field, cf[field], { warn: false });
      });
    `;
    const semIteracao = `
      const field = qualquerCoisa();
      return resolveCatalogValue(this.resolver, field, cf[field], { warn: false });
    `;

    const avalia = (fonte: string) => {
      const ok = /PATIENT_CATALOG_FIELDS\.map\(/.test(fonte) && /normalizeExpectation\(/.test(fonte);
      return ok ? [...fonte.matchAll(PADRAO_DERIVADO)].length : 0;
    };

    const chamadasEm = (fonte: string) =>
      [...fonte.matchAll(/(?:resolveDropdown|resolveLabels?|resolveCatalogValue)\s*\(/g)].length;

    console.log(`>>> 1.11/deriva/controle | com iteração: colhidas=${avalia(comIteracao)} de ${chamadasEm(comIteracao)}`);
    console.log(`>>> 1.11/deriva/controle | sem iteração: colhidas=${avalia(semIteracao)} de ${chamadasEm(semIteracao)}`);

    expect(avalia(comIteracao)).toBe(chamadasEm(comIteracao));   // colhida
    expect(avalia(semIteracao)).toBe(0);                          // NÃO colhida
    expect(chamadasEm(semIteracao)).toBeGreaterThan(0);           // e havia o que colher (F19)
  });

  it('CONTROLE POSITIVO da trava de deriva: uma leitura de catálogo NÃO colhida reprova', () => {
    const fonteSabotada = `
      const a = this.resolver.resolveDropdown('Dependencia', 1);
      const b = resolveCatalogValue(this.resolver, 'Segmentos Clínicos', v);
      const nome = escolheNome();
      const c = this.resolver.resolveDropdown(nome, 2);   // <<< nome por VARIÁVEL: não colhido
    `;
    const PADROES = [
      /resolveDropdown\(\s*'([^']+)'/g,
      /resolveCatalogValue\(\s*[^,]+,\s*'([^']+)'/g,
      /resolveLabels\(\s*'([^']+)'/g,
      /resolveLabel\(\s*'([^']+)'/g,
    ];
    const chamadas = [...fonteSabotada.matchAll(/(?:resolveDropdown|resolveLabels?|resolveCatalogValue)\s*\(/g)].length;
    const colhidas = PADROES.reduce((n, p) => n + [...fonteSabotada.matchAll(p)].length, 0);
    console.log(`>>> 1.11/deriva/controle+ | chamadas=${chamadas} | colhidas=${colhidas} → a régua ACUSA? ${colhidas !== chamadas}`);
    expect(chamadas).toBe(3);
    expect(colhidas).toBe(2);
    expect(colhidas).not.toBe(chamadas);   // a régua é CAPAZ de reprovar
  });
});
