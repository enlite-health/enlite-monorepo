/**
 * ClickUpPatientMapper — quais chaves clínicas o mapper EMITE (contrato com o Merge Patch
 * do PatientClinicalRepository, D211.1 · RFC 7396).
 *
 * Chave AUSENTE não toca a coluna. Hoje o mapper não emite `clinicalSegments` nem `deviceType`;
 * logo o sync do ClickUp deixa esses dois campos como estão (não os zera). As chaves que ele
 * emite com `null` explícito continuam limpando a coluna (D167). Se alguém passar a emitir
 * uma das duas chaves, este teste fica vermelho de propósito: a semântica do sync muda.
 */
import { ClickUpPatientMapper } from '../ClickUpPatientMapper';
import type { ClickUpFieldResolver } from '../ClickUpFieldResolver';
import type { ClickUpTask, ClickUpTaskCustomField } from '../ClickUpTask';

function makeCf(name: string, value: unknown): ClickUpTaskCustomField {
  return { id: `cf-${name}`, name, type: 'text', value };
}

function makeResolver(): ClickUpFieldResolver {
  return {
    resolveDropdown: jest.fn(() => null),
    resolveLabel: jest.fn(() => null),
    resolveLabels: jest.fn(() => []),
  } as unknown as ClickUpFieldResolver;
}

function makeTask(): ClickUpTask {
  return {
    id: 'task-clin-001',
    name: 'García, Ana',
    status: { status: 'activo' },
    parent: null,
    custom_fields: [makeCf('Nombre de Paciente', 'Ana'), makeCf('Apellido del Paciente', 'García')],
    url: 'https://app.clickup.com/t/task-clin-001',
    date_created: '1700000000000',
    date_updated: '1700100000000',
  };
}

describe('ClickUpPatientMapper.map — chaves clínicas emitidas', () => {
  const mapper = new ClickUpPatientMapper(makeResolver());

  it('NÃO emite clinicalSegments nem deviceType (chave ausente ⇒ o sync não toca a coluna)', () => {
    const input = mapper.map(makeTask());
    expect(input).not.toBeNull();
    expect(Object.prototype.hasOwnProperty.call(input, 'clinicalSegments')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(input, 'deviceType')).toBe(false);
  });

  it('emite as demais chaves clínicas com null explícito quando vazias (D167: null limpa)', () => {
    const input = mapper.map(makeTask())!;
    for (const k of ['diagnosis', 'dependencyLevel', 'clinicalSpecialty', 'serviceType', 'additionalComments'] as const) {
      expect(Object.prototype.hasOwnProperty.call(input, k)).toBe(true);
      expect(input[k]).toBeNull();
    }
  });
});
