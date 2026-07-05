/**
 * anaCareMapper.test.ts — unit tests para o mapeador WorkerMirrorRecord → AnaCare.
 *
 * Cobre:
 *   - INVERSÃO de gênero: FEMALE → "M", MALE → "H"
 *   - Data → YYYY-MM-DD
 *   - Endereço vem do service area
 *   - Omissão de campos vazios/null (não envia string vazia)
 *   - cedula_ciudadania = documentNumber
 *   - Erros em campos obrigatórios ausentes
 */

import {
  mapWorkerToAnaCarePayload,
  mapSexToAnaCareGenero,
  formatDateYMD,
} from '../anaCareMapper';
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';
import type { WorkerMirrorRecord } from '../../../domain/WorkerMirrorRecord';

// ─── Fixture base ─────────────────────────────────────────────────

function makeRecord(overrides: Partial<WorkerMirrorRecord> = {}): WorkerMirrorRecord {
  return {
    workerId: 'worker-uuid-1',
    firstName: 'María',
    lastName: 'González',
    sex: 'FEMALE',
    email: 'maria@example.com',
    phone: '+5491123456789',
    birthDate: '1990-05-15',
    documentNumber: 'GOPM900515MDFNRR02',
    address: {
      line: 'Av. Insurgentes 100',
      city: 'Ciudad de México',
      state: 'CDMX',
      neighborhood: 'Roma Norte',
      postalCode: '06700',
    },
    profession: 'AT',
    occupation: null,
    employmentType: null,
    ...overrides,
  };
}

// ─── mapSexToAnaCareGenero ────────────────────────────────────────

describe('mapSexToAnaCareGenero', () => {
  it('FEMALE → "M" (inversão AnaCare)', () => {
    expect(mapSexToAnaCareGenero('FEMALE')).toBe('M');
  });

  it('MALE → "H" (inversão AnaCare)', () => {
    expect(mapSexToAnaCareGenero('MALE')).toBe('H');
  });

  it('null → null', () => {
    expect(mapSexToAnaCareGenero(null)).toBeNull();
  });

  it('undefined → null', () => {
    expect(mapSexToAnaCareGenero(undefined)).toBeNull();
  });

  // Variantes raw passam pelo normalizeSexValue antes de chegar aqui —
  // testamos a cadeia completa: normalizeSexValue → mapSexToAnaCareGenero
  it('"female" (lowercase) → normalizeSexValue → "M"', () => {
    expect(mapSexToAnaCareGenero(normalizeSexValue('female'))).toBe('M');
  });

  it('"MUJER" (español) → normalizeSexValue → "M"', () => {
    expect(mapSexToAnaCareGenero(normalizeSexValue('MUJER'))).toBe('M');
  });

  it('"hombre" (español) → normalizeSexValue → "H"', () => {
    expect(mapSexToAnaCareGenero(normalizeSexValue('hombre'))).toBe('H');
  });

  it('"Trans" → normalizeSexValue → null → null', () => {
    expect(mapSexToAnaCareGenero(normalizeSexValue('Trans'))).toBeNull();
  });
});

// ─── formatDateYMD ────────────────────────────────────────────────

describe('formatDateYMD', () => {
  it('converte string ISO para YYYY-MM-DD', () => {
    expect(formatDateYMD('1990-05-15T00:00:00Z')).toBe('1990-05-15');
  });

  it('mantém string YYYY-MM-DD', () => {
    expect(formatDateYMD('1990-05-15')).toBe('1990-05-15');
  });

  it('converte Date para YYYY-MM-DD', () => {
    expect(formatDateYMD(new Date('2000-01-01'))).toBe('2000-01-01');
  });

  it('null → undefined', () => {
    expect(formatDateYMD(null)).toBeUndefined();
  });

  it('undefined → undefined', () => {
    expect(formatDateYMD(undefined)).toBeUndefined();
  });

  it('string inválida → undefined', () => {
    expect(formatDateYMD('not-a-date')).toBeUndefined();
  });
});

// ─── mapWorkerToAnaCarePayload ────────────────────────────────────

describe('mapWorkerToAnaCarePayload', () => {
  describe('campos obrigatórios', () => {
    it('inclui nombre, apellidos, genero e email', () => {
      const payload = mapWorkerToAnaCarePayload(makeRecord());
      expect(payload.nombre).toBe('María');
      expect(payload.apellidos).toBe('González');
      expect(payload.genero).toBe('M'); // FEMALE → "M"
      expect(payload.email).toBe('maria@example.com');
    });

    it('normaliza email para lowercase', () => {
      const payload = mapWorkerToAnaCarePayload(makeRecord({ email: 'MARIA@EXAMPLE.COM' }));
      expect(payload.email).toBe('maria@example.com');
    });

    it('throws quando firstName ausente', () => {
      expect(() =>
        mapWorkerToAnaCarePayload(makeRecord({ firstName: null })),
      ).toThrow('firstName is required');
    });

    it('throws quando lastName ausente', () => {
      expect(() =>
        mapWorkerToAnaCarePayload(makeRecord({ lastName: null })),
      ).toThrow('lastName is required');
    });

    it('throws quando sex null', () => {
      expect(() =>
        mapWorkerToAnaCarePayload(makeRecord({ sex: null })),
      ).toThrow('sex is required');
    });

    it('throws quando firstName string vazia', () => {
      expect(() =>
        mapWorkerToAnaCarePayload(makeRecord({ firstName: '   ' })),
      ).toThrow('firstName is required');
    });
  });

  describe('inversão de gênero', () => {
    it('FEMALE → genero "M"', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({ sex: 'FEMALE' }));
      expect(p.genero).toBe('M');
    });

    it('MALE → genero "H"', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({ sex: 'MALE', firstName: 'Carlos', lastName: 'López' }));
      expect(p.genero).toBe('H');
    });
  });

  describe('data de nascimento', () => {
    it('converte birthDate para YYYY-MM-DD', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({ birthDate: '1990-05-15' }));
      expect(p.fecha_nacimiento).toBe('1990-05-15');
    });

    it('omite fecha_nacimiento quando null', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({ birthDate: null }));
      expect(p.fecha_nacimiento).toBeUndefined();
    });
  });

  describe('cedula_ciudadania = documentNumber', () => {
    it('mapeia documentNumber para cedula_ciudadania', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({ documentNumber: 'GOPM900515MDFNRR02' }));
      expect(p.cedula_ciudadania).toBe('GOPM900515MDFNRR02');
    });

    it('omite cedula_ciudadania quando documentNumber null', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({ documentNumber: null }));
      expect(p.cedula_ciudadania).toBeUndefined();
    });
  });

  describe('endereço do service area', () => {
    it('inclui todos os campos de endereço quando presentes', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord());
      expect(p.calle).toBe('Av. Insurgentes 100');
      expect(p.ciudad).toBe('Ciudad de México');
      expect(p.estado).toBe('CDMX');
      expect(p.colonia).toBe('Roma Norte');
      expect(p.codigo_postal).toBe('06700');
    });

    it('omite calle quando address.line null', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({
        address: { line: null, city: 'CDMX', state: null, neighborhood: null, postalCode: null },
      }));
      expect(p.calle).toBeUndefined();
      expect(p.ciudad).toBe('CDMX');
    });

    it('omite todos os campos de endereço quando todos null', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({
        address: { line: null, city: null, state: null, neighborhood: null, postalCode: null },
      }));
      expect(p.calle).toBeUndefined();
      expect(p.ciudad).toBeUndefined();
      expect(p.estado).toBeUndefined();
      expect(p.colonia).toBeUndefined();
      expect(p.codigo_postal).toBeUndefined();
    });
  });

  describe('omissão de campos vazios', () => {
    it('omite telefono quando phone null', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({ phone: null }));
      expect(p.telefono).toBeUndefined();
    });

    it('inclui telefono quando phone presente', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({ phone: '+5491123456789' }));
      expect(p.telefono).toBe('+5491123456789');
    });

    it('omite telefono quando phone string vazia', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({ phone: '   ' }));
      expect(p.telefono).toBeUndefined();
    });
  });

  describe('truncamento de campos de texto livre (AnaCare v2: max 100 chars)', () => {
    it('trunca calle (address.line) com 150 chars para 100', () => {
      const longLine = 'A'.repeat(150);
      const p = mapWorkerToAnaCarePayload(makeRecord({
        address: { line: longLine, city: 'CDMX', state: 'CDMX', neighborhood: 'Roma', postalCode: '06700' },
      }));
      expect(p.calle).toHaveLength(100);
      expect(p.calle).toBe('A'.repeat(100));
    });

    it('não trunca calle com exatamente 100 chars', () => {
      const exact100 = 'B'.repeat(100);
      const p = mapWorkerToAnaCarePayload(makeRecord({
        address: { line: exact100, city: 'CDMX', state: 'CDMX', neighborhood: 'Roma', postalCode: '06700' },
      }));
      expect(p.calle).toHaveLength(100);
      expect(p.calle).toBe(exact100);
    });

    it('mantém calle curta intacta', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({
        address: { line: 'Av. Insurgentes 100', city: 'CDMX', state: 'CDMX', neighborhood: 'Roma', postalCode: '06700' },
      }));
      expect(p.calle).toBe('Av. Insurgentes 100');
    });

    it('trunca colonia, ciudad e estado quando > 100 chars', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({
        address: {
          line: 'Rua Curta 1',
          city: 'C'.repeat(120),
          state: 'E'.repeat(110),
          neighborhood: 'N'.repeat(130),
          postalCode: '06700',
        },
      }));
      expect(p.ciudad).toHaveLength(100);
      expect(p.estado).toHaveLength(100);
      expect(p.colonia).toHaveLength(100);
    });

    it('trunca nombre e apellidos longos', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord({
        firstName: 'F'.repeat(150),
        lastName: 'L'.repeat(150),
      }));
      expect(p.nombre).toHaveLength(100);
      expect(p.apellidos).toHaveLength(100);
    });
  });

  describe('overrides de tipo', () => {
    it('inclui tipo_enfermera quando fornecido', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord(), { tipo_enfermera: 42 });
      expect(p.tipo_enfermera).toBe(42);
    });

    it('inclui tipo_contratacion quando fornecido', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord(), { tipo_contratacion: 'Independiente' });
      expect(p.tipo_contratacion).toBe('Independiente');
    });

    it('omite tipos quando overrides não fornecidos', () => {
      const p = mapWorkerToAnaCarePayload(makeRecord());
      expect(p.tipo_enfermera).toBeUndefined();
      expect(p.tipo_contratacion).toBeUndefined();
    });
  });
});
