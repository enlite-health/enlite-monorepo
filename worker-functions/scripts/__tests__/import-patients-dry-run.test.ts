/**
 * C1 do parecer do lex (11/09/2026): o stdout de `processDryRun` roda DENTRO de sessões do
 * Claude — texto clínico e PII nunca podem aparecer, nem com `--verbose`. Este teste captura
 * `console.log` de verdade com uma fixture que TEM nome, diagnóstico e responsável, e prova que
 * nenhum desses VALORES escapa — só nome de campo, presença/tamanho, ids e contagens.
 */
import { processDryRun, checkExistingTaskIds, type DryRunCounters } from '../import-patients-dry-run';
import type { ClickUpPatientMapper } from '../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpTask } from '../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import type { Pool } from 'pg';

const NOME = 'Juan';
const SOBRENOME = 'Pérez Rodríguez';
const DEPENDENCIA = 'MUY GRAVE';
const ESPECIALIDADE = 'Neurología Pediátrica';
const DIAGNOSTICO = 'Trastorno del espectro autista con comorbilidad severa, requiere supervisión 24h';
const RESP_NOME = 'María';
const RESP_SOBRENOME = 'González Fernández';

const TASK_ID = 'cu-dry-run-redacted-test';

function tarefa(): ClickUpTask {
  return { id: TASK_ID, status: { status: 'activo' }, parent: null, custom_fields: [] } as unknown as ClickUpTask;
}

/** A fixture COM os valores sensíveis — o que `mapper.map()` devolveria numa task real. */
function inputComDadosSensiveis() {
  return {
    firstName: NOME,
    lastName: SOBRENOME,
    dependencyLevel: DEPENDENCIA,
    clinicalSpecialty: ESPECIALIDADE,
    diagnosis: DIAGNOSTICO,
    serviceType: ['AT', 'CAREGIVER'],
    caseNumber: 4242,
    responsibles: [{ firstName: RESP_NOME, lastName: RESP_SOBRENOME }],
  };
}

function mapperDublado(input: ReturnType<typeof inputComDadosSensiveis> | null) {
  return { map: jest.fn(() => input) } as unknown as ClickUpPatientMapper;
}

function counters(): DryRunCounters {
  return { processed: 0, skippedNoName: 0, skippedSubtask: 0, skippedMapper: 0, wouldCreate: 0, wouldUpdate: 0 };
}

const VALORES_SENSIVEIS = [NOME, SOBRENOME, DEPENDENCIA, ESPECIALIDADE, DIAGNOSTICO, RESP_NOME, RESP_SOBRENOME];

describe('processDryRun — nunca imprime valor clínico/PII, nem com --verbose (C1 do parecer do lex)', () => {
  let saida: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    saida = [];
    spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      saida.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  });

  afterEach(() => spy.mockRestore());

  it('modo padrão (sem --verbose): a linha impressa não contém NENHUM valor sensível', () => {
    const mapper = mapperDublado(inputComDadosSensiveis());
    processDryRun(tarefa(), 0, 1, mapper, new Set(), counters(), false);

    const texto = saida.join('\n');
    for (const valor of VALORES_SENSIVEIS) {
      expect(texto).not.toContain(valor);
    }
    // mas o ID da task e o status (operacionais, não clínicos) continuam presentes:
    expect(texto).toContain(TASK_ID);
    expect(texto).toContain('hasFirstName=true');
    expect(texto).toContain('hasDependency=true');
    expect(texto).toContain('hasSpecialty=true');
    expect(texto).toContain('hasResponsible=true');
    expect(texto).toContain('serviceTypeCount=2');
  });

  it('--verbose: o resumo de campos tem os NOMES dos campos e presença/tamanho — NUNCA os valores', () => {
    const mapper = mapperDublado(inputComDadosSensiveis());
    processDryRun(tarefa(), 0, 1, mapper, new Set(), counters(), true);

    const texto = saida.join('\n');
    for (const valor of VALORES_SENSIVEIS) {
      expect(texto).not.toContain(valor);
    }
    // nome dos campos aparece, com presença/tamanho — não o conteúdo:
    expect(texto).toMatch(/diagnosis:presente\(len=\d+\)/);
    expect(texto).toMatch(/clinicalSpecialty:presente\(len=\d+\)/);
    expect(texto).toMatch(/dependencyLevel:presente\(len=\d+\)/);
    expect(texto).toMatch(/responsibles:presente\(n=1\)/);
    expect(texto).toMatch(/caseNumber:presente/); // número: presença, nunca o valor 4242
    expect(texto).not.toContain('4242');
  });

  it('campo AUSENTE aparece como "ausente", nunca omitido em silêncio', () => {
    const semDiagnostico = { ...inputComDadosSensiveis(), diagnosis: null, clinicalSpecialty: undefined };
    const mapper = mapperDublado(semDiagnostico as unknown as ReturnType<typeof inputComDadosSensiveis>);
    processDryRun(tarefa(), 0, 1, mapper, new Set(), counters(), true);

    const texto = saida.join('\n');
    expect(texto).toContain('hasSpecialty=false');
    expect(texto).toMatch(/diagnosis:ausente/);
  });

  it('mapper.map() LANÇA com um valor sensível na própria mensagem de erro → a saída NÃO contém o valor, só a classe do erro', () => {
    const mapper = { map: jest.fn(() => { throw new TypeError(`campo inválido: ${DIAGNOSTICO}`); }) } as unknown as ClickUpPatientMapper;
    processDryRun(tarefa(), 0, 1, mapper, new Set(), counters(), false);

    const texto = saida.join('\n');
    expect(texto).not.toContain(DIAGNOSTICO);
    expect(texto).toContain('TypeError');
    expect(texto).toContain(TASK_ID);
  });

  it('erro não-Error lançado por mapper.map() → classe "NaoEError", nunca o valor lançado', () => {
    const mapper = { map: jest.fn(() => { throw `string sensível: ${NOME}`; }) } as unknown as ClickUpPatientMapper;
    processDryRun(tarefa(), 0, 1, mapper, new Set(), counters(), false);

    const texto = saida.join('\n');
    expect(texto).not.toContain(NOME);
    expect(texto).toContain('NaoEError');
  });

  it('task.parent !== null (subtask) → pulada, sem chamar o mapper', () => {
    const mapper = mapperDublado(inputComDadosSensiveis());
    const c = counters();
    const subtask = { id: TASK_ID, parent: 'algum-pai', status: { status: 'activo' }, custom_fields: [] } as unknown as ClickUpTask;

    processDryRun(subtask, 0, 1, mapper, new Set(), c, false);

    expect(c.skippedSubtask).toBe(1);
    expect(mapper.map).not.toHaveBeenCalled();
  });

  function tarefaSemCampos(): ClickUpTask {
    return { id: TASK_ID, status: { status: 'activo' }, parent: null, custom_fields: [] } as unknown as ClickUpTask;
  }

  it('mapper.map() devolve null e a task não tem nome → SKIPPED_NO_PATIENT_NAME', () => {
    const mapper = mapperDublado(null);
    const c = counters();
    processDryRun(tarefaSemCampos(), 0, 1, mapper, new Set(), c, false);
    expect(c.skippedNoName).toBe(1);
  });

  it('mapper.map() devolve null e a task TEM nome → SKIPPED_MAPPER_NULL (outro motivo de recusa)', () => {
    const mapper = mapperDublado(null);
    const c = counters();
    const comNome = {
      id: TASK_ID, status: { status: 'activo' }, parent: null,
      custom_fields: [{ id: 'x', name: 'Nombre de Paciente', value: NOME }],
    } as unknown as ClickUpTask;
    processDryRun(comNome, 0, 1, mapper, new Set(), c, false);
    expect(c.skippedMapper).toBe(1);
  });

  it('existingIds JÁ TEM o task.id → classificado "would UPDATE", conta wouldUpdate', () => {
    const mapper = mapperDublado(inputComDadosSensiveis());
    const c = counters();
    processDryRun(tarefa(), 0, 1, mapper, new Set([TASK_ID]), c, false);

    expect(c.wouldUpdate).toBe(1);
    expect(c.wouldCreate).toBe(0);
    expect(saida.join('\n')).toContain('would UPDATE');
  });

  it('existingIds não vazio mas SEM o task.id → classificado "would CREATE", conta wouldCreate', () => {
    const mapper = mapperDublado(inputComDadosSensiveis());
    const c = counters();
    processDryRun(tarefa(), 0, 1, mapper, new Set(['outro-task-id']), c, false);

    expect(c.wouldCreate).toBe(1);
    expect(saida.join('\n')).toContain('would CREATE');
  });

  it('existingIds VAZIO (banco não classificou nada) → "would UPSERT"', () => {
    const mapper = mapperDublado(inputComDadosSensiveis());
    processDryRun(tarefa(), 0, 1, mapper, new Set(), counters(), false);
    expect(saida.join('\n')).toContain('would UPSERT');
  });

  it('serviceType e responsibles AUSENTES (undefined, não array vazio) → serviceTypeCount=0, hasResponsible=false', () => {
    const semListas = { ...inputComDadosSensiveis(), serviceType: undefined, responsibles: undefined };
    const mapper = mapperDublado(semListas as unknown as ReturnType<typeof inputComDadosSensiveis>);
    processDryRun(tarefa(), 0, 1, mapper, new Set(), counters(), false);

    const texto = saida.join('\n');
    expect(texto).toContain('serviceTypeCount=0');
    expect(texto).toContain('hasResponsible=false');
  });
});

describe('checkExistingTaskIds', () => {
  it('taskIds vazio → não consulta o banco, devolve Set vazio', async () => {
    const query = jest.fn();
    const pool = { query } as unknown as Pool;

    const result = await checkExistingTaskIds(pool, []);

    expect(result).toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });

  it('consulta o banco e devolve só os ids que existem', async () => {
    const query = jest.fn(async () => ({ rows: [{ clickup_task_id: 'a' }, { clickup_task_id: 'b' }] }));
    const pool = { query } as unknown as Pool;

    const result = await checkExistingTaskIds(pool, ['a', 'b', 'c']);

    expect(result).toEqual(new Set(['a', 'b']));
    expect(query).toHaveBeenCalledTimes(1);
  });
});
