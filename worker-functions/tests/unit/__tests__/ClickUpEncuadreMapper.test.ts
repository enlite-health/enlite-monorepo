/**
 * ClickUpEncuadreMapper — Unit Tests (Fase 2)
 *
 * Coverage:
 *   (a) parseCaseNumbersFromName — all validated patterns
 *   (b) map() returns array (Fase 2 API)
 *   (c) 1 case → 1 entry with encuadre populated
 *   (d) 2 cases → 2 entries, same worker, different cases
 *   (e) 0 cases → 1 entry with encuadre=null
 *   (f) status mapping for Encuadres list statuses
 *   (g) dedupHash = MD5('clickup|{taskId}|{caseNumber}') (includes caseNumber)
 *   (h) gender mapping (inherited from Admisiones mapper)
 *   (i) profession mapping
 *   (j) task with no email/whatsapp → null
 */

import * as crypto from 'crypto';
import {
  ClickUpEncuadreMapper,
  parseCaseNumbersFromName,
} from '../../../src/modules/integration/infrastructure/clickup/ClickUpEncuadreMapper';

// ── Mock ClickUpFieldResolver ─────────────────────────────────────────────────

type DropdownStub = Record<string, Record<number, string>>;

function makeResolver(dropdowns: DropdownStub) {
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
  };
}

// ── Task builder ──────────────────────────────────────────────────────────────

interface CfEntry { name: string; value: unknown; }

function makeTask(id: string, name: string, status: string, fields: CfEntry[]) {
  return {
    id,
    name,
    status: { status, color: '#000', type: 'custom' },
    parent: null,
    custom_fields: fields.map(f => ({ id: `cf-${f.name}`, name: f.name, type: 'text', value: f.value })),
    url: `https://app.clickup.com/t/${id}`,
    date_created: '1700000000000',
    date_updated: '1700000000000',
  };
}

// Convenience overload when name = 'Task {id}'
function makeSimpleTask(id: string, status: string, fields: CfEntry[]) {
  return makeTask(id, `Task ${id}`, status, fields);
}

// ── Shared resolver ───────────────────────────────────────────────────────────

const resolver = makeResolver({
  'Sexo Prestador': {
    0: 'Hombre',
    1: 'Mujer',
    2: 'Trans',
    3: 'Prefiero no decir',
  },
  'Tipo de Profesional': {
    0: 'Acompañante Terapéutico',
    1: 'Cuidado Humano',
    2: 'Enfermería',
    3: 'Estudiante de Psicología',
    4: 'Otra',
  },
});

// =============================================================================
// parseCaseNumbersFromName — standalone function tests
// =============================================================================

describe('parseCaseNumbersFromName', () => {
  // ── Happy paths ──────────────────────────────────────────────────────────────

  it('"690 - Maria -" → [690]', () => {
    expect(parseCaseNumbersFromName('690 - Maria -')).toEqual([690]);
  });

  it('"Caso 690 - Maria -" → [690]', () => {
    expect(parseCaseNumbersFromName('Caso 690 - Maria -')).toEqual([690]);
  });

  it('"Cod: 440-663-613 - Maria -" → [440, 663, 613]', () => {
    expect(parseCaseNumbersFromName('Cod: 440-663-613 - Maria -')).toEqual([440, 663, 613]);
  });

  it('"613-440 - Ariel -" → [613, 440]', () => {
    expect(parseCaseNumbersFromName('613-440 - Ariel -')).toEqual([613, 440]);
  });

  it('"🔹 COD 434 - Nome" → [434]', () => {
    expect(parseCaseNumbersFromName('🔹 COD 434 - Nome')).toEqual([434]);
  });

  it('"CD690 - Nome" → [690] (no space after CD)', () => {
    expect(parseCaseNumbersFromName('CD690 - Nome')).toEqual([690]);
  });

  it('"   305 - Nome" (leading spaces) → [305]', () => {
    expect(parseCaseNumbersFromName('   305 - Nome')).toEqual([305]);
  });

  it('"Código 603 - Nome" → [603]', () => {
    expect(parseCaseNumbersFromName('Código 603 - Nome')).toEqual([603]);
  });

  it('"Cod. 690 - Nome" → [690]', () => {
    expect(parseCaseNumbersFromName('Cod. 690 - Nome')).toEqual([690]);
  });

  it('"Cod 690 - Nome" → [690]', () => {
    expect(parseCaseNumbersFromName('Cod 690 - Nome')).toEqual([690]);
  });

  // ── Dedup ────────────────────────────────────────────────────────────────────

  it('"690-690 - João -" → [690] (dedup: same number twice)', () => {
    expect(parseCaseNumbersFromName('690-690 - João -')).toEqual([690]);
  });

  // ── No case ──────────────────────────────────────────────────────────────────

  it('"Cuidadora - Pamela -" → [] (no leading number)', () => {
    expect(parseCaseNumbersFromName('Cuidadora - Pamela -')).toEqual([]);
  });

  it('"Form Submission - #2026-02-05T10:01:09 - Gladys -" → [] (timestamp not a case)', () => {
    expect(parseCaseNumbersFromName('Form Submission - #2026-02-05T10:01:09 - Gladys -')).toEqual([]);
  });

  it('empty string → []', () => {
    expect(parseCaseNumbersFromName('')).toEqual([]);
  });

  // ── Address numbers not captured ─────────────────────────────────────────────

  it('"90 - Ferreyra - C/ de l\'Almirall Cadarso, 11-1, L\'Eixample" → [90] (not 11)', () => {
    expect(parseCaseNumbersFromName("90 - Ferreyra - C/ de l'Almirall Cadarso, 11-1, L'Eixample")).toEqual([90]);
  });
});

// =============================================================================
// ClickUpEncuadreMapper — map() tests (Fase 2 API returns array)
// =============================================================================

describe('ClickUpEncuadreMapper', () => {
  let mapper: ClickUpEncuadreMapper;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapper = new ClickUpEncuadreMapper(resolver as any);
  });

  // ── Return type ──────────────────────────────────────────────────────────────

  it('returns null when task has neither email nor whatsapp', () => {
    const task = makeTask('t-null', 'Caso 100 - Anónimo', 'pendiente de entrevista', []);
    expect(mapper.map(task as any)).toBeNull();
  });

  // ── 0 cases → 1 entry with encuadre=null ─────────────────────────────────────

  it('0 cases in name → 1 entry with encuadre=null (worker still imported)', () => {
    const task = makeTask('t-nocase', 'Cuidadora - Pamela López', 'pendiente de entrevista', [
      { name: 'Email Prestador', value: 'pamela@test.com' },
    ]);
    const entries = mapper.map(task as any);
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries![0].encuadre).toBeNull();
    expect(entries![0].worker.email).toBe('pamela@test.com');
  });

  // ── 1 case → 1 entry with encuadre populated ─────────────────────────────────

  it('1 case → 1 entry with encuadre populated', () => {
    const task = makeTask('t-one', '690 - García Juan', 'seleccionado', [
      { name: 'Email Prestador',            value: 'juan@test.com' },
      { name: 'Whatsapp Prestador',         value: '1151234567' },
      { name: 'Apellido y Nombre Prestador', value: 'García, Juan' },
      { name: 'Sexo Prestador',             value: 1 },  // Mujer → FEMALE
      { name: 'Tipo de Profesional',        value: 0 },  // AT
    ]);
    const entries = mapper.map(task as any);
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(1);

    const { worker, encuadre } = entries![0];
    expect(encuadre).not.toBeNull();
    expect(encuadre!.caseNumber).toBe(690);
    expect(encuadre!.resultado).toBe('SELECCIONADO');
    expect(encuadre!.importSourceAudit).toBe('ClickUp');
    expect(worker.email).toBe('juan@test.com');
    expect(worker.firstName).toBe('Juan');
    expect(worker.lastName).toBe('García');
    expect(worker.gender).toBe('FEMALE');
    expect(worker.profession).toBe('AT');
  });

  // ── 2 cases → 2 entries, same worker ─────────────────────────────────────────

  it('2 cases → 2 entries, same worker, distinct case numbers', () => {
    const task = makeTask('t-two', '613-440 - Ariel Fernández', 'rechazado', [
      { name: 'Email Prestador', value: 'ariel@test.com' },
    ]);
    const entries = mapper.map(task as any);
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(2);

    expect(entries![0].encuadre!.caseNumber).toBe(613);
    expect(entries![1].encuadre!.caseNumber).toBe(440);

    // Same worker data
    expect(entries![0].worker.email).toBe('ariel@test.com');
    expect(entries![1].worker.email).toBe('ariel@test.com');

    // Different results (same status → same resultado, different caseNumber)
    expect(entries![0].encuadre!.resultado).toBe('RECHAZADO');
    expect(entries![1].encuadre!.resultado).toBe('RECHAZADO');
  });

  // ── Multi-case: 3 case numbers ────────────────────────────────────────────────

  it('3 cases → 3 entries with distinct caseNumbers', () => {
    const task = makeTask('t-three', 'Cod: 440-663-613 - Maria López', 'pendiente de entrevista', [
      { name: 'Email Prestador', value: 'maria@test.com' },
    ]);
    const entries = mapper.map(task as any);
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(3);
    expect(entries!.map(e => e.encuadre!.caseNumber)).toEqual([440, 663, 613]);
  });

  // ── dedupHash includes caseNumber ─────────────────────────────────────────────

  it('dedupHash = MD5("clickup|{taskId}|{caseNumber}")', () => {
    const task = makeTask('t-hash', '999 - Test Worker', 'seleccionado', [
      { name: 'Email Prestador', value: 'hash@test.com' },
    ]);
    const entries = mapper.map(task as any);
    expect(entries).not.toBeNull();
    const expected = crypto.createHash('md5').update('clickup|t-hash|999').digest('hex');
    expect(entries![0].encuadre!.dedupHash).toBe(expected);
  });

  it('2 cases → dedupHashes are distinct', () => {
    const task = makeTask('t-hash2', '613-440 - Ariel', 'pendiente de entrevista', [
      { name: 'Email Prestador', value: 'ariel@test.com' },
    ]);
    const entries = mapper.map(task as any);
    expect(entries).not.toBeNull();
    const hash613 = crypto.createHash('md5').update('clickup|t-hash2|613').digest('hex');
    const hash440 = crypto.createHash('md5').update('clickup|t-hash2|440').digest('hex');
    expect(entries![0].encuadre!.dedupHash).toBe(hash613);
    expect(entries![1].encuadre!.dedupHash).toBe(hash440);
    expect(hash613).not.toBe(hash440);
  });

  // ── Status mapping (Encuadres list) ──────────────────────────────────────────

  it('status "pendiente de entrevista" → resultado PENDIENTE', () => {
    const task = makeTask('t-s1', '100 - Test', 'pendiente de entrevista', [
      { name: 'Email Prestador', value: 'a@b.com' },
    ]);
    expect(mapper.map(task as any)![0].encuadre!.resultado).toBe('PENDIENTE');
  });

  it('status "seleccionado" → resultado SELECCIONADO', () => {
    const task = makeTask('t-s2', '100 - Test', 'seleccionado', [
      { name: 'Email Prestador', value: 'a@b.com' },
    ]);
    expect(mapper.map(task as any)![0].encuadre!.resultado).toBe('SELECCIONADO');
  });

  it('status "rechazado" → resultado RECHAZADO', () => {
    const task = makeTask('t-s3', '100 - Test', 'rechazado', [
      { name: 'Email Prestador', value: 'a@b.com' },
    ]);
    expect(mapper.map(task as any)![0].encuadre!.resultado).toBe('RECHAZADO');
  });

  it('status "at no acepta" → resultado AT_NO_ACEPTA', () => {
    const task = makeTask('t-s4', '100 - Test', 'at no acepta', [
      { name: 'Email Prestador', value: 'a@b.com' },
    ]);
    expect(mapper.map(task as any)![0].encuadre!.resultado).toBe('AT_NO_ACEPTA');
  });

  it('status "reprogramar" → resultado REPROGRAMAR', () => {
    const task = makeTask('t-s5', '100 - Test', 'reprogramar', [
      { name: 'Email Prestador', value: 'a@b.com' },
    ]);
    expect(mapper.map(task as any)![0].encuadre!.resultado).toBe('REPROGRAMAR');
  });

  it('status "esperando respuesta" → resultado PENDIENTE', () => {
    const task = makeTask('t-s6', '100 - Test', 'esperando respuesta', [
      { name: 'Email Prestador', value: 'a@b.com' },
    ]);
    expect(mapper.map(task as any)![0].encuadre!.resultado).toBe('PENDIENTE');
  });

  it('status "reemplazo / guardias" → resultado PENDIENTE', () => {
    const task = makeTask('t-s7', '100 - Test', 'reemplazo / guardias', [
      { name: 'Email Prestador', value: 'a@b.com' },
    ]);
    expect(mapper.map(task as any)![0].encuadre!.resultado).toBe('PENDIENTE');
  });

  it('unknown status → defaults to PENDIENTE', () => {
    const task = makeTask('t-s8', '100 - Test', 'algo desconocido', [
      { name: 'Email Prestador', value: 'a@b.com' },
    ]);
    expect(mapper.map(task as any)![0].encuadre!.resultado).toBe('PENDIENTE');
  });

  // ── Gender mapping ────────────────────────────────────────────────────────────

  it('maps "Hombre" to MALE', () => {
    const task = makeSimpleTask('g1', 'solicitudes', [
      { name: 'Email Prestador', value: 'a@b.com' },
      { name: 'Sexo Prestador',  value: 0 },
    ]);
    expect(mapper.map(task as any)![0].worker.gender).toBe('MALE');
  });

  it('maps "Mujer" to FEMALE', () => {
    const task = makeSimpleTask('g2', 'solicitudes', [
      { name: 'Email Prestador', value: 'a@b.com' },
      { name: 'Sexo Prestador',  value: 1 },
    ]);
    expect(mapper.map(task as any)![0].worker.gender).toBe('FEMALE');
  });

  it('maps "Trans" to TRANS', () => {
    const task = makeSimpleTask('g3', 'solicitudes', [
      { name: 'Email Prestador', value: 'a@b.com' },
      { name: 'Sexo Prestador',  value: 2 },
    ]);
    expect(mapper.map(task as any)![0].worker.gender).toBe('TRANS');
  });

  it('maps "Prefiero no decir" to UNDISCLOSED', () => {
    const task = makeSimpleTask('g4', 'solicitudes', [
      { name: 'Email Prestador', value: 'a@b.com' },
      { name: 'Sexo Prestador',  value: 3 },
    ]);
    expect(mapper.map(task as any)![0].worker.gender).toBe('UNDISCLOSED');
  });

  // ── No "sex" property on worker ───────────────────────────────────────────────

  it('worker output has no "sex" property', () => {
    const task = makeSimpleTask('nosex', 'solicitudes', [
      { name: 'Email Prestador', value: 'a@b.com' },
    ]);
    const result = mapper.map(task as any);
    expect(result).not.toBeNull();
    expect('sex' in result![0].worker).toBe(false);
  });

  // ── Profession mapping ────────────────────────────────────────────────────────

  it('maps "Acompañante Terapéutico" to AT', () => {
    const task = makeSimpleTask('p1', 'solicitudes', [
      { name: 'Email Prestador',     value: 'a@b.com' },
      { name: 'Tipo de Profesional', value: 0 },
    ]);
    expect(mapper.map(task as any)![0].worker.profession).toBe('AT');
  });

  it('maps "Otra" to null', () => {
    const task = makeSimpleTask('p2', 'solicitudes', [
      { name: 'Email Prestador',     value: 'a@b.com' },
      { name: 'Tipo de Profesional', value: 4 },
    ]);
    expect(mapper.map(task as any)![0].worker.profession).toBeNull();
  });

  it('maps "Estudiante de Psicología" to null', () => {
    const task = makeSimpleTask('p3', 'solicitudes', [
      { name: 'Email Prestador',     value: 'a@b.com' },
      { name: 'Tipo de Profesional', value: 3 },
    ]);
    expect(mapper.map(task as any)![0].worker.profession).toBeNull();
  });

  // ── Edge: whatsapp only (no email) ────────────────────────────────────────────

  it('task with whatsapp but no email is still valid', () => {
    const task = makeTask('t-wa', '200 - Test', 'pendiente de entrevista', [
      { name: 'Whatsapp Prestador', value: '5491151234567' },
    ]);
    const entries = mapper.map(task as any);
    expect(entries).not.toBeNull();
    expect(entries![0].worker.email).toBeNull();
    expect(entries![0].worker.rawWhatsapp).toBe('5491151234567');
  });

  // ── name parsing ──────────────────────────────────────────────────────────────

  it('parses "Apellido, Nombre" format correctly', () => {
    const task = makeTask('t-name', '500 - Test', 'pendiente de entrevista', [
      { name: 'Email Prestador',             value: 'a@b.com' },
      { name: 'Apellido y Nombre Prestador', value: 'López, Ana' },
    ]);
    const w = mapper.map(task as any)![0].worker;
    expect(w.lastName).toBe('López');
    expect(w.firstName).toBe('Ana');
  });

  it('parses single name (no comma) as firstName only', () => {
    const task = makeTask('t-name2', '501 - Test', 'pendiente de entrevista', [
      { name: 'Email Prestador',             value: 'a@b.com' },
      { name: 'Apellido y Nombre Prestador', value: 'AnaLópez' },
    ]);
    const w = mapper.map(task as any)![0].worker;
    expect(w.firstName).toBe('AnaLópez');
    expect(w.lastName).toBeNull();
  });
});
