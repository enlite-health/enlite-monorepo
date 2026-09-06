/**
 * ClickUpPatientMapper — country stays independent of the admin create path
 * (regression guard for abac-pais-fase1 task 5.1).
 *
 * Task 5.1 made `country` REQUIRED on the admin border (createPatientSchema +
 * CreatePatientInput) and removed the hardcoded 'AR' from CreatePatientUseCase.
 * The ClickUp sync is a DIFFERENT write path: it goes through
 * PatientService.upsertFromClickUp with its own input type, and sets country
 * itself in the mapper. These tests pin that separation so the admin-border
 * tightening can never silently break the sync — the failure mode would be
 * mute (patients stop syncing, or sync under the wrong jurisdiction).
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
    // O mapper do main (specs 011-016) consulta o TIPO do campo antes de resolver.
    getFieldType: jest.fn(() => 'drop_down'),
  } as unknown as ClickUpFieldResolver;
}

function makeTask(customFields: ClickUpTaskCustomField[] = []): ClickUpTask {
  return {
    id: 'task-001',
    name: 'García, Ana',
    status: { status: 'activo' },
    parent: null,
    custom_fields: [
      makeCf('Nombre de Paciente', 'Ana'),
      makeCf('Apellido del Paciente', 'García'),
      ...customFields,
    ],
    url: 'https://app.clickup.com/t/task-001',
    date_created: '1700000000000',
    date_updated: '1700100000000',
  };
}

describe('ClickUpPatientMapper — country is set by the sync path itself', () => {
  const mapper = new ClickUpPatientMapper(makeResolver());

  it('still maps a task to a patient with country=AR (sync unaffected by task 5.1)', () => {
    const result = mapper.map(makeTask());

    expect(result).not.toBeNull();
    expect(result?.country).toBe('AR');
  });

  it('does not require the caller to supply country — the mapper owns it', () => {
    // The admin border now rejects a missing country. The sync must NOT inherit
    // that requirement: it never goes through createPatientSchema and supplies
    // country on its own, so mapping a bare task keeps working.
    const result = mapper.map(makeTask());

    expect(result?.country).toBeDefined();
    expect(result?.firstName).toBe('Ana');
  });
});
