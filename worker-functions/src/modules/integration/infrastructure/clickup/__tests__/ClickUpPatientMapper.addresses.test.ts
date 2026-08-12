/**
 * ClickUpPatientMapper — buildAddresses normalization tests (Fase 1 dedup de
 * endereços de paciente).
 *
 * Proves the shared locationHelpers normalization (argentinaLocationNormalizer)
 * is actually wired end-to-end through the mapper: dirty ClickUp location
 * payloads must come out with canonical `state`, postal-prefix-free `city`,
 * and no literal "null" `neighborhood`.
 */

import { ClickUpPatientMapper } from '../ClickUpPatientMapper';
import type { ClickUpFieldResolver } from '../ClickUpFieldResolver';
import type { ClickUpTask, ClickUpTaskCustomField } from '../ClickUpTask';

function makeCf(name: string, value: unknown): ClickUpTaskCustomField {
  return { id: `cf-${name}`, name, type: 'text', value };
}

function makeLocation(overrides: {
  formatted_address?: string;
  address_components?: Array<{ long_name: string; types: string[] }>;
}) {
  return {
    formatted_address: overrides.formatted_address ?? null,
    address_components: overrides.address_components ?? [],
  };
}

function makeResolver(): ClickUpFieldResolver {
  return {
    resolveDropdown: jest.fn(() => null),
    resolveLabel: jest.fn(() => null),
    resolveLabels: jest.fn(() => []),
  } as unknown as ClickUpFieldResolver;
}

function makeTask(customFields: ClickUpTaskCustomField[]): ClickUpTask {
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

describe('ClickUpPatientMapper.buildAddresses — normalization border', () => {
  const mapper = new ClickUpPatientMapper(makeResolver());

  it('normalizes a dirty province ("Buenos Aires Province") to the canonical label', () => {
    const task = makeTask([
      makeCf('Domicilio 1 Principal Paciente', makeLocation({
        formatted_address: 'Av. Siempre Viva 123, San Isidro, Buenos Aires Province, Argentina',
        address_components: [
          { long_name: 'San Isidro', types: ['locality'] },
          { long_name: 'Buenos Aires Province', types: ['administrative_area_level_1'] },
        ],
      })),
    ]);

    const result = mapper.map(task);
    expect(result?.addresses?.[0]?.state).toBe('Provincia de Buenos Aires');
  });

  it('strips postal-code prefix from city ("B1602 Florida" → "Florida")', () => {
    const task = makeTask([
      makeCf('Domicilio 1 Principal Paciente', makeLocation({
        formatted_address: 'Calle X 100, B1602 Florida, Buenos Aires, Argentina',
        address_components: [
          { long_name: 'B1602 Florida', types: ['locality'] },
          { long_name: 'Buenos Aires', types: ['administrative_area_level_1'] },
        ],
      })),
    ]);

    const result = mapper.map(task);
    expect(result?.addresses?.[0]?.city).toBe('Florida');
  });

  it('drops the literal string "null" neighborhood from the location component', () => {
    const task = makeTask([
      makeCf('Domicilio 1 Principal Paciente', makeLocation({
        formatted_address: 'Calle X 100, San Isidro, Buenos Aires, Argentina',
        address_components: [
          { long_name: 'null', types: ['sublocality_level_1'] },
          { long_name: 'San Isidro', types: ['locality'] },
          { long_name: 'Buenos Aires', types: ['administrative_area_level_1'] },
        ],
      })),
    ]);

    const result = mapper.map(task);
    expect(result?.addresses?.[0]?.neighborhood).toBeUndefined();
  });

  it('drops the legacy "Zona o Barrio Paciente" field when it is the literal string "null"', () => {
    const task = makeTask([
      makeCf('Domicilio 1 Principal Paciente', makeLocation({
        formatted_address: 'Calle X 100, San Isidro, Buenos Aires, Argentina',
        address_components: [
          { long_name: 'San Isidro', types: ['locality'] },
          { long_name: 'Buenos Aires', types: ['administrative_area_level_1'] },
        ],
      })),
      makeCf('Zona o Barrio Paciente', 'null'),
    ]);

    const result = mapper.map(task);
    expect(result?.addresses?.[0]?.neighborhood).toBeUndefined();
  });

  it('returns state=undefined (never a raw city name) when administrative_area_level_1 is actually a city', () => {
    const task = makeTask([
      makeCf('Domicilio 1 Principal Paciente', makeLocation({
        formatted_address: 'Calle X 100, San Salvador de Jujuy, Argentina',
        address_components: [
          { long_name: 'San Salvador de Jujuy', types: ['administrative_area_level_1'] },
        ],
      })),
    ]);

    const result = mapper.map(task);
    expect(result?.addresses?.[0]?.state).toBeUndefined();
  });

  it('REGRESSION (patient_addresses id a06d5086-90cf-422d-ab05-7431b8aed7ea): cascades to sublocality when locality is a pure CP (no locality name)', () => {
    // Reproduces the prod row exactly: `locality` is absent from
    // address_components (Google had no named locality for this point) and
    // `administrative_area_level_2` came back as a bare Argentine postal
    // code ("C1126ABC") with no locality text at all. `sublocality_level_1`
    // ("Barrio Norte") is available and must be used instead of writing the
    // dead-end CP or a hard null.
    const task = makeTask([
      makeCf('Domicilio 1 Principal Paciente', makeLocation({
        formatted_address: 'Uriburu 1234, C1126ABC, Argentina',
        address_components: [
          { long_name: 'C1126ABC', types: ['administrative_area_level_2'] },
          { long_name: 'Barrio Norte', types: ['sublocality_level_1'] },
          { long_name: 'CABA', types: ['administrative_area_level_1'] },
        ],
      })),
    ]);

    const result = mapper.map(task);
    expect(result?.addresses?.[0]?.city).toBe('Barrio Norte');
  });

  it('cascades all the way to null when EVERY city-tier candidate is a pure CP', () => {
    const task = makeTask([
      makeCf('Domicilio 1 Principal Paciente', makeLocation({
        formatted_address: 'Uriburu 1234, C1126ABC, Argentina',
        address_components: [
          { long_name: 'C1126ABC', types: ['locality'] },
          { long_name: 'C1126ABC', types: ['administrative_area_level_2'] },
          { long_name: 'CABA', types: ['administrative_area_level_1'] },
        ],
      })),
    ]);

    const result = mapper.map(task);
    expect(result?.addresses?.[0]?.city).toBeUndefined();
  });
});
