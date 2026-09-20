/**
 * AnaCareApiSourceReader + fieldsToCanonical — T012 (API, não arquivo — Gabriel 27/08).
 * Cobre: API indisponível → FAILED declarado; mapa vazio → FAILED declarado;
 * tradução por source_field_map; campo ausente → UNREADABLE ≠ vazio (D167);
 * datas em formatos variados → ISO; campos desconhecidos contados sem valores;
 * expected = count da API; externalId = id do Ana Care. Fixture sintética.
 */
import { AnaCareApiSourceReader } from '../AnaCareApiSourceReader';
import { fieldsToCanonical, toIsoDate } from '../fieldsToCanonical';
import { AnaCarePatientApiUnavailable, type AnaCarePatientApi } from '../../domain/AnaCarePatientApi';
import type { FieldMapEntry } from '../FieldMapRepository';

const MAP: FieldMapEntry[] = [
  { source: 'ANACARE', sourceField: 'nombre', canonicalField: 'firstName', equivalence: 'TEXT_NORM', enumMap: null, active: true },
  { source: 'ANACARE', sourceField: 'apellidos', canonicalField: 'lastName', equivalence: 'TEXT_NORM', enumMap: null, active: true },
  { source: 'ANACARE', sourceField: 'fecha_nacimiento', canonicalField: 'birthDate', equivalence: 'DATE_ISO', enumMap: null, active: true },
  { source: 'ANACARE', sourceField: 'documento', canonicalField: 'documentNumber', equivalence: 'EXACT', enumMap: null, active: true },
  { source: 'ANACARE', sourceField: 'diagnostico', canonicalField: 'diagnosis', equivalence: 'TEXT_NORM', enumMap: null, active: true },
  { source: 'ANACARE', sourceField: 'telefono_responsable', canonicalField: 'EXCLUDED_C2', equivalence: 'EXACT', enumMap: null, active: false },
];

const api = (records: Array<{ externalId: string; fields: Record<string, unknown> }>, expectedCount: number | null = records.length): AnaCarePatientApi =>
  ({ fetchAllPatients: async () => ({ records, expectedCount }) });

describe('toIsoDate', () => {
  it('aceita ISO (com hora), DD/MM/YYYY e DD-MM-YYYY; rejeita o resto', () => {
    expect(toIsoDate('2015-03-04')).toBe('2015-03-04');
    expect(toIsoDate('2015-03-04T00:00:00Z')).toBe('2015-03-04');
    expect(toIsoDate('04/07/2008')).toBe('2008-07-04');
    expect(toIsoDate('julho de 2008')).toBeNull();
  });
});

describe('fieldsToCanonical', () => {
  it('campo ausente → UNREADABLE; vazio → null; inativo (C2) não entra; desconhecido contado sem valor', () => {
    const r = fieldsToCanonical({ nombre: 'Ana', apellidos: '', telefono_responsable: '+549', extra_campo: 'x' }, MAP, 'AR');
    expect(r.canonical.firstName).toBe('Ana');
    expect(r.canonical.lastName).toBeNull();
    expect(r.canonical.birthDate).toEqual({ $unreadable: true });
    expect(JSON.stringify(r.canonical)).not.toContain('+549');
    expect(r.unmappedFields).toEqual(['extra_campo', 'telefono_responsable']);
  });
});

describe('AnaCareApiSourceReader', () => {
  it('API ainda não existe → FAILED declarado "anacare_patient_api_unavailable", nada lido', async () => {
    const r = await new AnaCareApiSourceReader(new AnaCarePatientApiUnavailable(), MAP, 'AR').read();
    expect(r.fatalError).toBe('anacare_patient_api_unavailable');
    expect(r.readCount).toBe(0);
    expect(r.records).toEqual([]);
  });

  it('mapa vazio → FAILED declarado, mesmo com a API respondendo', async () => {
    const r = await new AnaCareApiSourceReader(api([{ externalId: '1', fields: { nombre: 'Ana' } }]), [], 'AR').read();
    expect(r.fatalError).toMatch(/^unmapped_source/);
    expect(r.expectedCount).toBe(1);
    expect(r.readCount).toBe(0);
  });

  it('lê 3 registros: expected = count da API, externalId = id do Ana Care, datas em ISO, sem contato de terceiro', async () => {
    const r = await new AnaCareApiSourceReader(api([
      { externalId: 'ac-1', fields: { nombre: 'Ana Maria', apellidos: 'Perez', fecha_nacimiento: '2015-03-04', documento: '12345678', diagnostico: 'sintetico', telefono_responsable: '+549110' } },
      { externalId: 'ac-2', fields: { nombre: 'Carla', apellidos: 'Gomez', fecha_nacimiento: '04/07/2008', documento: '' } },
      { externalId: 'ac-3', fields: { nombre: '', apellidos: '' } },
    ], 12), MAP, 'AR').read();
    expect(r.fatalError).toBeUndefined();
    expect(r.expectedCount).toBe(12);
    expect(r.readCount).toBe(2);
    expect(r.records.map(x => x.externalId)).toEqual(['ac-1', 'ac-2']);
    expect(r.records[1].canonical.birthDate).toBe('2008-07-04');
    expect(r.records[1].canonical.documentNumber).toBeNull();
    expect(r.skipped).toEqual([{ externalId: 'ac-3', reason: 'no_name' }]);
    expect(JSON.stringify(r.records)).not.toContain('+549110');
    expect(r.unmappedFields).toEqual(['telefono_responsable']);
  });

  it('API que estoura com outro erro → fatalError com o NOME do erro, nunca a mensagem', async () => {
    const boom = new Error('token secreto na mensagem'); boom.name = 'AnaCareHttpError';
    const r = await new AnaCareApiSourceReader({ fetchAllPatients: async () => { throw boom; } }, MAP, 'AR').read();
    expect(r.fatalError).toBe('anacare_fetch_failed: AnaCareHttpError');
    expect(r.fatalError).not.toContain('secreto');
  });
});
