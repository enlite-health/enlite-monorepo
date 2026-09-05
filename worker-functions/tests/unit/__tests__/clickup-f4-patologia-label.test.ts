/**
 * spec 016 F4 — `ClickUpPatientMapper.resolvePatologiaLabel()`: lê o rótulo cru de
 * "Tipo de Patología" para o `ClickUpDiagnosisMapper` sincronizar contra o CID-11.
 *
 * "Tipo de Patología" ENTROU em `PATIENT_CATALOG_FIELDS` (o 11º campo) — `resolvePatologiaLabel`
 * roda o MESMO preflight fail-closed de `map()`/`readSourceLabels()` (task 1.11), e a régua de
 * deriva (`clickup-1.11-campo-renomeado.test.ts`) exige isso de toda chamada literal de
 * `resolveDropdown`. O dublê abaixo devolve `'drop_down'` para QUALQUER nome — molde do
 * `resolverFalso()` de `clickup-f4-diagnosis-sync.test.ts` — porque este arquivo testa só a
 * leitura de "Tipo de Patología", não a régua inteira dos outros 10 campos (essa já tem suíte
 * própria: `clickup-2.3-mapper-alimenta-o-cru.test.ts`).
 */
import { ClickUpPatientMapper } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask, ClickUpTaskCustomField } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';

const PATOLOGIA = 'Tipo de Patología';
const OPCOES = ['Trastorno del Espectro Autista', 'Parálisis Cerebral'];

function resolverFalso(): ClickUpFieldResolver {
  return {
    getFieldType: () => 'drop_down',
    resolveDropdown: (f: string, v: number | string | null | undefined) => {
      if (v === null || v === undefined || v === '') return null;
      return f === PATOLOGIA ? OPCOES[Number(v)] ?? null : null;
    },
    resolveLabels: () => [],
    resolveLabel: () => null,
  } as unknown as ClickUpFieldResolver;
}

function taskWith(fields: ClickUpTaskCustomField[]): ClickUpTask {
  return {
    id: 'task-1',
    name: 'Doe, Jane',
    parent: null,
    status: { status: 'admisión' },
    custom_fields: fields,
  } as unknown as ClickUpTask;
}

describe('ClickUpPatientMapper.readPatologia (spec 016 F4 + I3)', () => {
  it('devolve a LEITURA com o rótulo quando "Tipo de Patología" está preenchido', () => {
    const mapper = new ClickUpPatientMapper(resolverFalso());
    const task = taskWith([{ id: 'cf1', name: PATOLOGIA, value: 0 } as ClickUpTaskCustomField]);

    expect(mapper.readPatologia(task)).toMatchObject({
      readable: true, labels: ['Trastorno del Espectro Autista'], requested: 1, resolved: 1,
    });
  });

  it('leitura VAZIA quando o campo está vazio (ninguém preencheu) — ausência legítima', () => {
    const mapper = new ClickUpPatientMapper(resolverFalso());
    const task = taskWith([{ id: 'cf1', name: PATOLOGIA, value: null } as ClickUpTaskCustomField]);

    expect(mapper.readPatologia(task)).toMatchObject({ readable: true, labels: [], requested: 0 });
  });

  it('leitura VAZIA quando a tarefa não tem o custom field — nunca lança', () => {
    const mapper = new ClickUpPatientMapper(resolverFalso());
    const task = taskWith([]);

    expect(mapper.readPatologia(task)).toMatchObject({ readable: true, labels: [], requested: 0 });
  });

  it('I3: opção que NÃO resolve é ILEGÍVEL, não vazio (o `null` de duas caras, D167)', () => {
    const mapper = new ClickUpPatientMapper(resolverFalso());
    // orderindex 99 não existe em OPCOES: a origem MANDOU valor e o catálogo não traduziu.
    const task = taskWith([{ id: 'cf1', name: PATOLOGIA, value: 99 } as ClickUpTaskCustomField]);

    expect(mapper.readPatologia(task)).toMatchObject({
      readable: false, reason: 'options_unresolved', requested: 1, resolved: 0,
    });
  });
});
