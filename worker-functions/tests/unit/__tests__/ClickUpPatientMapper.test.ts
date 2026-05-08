/**
 * ClickUpPatientMapper — Unit Tests (Fase 1, Sprint refactor de vagas)
 *
 * 100% coverage of mapper logic including new fields from migration 147:
 *   - healthInsuranceName      (ClickUp: "Cobertura Informada")
 *   - healthInsuranceMemberId  (ClickUp: "Número ID Afiliado Paciente")
 *   - addresses[].state        (ClickUp: "Provincia del Paciente")
 *   - addresses[].city         (ClickUp: "Ciudad / Localidad del Paciente")
 *   - addresses[].neighborhood (ClickUp: "Zona o Barrio Paciente")
 *
 * Coverage plan:
 *   (a) Full task: all new fields present → output populated
 *   (b) healthInsuranceName absent → null in output
 *   (c) healthInsuranceMemberId absent → null in output
 *   (d) Provincia present with address_components → state extracted from component
 *   (e) Provincia present with formatted_address only → state from formatted_address
 *   (f) Provincia absent/null → state null in address
 *   (g) Ciudad present with address_components → city extracted from component
 *   (h) Ciudad absent/null → city null in address
 *   (i) Zona o Barrio present → neighborhood in primary address
 *   (j) Zona o Barrio absent → neighborhood null in primary address
 *   (k) Zona o Barrio empty string → neighborhood null
 *   (l) state/city/neighborhood only populated on primary address (slot 1), not slot 2/3
 *   (m) Task with no nombre/apellido and no parseable name → returns null
 *   (n) Task with name parsed from title (fallback)
 *   (o) Responsibles built correctly (single responsible)
 *   (p) No addresses filled → empty addresses array
 *   (q) Multiple address slots: only slot 1 gets patient-level location metadata
 *   (r) healthInsuranceName with whitespace → trimmed
 *   (s) healthInsuranceMemberId empty string → null
 */

import { ClickUpPatientMapper, extractCaseNumber } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpTask, ClickUpTaskCustomField } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';

// ── Mock ClickUpFieldResolver ─────────────────────────────────────────────────

type DropdownStub = Record<string, Record<number, string>>;

function makeResolver(dropdowns: DropdownStub = {}) {
  return {
    resolveDropdown(fieldName: string, value: number | string | null | undefined): string | null {
      if (value === null || value === undefined || value === '') return null;
      const map = dropdowns[fieldName];
      if (!map) return null;
      const key = typeof value === 'number' ? value : Number(value);
      return Number.isNaN(key) ? null : (map[key] ?? null);
    },
    resolveLabel: () => null,
    resolveLabels: () => [],
    getFieldType: () => null,
  } as unknown as import('../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver').ClickUpFieldResolver;
}

// ── Task builder ──────────────────────────────────────────────────────────────

interface CfEntry { name: string; value: unknown; type?: string; }

function makeTask(
  id: string,
  name: string,
  status: string,
  fields: CfEntry[],
  parent: string | null = null,
): ClickUpTask {
  return {
    id,
    name,
    status: { status, color: '#000', type: 'custom' },
    parent,
    custom_fields: fields.map(f => ({
      id: `cf-${f.name}`,
      name: f.name,
      type: f.type ?? 'text',
      value: f.value,
    })) as ClickUpTaskCustomField[],
    url: `https://app.clickup.com/t/${id}`,
    date_created: '1700000000000',
    date_updated: '1700100000000',
  };
}

function locationField(
  formattedAddress: string,
  addressComponents?: Array<{ long_name: string; short_name: string; types: string[] }>,
) {
  return {
    formatted_address: formattedAddress,
    lat: -34.6,
    lng: -58.4,
    ...(addressComponents ? { address_components: addressComponents } : {}),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ClickUpPatientMapper', () => {
  const mapper = new ClickUpPatientMapper(makeResolver());

  // ── (a) Full task: all new fields present ─────────────────────────────────

  it('(a) all new fields present → output populated with healthInsurance + location', () => {
    const task = makeTask('task-a', 'Pérez, Juan', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Juan' },
      { name: 'Apellido del Paciente', value: 'Pérez' },
      { name: 'Cobertura Informada', value: 'OSDE 210' },
      { name: 'Número ID Afiliado Paciente', value: '1234567890' },
      { name: 'Zona o Barrio Paciente', value: 'Palermo Soho' },
      {
        name: 'Provincia del Paciente',
        value: locationField('Buenos Aires, Argentina', [
          { long_name: 'Buenos Aires', short_name: 'BA', types: ['administrative_area_level_1', 'political'] },
          { long_name: 'Argentina', short_name: 'AR', types: ['country', 'political'] },
        ]),
      },
      {
        name: 'Ciudad / Localidad del Paciente',
        value: locationField('Palermo, Buenos Aires, Argentina', [
          { long_name: 'Palermo', short_name: 'Palermo', types: ['locality', 'political'] },
          { long_name: 'Buenos Aires', short_name: 'BA', types: ['administrative_area_level_1', 'political'] },
        ]),
      },
      {
        name: 'Domicilio 1 Principal Paciente',
        value: locationField('Thames 1234, Palermo, Buenos Aires'),
      },
      { name: 'Domicilio Informado Paciente 1', value: 'Thames 1234' },
      { name: 'Número de WhatsApp Responsable', value: null },
    ]);

    const result = mapper.map(task);

    expect(result).not.toBeNull();
    expect(result!.healthInsuranceName).toBe('OSDE 210');
    expect(result!.healthInsuranceMemberId).toBe('1234567890');

    // Address populated on primary slot
    expect(result!.addresses).toHaveLength(1);
    expect(result!.addresses![0].state).toBe('Buenos Aires');
    expect(result!.addresses![0].city).toBe('Palermo');
    expect(result!.addresses![0].neighborhood).toBe('Palermo Soho');
  });

  // ── (b) healthInsuranceName absent ────────────────────────────────────────

  it('(b) "Cobertura Informada" absent → healthInsuranceName null', () => {
    const task = makeTask('task-b', 'García, Ana', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Ana' },
      { name: 'Apellido del Paciente', value: 'García' },
      // Cobertura Informada NOT included
      { name: 'Número ID Afiliado Paciente', value: '999' },
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.healthInsuranceName).toBeNull();
    expect(result!.healthInsuranceMemberId).toBe('999');
  });

  // ── (c) healthInsuranceMemberId absent ────────────────────────────────────

  it('(c) "Número ID Afiliado Paciente" absent → healthInsuranceMemberId null', () => {
    const task = makeTask('task-c', 'López, Pedro', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Pedro' },
      { name: 'Apellido del Paciente', value: 'López' },
      { name: 'Cobertura Informada', value: 'Swiss Medical' },
      // No Número ID Afiliado
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.healthInsuranceName).toBe('Swiss Medical');
    expect(result!.healthInsuranceMemberId).toBeNull();
  });

  // ── (d) Provincia with address_components → state from component ──────────

  it('(d) Provincia with address_components → state extracted from administrative_area_level_1', () => {
    const task = makeTask('task-d', 'Smith, John', 'Activo', [
      { name: 'Nombre de Paciente', value: 'John' },
      { name: 'Apellido del Paciente', value: 'Smith' },
      {
        name: 'Provincia del Paciente',
        value: locationField('Córdoba, Argentina', [
          { long_name: 'Córdoba', short_name: 'CBA', types: ['administrative_area_level_1', 'political'] },
        ]),
      },
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Av. Hipólito Yrigoyen 100, Córdoba') },
      { name: 'Domicilio Informado Paciente 1', value: 'Yrigoyen 100' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses![0].state).toBe('Córdoba');
  });

  // ── (e) Provincia with formatted_address only (no components) → fallback ──

  it('(e) Provincia with formatted_address only (no components) → state = first segment', () => {
    const task = makeTask('task-e', 'Martínez, Laura', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Laura' },
      { name: 'Apellido del Paciente', value: 'Martínez' },
      {
        name: 'Provincia del Paciente',
        value: { formatted_address: 'Santa Fe', lat: -31.6, lng: -60.7 },
        // No address_components — single segment, so first segment = "Santa Fe"
      },
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Rivadavia 555, Santa Fe') },
      { name: 'Domicilio Informado Paciente 1', value: 'Rivadavia 555' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses![0].state).toBe('Santa Fe');
  });

  it('(e2) Provincia multi-segment formatted_address (no components) → first segment = province name', () => {
    const task = makeTask('task-e2', 'Gómez, Raúl', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Raúl' },
      { name: 'Apellido del Paciente', value: 'Gómez' },
      {
        name: 'Provincia del Paciente',
        // ClickUp geocodes "Buenos Aires" → full formatted address; first segment = province
        value: { formatted_address: 'Buenos Aires, Cdad. Autónoma de Buenos Aires, Argentina', lat: -34.6, lng: -58.4 },
      },
      {
        name: 'Ciudad / Localidad del Paciente',
        value: { formatted_address: 'Olivos, Buenos Aires, Argentina', lat: -34.5, lng: -58.5 },
      },
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Carlos Gardel 1234, Olivos') },
      { name: 'Domicilio Informado Paciente 1', value: 'Carlos Gardel 1234' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses![0].state).toBe('Buenos Aires');
    expect(result!.addresses![0].city).toBe('Olivos');
  });

  // ── (f) Provincia absent → state null ─────────────────────────────────────

  it('(f) Provincia del Paciente absent → state null in address', () => {
    const task = makeTask('task-f', 'Rodríguez, María', 'Activo', [
      { name: 'Nombre de Paciente', value: 'María' },
      { name: 'Apellido del Paciente', value: 'Rodríguez' },
      // No Provincia del Paciente
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Florida 123, CABA') },
      { name: 'Domicilio Informado Paciente 1', value: 'Florida 123' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses![0].state).toBeUndefined(); // undefined when null/undefined passed as undefined
  });

  // ── (g) Ciudad with address_components → city from locality ───────────────

  it('(g) Ciudad with address_components → city extracted from locality component', () => {
    const task = makeTask('task-g', 'Fernández, Carlos', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Carlos' },
      { name: 'Apellido del Paciente', value: 'Fernández' },
      {
        name: 'Ciudad / Localidad del Paciente',
        value: locationField('Rosario, Santa Fe, Argentina', [
          { long_name: 'Rosario', short_name: 'Rosario', types: ['locality', 'political'] },
          { long_name: 'Santa Fe', short_name: 'SF', types: ['administrative_area_level_1', 'political'] },
        ]),
      },
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Córdoba 2000, Rosario') },
      { name: 'Domicilio Informado Paciente 1', value: 'Córdoba 2000' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses![0].city).toBe('Rosario');
  });

  // ── (h) Ciudad absent → city null ─────────────────────────────────────────

  it('(h) Ciudad / Localidad absent → city null in address', () => {
    const task = makeTask('task-h', 'Torres, Elena', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Elena' },
      { name: 'Apellido del Paciente', value: 'Torres' },
      // No Ciudad / Localidad del Paciente
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Belgrano 456, CABA') },
      { name: 'Domicilio Informado Paciente 1', value: 'Belgrano 456' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses![0].city).toBeUndefined();
  });

  // ── (i) Zona o Barrio present → neighborhood in primary address ───────────

  it('(i) "Zona o Barrio Paciente" present → neighborhood in primary address', () => {
    const task = makeTask('task-i', 'Vargas, Sofía', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Sofía' },
      { name: 'Apellido del Paciente', value: 'Vargas' },
      { name: 'Zona o Barrio Paciente', value: 'Belgrano R' },
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Juramento 1234, Belgrano') },
      { name: 'Domicilio Informado Paciente 1', value: 'Juramento 1234' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses![0].neighborhood).toBe('Belgrano R');
  });

  // ── (j) Zona o Barrio absent → neighborhood null ──────────────────────────

  it('(j) "Zona o Barrio Paciente" absent → neighborhood undefined in address', () => {
    const task = makeTask('task-j', 'Morales, Diego', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Diego' },
      { name: 'Apellido del Paciente', value: 'Morales' },
      // No Zona o Barrio
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Salta 500, CABA') },
      { name: 'Domicilio Informado Paciente 1', value: 'Salta 500' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses![0].neighborhood).toBeUndefined();
  });

  // ── (k) Zona o Barrio empty string → neighborhood null ────────────────────

  it('(k) "Zona o Barrio Paciente" empty string → neighborhood undefined', () => {
    const task = makeTask('task-k', 'Castro, Lucia', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Lucia' },
      { name: 'Apellido del Paciente', value: 'Castro' },
      { name: 'Zona o Barrio Paciente', value: '   ' }, // whitespace only
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Riobamba 800, CABA') },
      { name: 'Domicilio Informado Paciente 1', value: 'Riobamba 800' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses![0].neighborhood).toBeUndefined();
  });

  // ── (l) state/city/neighborhood only on slot 1 (primary), not slots 2/3 ──

  it('(l) state/city/neighborhood applied only to primary address (slot 1), not slot 2/3', () => {
    const task = makeTask('task-l', 'Núñez, Andrea', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Andrea' },
      { name: 'Apellido del Paciente', value: 'Núñez' },
      {
        name: 'Provincia del Paciente',
        value: locationField('Buenos Aires', [
          { long_name: 'Buenos Aires', short_name: 'BA', types: ['administrative_area_level_1'] },
        ]),
      },
      { name: 'Zona o Barrio Paciente', value: 'San Telmo' },
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Balcarce 100, San Telmo') },
      { name: 'Domicilio Informado Paciente 1', value: 'Balcarce 100' },
      { name: 'Domicilio 2 Principal Paciente', value: locationField('Perú 200, San Telmo') },
      { name: 'Domicilio Informado Paciente 2', value: 'Perú 200' },
      { name: 'Domicilio 3 Principal Paciente', value: null },
      { name: 'Domicilio Informado Paciente 3', value: null },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses).toHaveLength(2);

    // Slot 1: has location metadata
    expect(result!.addresses![0].state).toBe('Buenos Aires');
    expect(result!.addresses![0].neighborhood).toBe('San Telmo');

    // Slot 2: NO location metadata (null passed as undefined)
    expect(result!.addresses![1].state).toBeUndefined();
    expect(result!.addresses![1].city).toBeUndefined();
    expect(result!.addresses![1].neighborhood).toBeUndefined();
  });

  // ── (m) No nombre/apellido, no parseable title → returns null ─────────────

  it('(m) no first/last name and unparseable title → returns null', () => {
    const task = makeTask('task-m', 'Task without name', 'Activo', [
      { name: 'Número de WhatsApp Responsable', value: null },
    ]);

    expect(mapper.map(task)).toBeNull();
  });

  // ── (n) Name parsed from title (fallback) ─────────────────────────────────

  it('(n) name parsed from task title "CASTILLO, ANA - Caso 644"', () => {
    const task = makeTask('task-n', 'CASTILLO, ANA - Caso 644', 'Activo', [
      // No Nombre/Apellido custom fields
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.lastName).toBe('CASTILLO');
    expect(result!.firstName).toBe('ANA');
  });

  // ── (o) Responsibles built correctly ──────────────────────────────────────

  it('(o) single responsible built from custom fields', () => {
    const task = makeTask('task-o', 'Soto, Ignacio', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Ignacio' },
      { name: 'Apellido del Paciente', value: 'Soto' },
      { name: 'Nombre de Responsable', value: 'María' },
      { name: 'Apellido de Responsable', value: 'Soto' },
      { name: 'Número de WhatsApp Responsable', value: '+54 9 11 1234-5678' },
      { name: 'Email del Responsable', value: 'maria@example.com' },
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.responsibles).toHaveLength(1);
    expect(result!.responsibles![0].firstName).toBe('María');
    expect(result!.responsibles![0].lastName).toBe('Soto');
    expect(result!.responsibles![0].email).toBe('maria@example.com');
    expect(result!.responsibles![0].isPrimary).toBe(true);
  });

  // ── (p) No addresses filled → empty addresses array ───────────────────────

  it('(p) no address slots filled → addresses array is empty', () => {
    const task = makeTask('task-p', 'Blanco, Hugo', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Hugo' },
      { name: 'Apellido del Paciente', value: 'Blanco' },
      // No domicilio fields
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.addresses).toHaveLength(0);
  });

  // ── (q) Multiple addresses: only primary gets location metadata ───────────

  it('(q) 3 address slots: state/city/neighborhood only on slot 1', () => {
    const task = makeTask('task-q', 'Agüero, Valeria', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Valeria' },
      { name: 'Apellido del Paciente', value: 'Agüero' },
      {
        name: 'Provincia del Paciente',
        value: locationField('Mendoza, Argentina', [
          { long_name: 'Mendoza', short_name: 'M', types: ['administrative_area_level_1'] },
        ]),
      },
      {
        name: 'Ciudad / Localidad del Paciente',
        value: locationField('Ciudad de Mendoza, Mendoza', [
          { long_name: 'Ciudad de Mendoza', short_name: 'Mendoza', types: ['locality', 'political'] },
        ]),
      },
      { name: 'Zona o Barrio Paciente', value: 'Godoy Cruz' },
      { name: 'Domicilio 1 Principal Paciente', value: locationField('San Martín 100, Mendoza') },
      { name: 'Domicilio Informado Paciente 1', value: 'San Martín 100' },
      { name: 'Domicilio 2 Principal Paciente', value: locationField('España 200, Mendoza') },
      { name: 'Domicilio Informado Paciente 2', value: 'España 200' },
      { name: 'Domicilio 3 Principal Paciente', value: locationField('Las Heras 300, Mendoza') },
      { name: 'Domicilio Informado Paciente 3', value: 'Las Heras 300' },
    ]);

    const result = mapper.map(task);
    expect(result!.addresses).toHaveLength(3);

    expect(result!.addresses![0].state).toBe('Mendoza');
    expect(result!.addresses![0].city).toBe('Ciudad de Mendoza');
    expect(result!.addresses![0].neighborhood).toBe('Godoy Cruz');

    expect(result!.addresses![1].state).toBeUndefined();
    expect(result!.addresses![1].city).toBeUndefined();
    expect(result!.addresses![1].neighborhood).toBeUndefined();

    expect(result!.addresses![2].state).toBeUndefined();
    expect(result!.addresses![2].city).toBeUndefined();
    expect(result!.addresses![2].neighborhood).toBeUndefined();
  });

  // ── (r) healthInsuranceName with whitespace → trimmed ─────────────────────

  it('(r) "Cobertura Informada" with surrounding whitespace → trimmed', () => {
    const task = makeTask('task-r', 'Reyes, Omar', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Omar' },
      { name: 'Apellido del Paciente', value: 'Reyes' },
      { name: 'Cobertura Informada', value: '  IOMA  ' },
    ]);

    const result = mapper.map(task);
    expect(result!.healthInsuranceName).toBe('IOMA');
  });

  // ── (s) healthInsuranceMemberId empty string → null ───────────────────────

  it('(s) "Número ID Afiliado Paciente" empty string → null', () => {
    const task = makeTask('task-s', 'Herrera, Paula', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Paula' },
      { name: 'Apellido del Paciente', value: 'Herrera' },
      { name: 'Número ID Afiliado Paciente', value: '' },
    ]);

    const result = mapper.map(task);
    expect(result!.healthInsuranceMemberId).toBeNull();
  });

  // ── Additional: invalid location value (not an object) ────────────────────

  it('location field is a plain string (not object) → state/city fall back gracefully', () => {
    const task = makeTask('task-loc-str', 'Domínguez, Luis', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Luis' },
      { name: 'Apellido del Paciente', value: 'Domínguez' },
      { name: 'Provincia del Paciente', value: 'Buenos Aires' }, // plain string, not location obj
      { name: 'Ciudad / Localidad del Paciente', value: 'CABA' }, // plain string
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Av. Santa Fe 1234') },
      { name: 'Domicilio Informado Paciente 1', value: 'Santa Fe 1234' },
    ]);

    const result = mapper.map(task);
    // extractStateFromLocation(string) returns null, extractFormattedAddress(string) also null
    expect(result!.addresses![0].state).toBeUndefined();
    expect(result!.addresses![0].city).toBeUndefined();
  });

  // ── Additional: Provincia with address_components but wrong type → fallback ─

  it('Provincia location has address_components but no area_level_1 → falls back to first segment of formatted_address', () => {
    const task = makeTask('task-loc-comp-miss', 'Villalba, Rosa', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Rosa' },
      { name: 'Apellido del Paciente', value: 'Villalba' },
      {
        name: 'Provincia del Paciente',
        value: locationField('Misiones, Argentina', [
          // Only country component — no administrative_area_level_1
          { long_name: 'Argentina', short_name: 'AR', types: ['country', 'political'] },
        ]),
      },
      { name: 'Domicilio 1 Principal Paciente', value: locationField('Posadas 100, Misiones') },
      { name: 'Domicilio Informado Paciente 1', value: 'Posadas 100' },
    ]);

    const result = mapper.map(task);
    // extractStateFromLocation returns null (no area_level_1), fallback takes first comma segment
    expect(result!.addresses![0].state).toBe('Misiones');
  });

  // ── Additional: hasCud, hasConsent, hasJudicialProtection mapped ──────────

  it('boolean fields (CUD, Consentimiento, Amparo) mapped correctly', () => {
    const task = makeTask('task-bool', 'Álvarez, Marta', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Marta' },
      { name: 'Apellido del Paciente', value: 'Álvarez' },
      { name: 'Posee CUD', value: true },
      { name: 'Consentimiento', value: true },
      { name: 'Amparo Judicial', value: false },
    ]);

    const result = mapper.map(task);
    expect(result!.hasCud).toBe(true);
    expect(result!.hasConsent).toBe(true);
    expect(result!.hasJudicialProtection).toBe(false);
  });

  // ── Additional: country always 'AR' ──────────────────────────────────────

  it('country is always AR', () => {
    const task = makeTask('task-country', 'Silva, Jorge', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Jorge' },
      { name: 'Apellido del Paciente', value: 'Silva' },
    ]);

    const result = mapper.map(task);
    expect(result!.country).toBe('AR');
  });

  // ── status mapping from ClickUp task.status ───────────────────────────────

  it('(v1) ClickUp status "busqueda" → patient status ACTIVE', () => {
    const task = makeTask('task-v1', 'Pérez, Ana', 'busqueda', [
      { name: 'Nombre de Paciente', value: 'Ana' },
      { name: 'Apellido del Paciente', value: 'Pérez' },
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ACTIVE');
  });

  it('(v2) ClickUp status "admisión" → patient status ADMISSION', () => {
    const task = makeTask('task-v2', 'García, Luis', 'admisión', [
      { name: 'Nombre de Paciente', value: 'Luis' },
      { name: 'Apellido del Paciente', value: 'García' },
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ADMISSION');
  });

  it('(v3) ClickUp status "baja" → patient status DISCONTINUED', () => {
    const task = makeTask('task-v3', 'Torres, María', 'baja', [
      { name: 'Nombre de Paciente', value: 'María' },
      { name: 'Apellido del Paciente', value: 'Torres' },
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('DISCONTINUED');
  });

  it('(v4) unknown ClickUp status → patient status null (no crash)', () => {
    // Simulate a new status ops added to ClickUp that is not yet mapped.
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => { /* suppress */ });

    const task = makeTask('task-v4', 'Romero, Pablo', 'nuevo_estado_desconocido', [
      { name: 'Nombre de Paciente', value: 'Pablo' },
      { name: 'Apellido del Paciente', value: 'Romero' },
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.status).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[ClickUpPatientMapper] Unknown ClickUp status:',
      expect.objectContaining({ statusRaw: 'nuevo_estado_desconocido', taskId: 'task-v4' }),
    );

    consoleSpy.mockRestore();
  });

  it('(v5) task.status is undefined → patient status null (no crash)', () => {
    // Edge case: malformed task with no status object.
    const taskWithNoStatus: import('../../../src/modules/integration/infrastructure/clickup/ClickUpTask').ClickUpTask = {
      id:           'task-v5',
      name:         'Fernández, Rosa',
      status:       undefined as unknown as { status: string; color: string; type: string },
      parent:       null,
      custom_fields: [
        { id: 'cf-nom', name: 'Nombre de Paciente',    type: 'text', value: 'Rosa' },
        { id: 'cf-ape', name: 'Apellido del Paciente', type: 'text', value: 'Fernández' },
      ],
      url:          'https://app.clickup.com/t/task-v5',
      date_created: '1700000000000',
      date_updated: '1700100000000',
    };

    const result = mapper.map(taskWithNoStatus);
    expect(result).not.toBeNull();
    expect(result!.status).toBeNull();
  });

  // ── caseNumber via map() ──────────────────────────────────────────────────

  it('(t) "Caso Número" present with string value → caseNumber parsed as number', () => {
    const task = makeTask('task-t', 'Díaz, Carmen', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Carmen' },
      { name: 'Apellido del Paciente', value: 'Díaz' },
      { name: 'Caso Número', value: '766' },
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.caseNumber).toBe(766);
  });

  it('(u) "Caso Número" absent → caseNumber is null', () => {
    const task = makeTask('task-u', 'Ramos, Felipe', 'Activo', [
      { name: 'Nombre de Paciente', value: 'Felipe' },
      { name: 'Apellido del Paciente', value: 'Ramos' },
      // No "Caso Número" field
    ]);

    const result = mapper.map(task);
    expect(result).not.toBeNull();
    expect(result!.caseNumber).toBeNull();
  });
});

// ── extractCaseNumber unit tests ──────────────────────────────────────────────

describe('extractCaseNumber', () => {
  function taskWithCf(value: unknown): ClickUpTask {
    return makeTask('task-cn', 'Test', 'Activo', [
      { name: 'Caso Número', value },
    ]);
  }

  it('parses a plain numeric string to integer', () => {
    expect(extractCaseNumber(taskWithCf('766'))).toBe(766);
  });

  it('parses a numeric string with leading zeros', () => {
    expect(extractCaseNumber(taskWithCf('007'))).toBe(7);
  });

  it('returns null when field is absent', () => {
    const task = makeTask('task-cn-absent', 'Test', 'Activo', []);
    expect(extractCaseNumber(task)).toBeNull();
  });

  it('returns null when value is null', () => {
    expect(extractCaseNumber(taskWithCf(null))).toBeNull();
  });

  it('returns null when value is empty string', () => {
    expect(extractCaseNumber(taskWithCf(''))).toBeNull();
  });

  it('returns null when value contains no digits', () => {
    expect(extractCaseNumber(taskWithCf('abc'))).toBeNull();
  });

  it('extracts first digit sequence from mixed string (e.g. "12abc")', () => {
    expect(extractCaseNumber(taskWithCf('12abc'))).toBe(12); // regex picks first digit run
  });

  it('extracts digits from "Caso 766" (realistic ops format)', () => {
    expect(extractCaseNumber(taskWithCf('Caso 766'))).toBe(766);
  });

  it('extracts first digit sequence from "abc12def"', () => {
    expect(extractCaseNumber(taskWithCf('abc12def'))).toBe(12);
  });
});
