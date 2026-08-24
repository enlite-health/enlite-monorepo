/**
 * Task 2.3 — o mapper alimenta o CRU e CONTINUA alimentando o derivado (D-B).
 *
 * O que esta suíte prova, e por que cada peça existe:
 *
 *  1. Os DOIS destinos são alimentados na mesma passada. O critério da task é literalmente
 *     "alimenta o cru E continua alimentando o derivado" — provar só um lado deixa passar a
 *     regressão que importa (o cru entrar às custas do derivado).
 *  2. A generalidade da antiga 1.4, que a 2.2 absorveu: o cru é persistido para TODO campo de
 *     `PATIENT_CATALOG_FIELDS`, não só `Segmentos Clínicos`. Uma suíte que só olhasse segmento
 *     aprovaria uma fiação que deixa 7 campos de fora — e o guardian de FORMA não pegaria (D155).
 *  3. "Não consegui ler" NÃO apaga (D167/F41). É a classe de defeito que esta change inteira
 *     persegue, e a 2.3 é onde ela teria a última chance de voltar: basta o use case traduzir
 *     `readable:false` em lista vazia.
 *  4. Falha ao gravar o cru NÃO derruba o sync, mas também NÃO passa muda (F43).
 *
 * Nada aqui toca banco nem rede: resolver, repositório e serviço são dublês.
 */

import { ClickUpPatientMapper, PATIENT_DROPDOWN_FIELDS } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { SyncPatientFromClickUpTaskUseCase } from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { SyncPatientDeps } from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import type { PatientService } from '../../../src/modules/case/application/PatientService';

// ── Catálogo sintético: os 8 campos declarados, todos `drop_down` como hoje ───
const OPCOES: Record<string, string[]> = {
  'Dependencia':                            ['LEVE', 'MODERADA', 'GRAVE'],
  'Sexo Asignado al Nacer (Uso Clínico)':   ['F', 'M'],
  'Tipo de Documento Paciente':             ['DNI', 'PASAPORTE'],
  'Segmentos Clínicos':                     ['AT para pacientes con TEA', 'Cuidado Integral de Pacientes con TEA'],
  'Servicio':                               ['Acompañamiento'],
  'Relación con el Paciente':               ['Madre', 'Padre'],
  'Tipo de Documento Responsable':          ['DNI'],
  'Equipo Tratante Multidisciplinario':     ['Sí', 'No'],
};

function resolverFalso(over: Partial<{ tipos: Record<string, string | null> }> = {}): ClickUpFieldResolver {
  return {
    getFieldType: (f: string) => {
      if (over.tipos && f in over.tipos) return over.tipos[f];
      return f in OPCOES ? 'drop_down' : null;
    },
    resolveDropdown: (f: string, v: number | string | null | undefined) => {
      if (v === null || v === undefined || v === '') return null;
      return OPCOES[f]?.[Number(v)] ?? null;
    },
    resolveLabels: (f: string, ids: readonly string[]) =>
      ids.map(id => OPCOES[f]?.[Number(id)]).filter((x): x is string => !!x),
    resolveLabel: () => null,
  } as unknown as ClickUpFieldResolver;
}

function tarefa(campos: Record<string, unknown>): ClickUpTask {
  return {
    id: 'task-sintetica',
    name: 'FIXTURE, Paciente',
    status: { status: 'admisión' },
    parent: null,
    custom_fields: Object.entries(campos).map(([name, value]) => ({ name, value })),
    url: 'https://app.clickup.com/t/task-sintetica',
    date_created: '1700000000000',
    date_updated: '1700100000000',
  } as unknown as ClickUpTask;
}

/** A tarefa "normal": segmento preenchido no índice 1 (`Cuidado Integral …`). */
const TAREFA_BOA = tarefa({
  'Nombre de Paciente':   'Paciente',
  'Apellido del Paciente': 'FIXTURE',
  'Segmentos Clínicos':   1,
  'Dependencia':          2,
});

// ── Bancada: use case com repositório do cru espionado ────────────────────────
interface Bancada {
  deps: SyncPatientDeps;
  gravacoes: Array<{ fieldName: string; readable: boolean; labels: unknown[] }>;
  derivado: { clinicalSpecialty: unknown; escritas: number };
  erros: string[];
  infos: string[];
}

function bancada(over: Partial<{ falhaAoGravar: string; tipos: Record<string, string | null> }> = {}): Bancada {
  const mapper = new ClickUpPatientMapper(resolverFalso({ tipos: over.tipos }));
  const gravacoes: Bancada['gravacoes'] = [];
  const derivado = { clinicalSpecialty: undefined as unknown, escritas: 0 };
  const erros: string[] = [];
  const infos: string[] = [];

  const patientService = {
    upsertFromClickUp: jest.fn(async (input: { clinicalSpecialty?: unknown }) => {
      derivado.clinicalSpecialty = input.clinicalSpecialty ?? null;
      derivado.escritas += 1;
      return { id: 'patient-sintetico', created: false, flagged: false };
    }),
  } as unknown as PatientService;

  const sourceLabelRepository = {
    replaceForField: jest.fn(async ({ fieldName, read }: { fieldName: string; read: { readable: boolean; labels?: unknown[] } }) => {
      if (over.falhaAoGravar === fieldName) throw new Error('boom sintético');
      gravacoes.push({ fieldName, readable: read.readable, labels: read.labels ?? [] });
      return read.readable
        ? { fieldName, outcome: 'written' as const, received: (read.labels ?? []).length, empty: 0,
            accepted: (read.labels ?? []) as string[], rejected: [], newlyRejected: 0,
            rejectionsDurable: 'not-applicable' as const }
        : { fieldName, outcome: 'skipped-unreadable' as const, received: 0, empty: 0,
            accepted: [], rejected: [], newlyRejected: 0, rejectionsDurable: 'not-applicable' as const };
    }),
  } as unknown as SyncPatientDeps['sourceLabelRepository'];

  jest.spyOn(require('firebase-functions').logger, 'error').mockImplementation((...a: unknown[]) => { erros.push(JSON.stringify(a)); });
  jest.spyOn(require('firebase-functions').logger, 'info').mockImplementation((...a: unknown[]) => { infos.push(JSON.stringify(a)); });
  jest.spyOn(require('firebase-functions').logger, 'warn').mockImplementation(() => {});

  return { deps: { mapper, patientService, sourceLabelRepository }, gravacoes, derivado, erros, infos };
}

afterEach(() => jest.restoreAllMocks());

describe('2.3 — o mapper alimenta o CRU e continua alimentando o DERIVADO', () => {
  it('OS DOIS DESTINOS na mesma passada: derivado gravado E cru gravado', async () => {
    const b = bancada();
    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(TAREFA_BOA, {}, 'cid-1');

    const segmento = b.gravacoes.find(g => g.fieldName === 'Segmentos Clínicos');
    console.log(`>>> 2.3 | kind=${r.kind} | derivado.escritas=${b.derivado.escritas} | derivado=${JSON.stringify(b.derivado.clinicalSpecialty)}`);
    console.log(`>>> 2.3 | cru de segmento=${JSON.stringify(segmento)}`);

    expect(r.kind).toBe('UPDATED');
    expect(b.derivado.escritas).toBe(1);                       // o derivado continua
    expect(b.derivado.clinicalSpecialty).not.toBeUndefined();
    expect(segmento).toBeDefined();                            // e o cru entrou
    expect(segmento!.readable).toBe(true);
    expect(segmento!.labels).toEqual(['Cuidado Integral de Pacientes con TEA']);
  });

  it('A GENERALIDADE: o cru é persistido para TODO campo declarado, não só segmento', async () => {
    const b = bancada();
    await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(TAREFA_BOA, {}, 'cid-2');

    const gravados = b.gravacoes.map(g => g.fieldName).sort();
    const declarados = [...PATIENT_DROPDOWN_FIELDS].sort();
    console.log(`>>> 2.3/generalidade | gravados=${gravados.length} | declarados=${declarados.length}`);
    console.log(`>>> 2.3/generalidade | faltando=${JSON.stringify(declarados.filter(d => !gravados.includes(d)))}`);

    expect(gravados.length).toBeGreaterThan(0);                // contagem zero reprova (F19)
    expect(gravados).toEqual(declarados);
  });

  it('D167: campo cujo valor a origem MANDOU e o catálogo não traduziu chega como ILEGÍVEL — e não vira lista vazia', async () => {
    // orderindex 99 não existe no catálogo: a origem mandou valor, a tradução falhou.
    const b = bancada();
    await new SyncPatientFromClickUpTaskUseCase(b.deps)
      .execute(tarefa({ 'Nombre de Paciente': 'Paciente', 'Apellido del Paciente': 'FIXTURE', 'Segmentos Clínicos': 99 }), {}, 'cid-3');

    const segmento = b.gravacoes.find(g => g.fieldName === 'Segmentos Clínicos');
    console.log(`>>> 2.3/D167 | cru de segmento=${JSON.stringify(segmento)}`);

    expect(segmento).toBeDefined();
    expect(segmento!.readable).toBe(false);                    // <<< ilegível, NÃO vazio
    expect(segmento!.labels).toEqual([]);                      // e nada de rótulo inventado
  });

  it('CONTROLE POSITIVO do anterior: campo genuinamente VAZIO chega como LEGÍVEL e vazio', async () => {
    const b = bancada();
    await new SyncPatientFromClickUpTaskUseCase(b.deps)
      .execute(tarefa({ 'Nombre de Paciente': 'Paciente', 'Apellido del Paciente': 'FIXTURE' }), {}, 'cid-4');

    const segmento = b.gravacoes.find(g => g.fieldName === 'Segmentos Clínicos');
    console.log(`>>> 2.3/vazio-legítimo | cru de segmento=${JSON.stringify(segmento)}`);

    expect(segmento).toBeDefined();
    expect(segmento!.readable).toBe(true);                     // vazio de VERDADE se escreve (D-E)
    expect(segmento!.labels).toEqual([]);
  });

  it('F43: falha ao gravar o cru NÃO derruba o sync — e NÃO passa muda', async () => {
    const b = bancada({ falhaAoGravar: 'Segmentos Clínicos' });
    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(TAREFA_BOA, {}, 'cid-5');

    const gritou = b.erros.filter(l => l.includes('source_labels_error'));
    const resumo = b.infos.filter(l => l.includes('clickup_patient_sync.source_labels'));
    console.log(`>>> 2.3/F43 | kind=${r.kind} | erros gritados=${gritou.length} | outros campos gravados=${b.gravacoes.length}`);

    expect(r.kind).toBe('UPDATED');                            // o paciente está correto: não derruba
    expect(gritou.length).toBe(1);                             // mas grita, com evento próprio
    expect(resumo.length).toBe(1);                             // e o resumo sai com a contagem
    expect(resumo[0]).toContain('"falhas":1');
    expect(b.gravacoes.length).toBe(PATIENT_DROPDOWN_FIELDS.length - 1);  // os outros 7 seguiram
  });

  it('C1/lex: nenhuma linha de log do caminho do cru carrega rótulo, valor ou id de tarefa', async () => {
    const b = bancada({ falhaAoGravar: 'Segmentos Clínicos' });
    await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(TAREFA_BOA, {}, 'cid-6');

    const linhas = [...b.erros, ...b.infos].filter(l => l.includes('source_labels'));
    const proibido = linhas.filter(l =>
      l.includes('Cuidado Integral') || l.includes('AT para pacientes') || l.includes('task-sintetica'));
    console.log(`>>> 2.3/C1 | linhas do cru=${linhas.length} | com dado proibido=${proibido.length}`);
    console.log(`>>> 2.3/C1 | amostra=${linhas[0]}`);

    expect(linhas.length).toBeGreaterThan(0);                  // contagem zero reprova (F19)
    expect(proibido).toEqual([]);
  });
});
