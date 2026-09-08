import {
  createTherapeuticProjectSchema,
  annulTherapeuticProjectSchema,
  createCatalogItemSchema,
  updateCatalogItemSchema,
  catalogKindSchema,
  THERAPEUTIC_TEXT_MAX,
} from '../therapeuticProjectSchemas';

const UUID = '11111111-1111-4111-8111-111111111111';
const version = {
  contractedServiceId: UUID,
  modality: 'IN_PERSON',
  diagnoses: [{ uri: 'http://id.who.int/icd/entity/1', code: '8B11', title: 'Sintético' }],
  clinicalContext: 'contexto',
  generalObjective: 'objetivo',
  specificObjectiveIds: [UUID],
  activityIds: [UUID],
  startDate: '2026-09-01',
  endDate: '2026-12-31',
};

describe('therapeuticProjectSchemas — a borda (spec 017)', () => {
  it('Novo e Editar: discriminado por mode; edit exige fromVersionId', () => {
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version }).success).toBe(true);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'edit', fromVersionId: UUID, version }).success).toBe(true);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'edit', version }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'novo', version }).success).toBe(false);
  });

  it('modalidade (D301, Ana 08/09): obrigatória e fechada em IN_PERSON | ONLINE | HYBRID', () => {
    for (const modality of ['IN_PERSON', 'ONLINE', 'HYBRID']) {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, modality } }).success).toBe(true);
    }
    const { modality: _m, ...semModalidade } = version;
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: semModalidade }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, modality: 'presencial' } }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, modality: null } }).success).toBe(false);
  });

  it('🔒 major/minor/patientId/country NÃO entram pelo corpo (.strict())', () => {
    for (const extra of [{ major: 3 }, { minor: 1 }, { patientId: UUID }, { country: 'BR' }]) {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, ...extra } }).success).toBe(false);
    }
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version, major: 3 }).success).toBe(false);
  });

  it('teto 4000 nos dois textos clínicos (lex C6) e listas não vazias', () => {
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, clinicalContext: 'x'.repeat(THERAPEUTIC_TEXT_MAX) } }).success).toBe(true);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, clinicalContext: 'x'.repeat(THERAPEUTIC_TEXT_MAX + 1) } }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, generalObjective: '   ' } }).success).toBe(false);
    // `pathologyTypeIds` (campo antigo do catálogo) é recusado pela borda `.strict()`: o segmento deriva do CID-11 no servidor.
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, pathologyTypeIds: [UUID] } }).success).toBe(false);
    for (const key of ['diagnoses', 'specificObjectiveIds', 'activityIds'] as const) {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, [key]: [] } }).success).toBe(false);
    }
  });

  it('prazo: endDate antes de startDate → inválido; formato ISO obrigatório', () => {
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, endDate: '2026-08-31' } }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, startDate: '01/09/2026' } }).success).toBe(false);
  });

  it('diagnóstico é snapshot estrito {uri, code?, title} — campo a mais é recusado (lex C19); code é opcional (REQ-21)', () => {
    const diag = { ...version.diagnoses[0], note: 'texto livre' };
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, diagnoses: [diag] } }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, diagnoses: [{ uri: 'u', title: 't' }] } }).success).toBe(true);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...version, diagnoses: [{ uri: 'u', code: '', title: 't' }] } }).success).toBe(true);
  });

  it('anulação: motivo obrigatório, ≤200, sem e-mail nem documento (lex C5/C18)', () => {
    expect(annulTherapeuticProjectSchema.safeParse({ reason: 'erro de digitação' }).success).toBe(true);
    expect(annulTherapeuticProjectSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(annulTherapeuticProjectSchema.safeParse({ reason: 'pedido de juan@example.com' }).success).toBe(false);
    expect(annulTherapeuticProjectSchema.safeParse({ reason: 'DNI 37.692.161 pediu' }).success).toBe(false);
    expect(annulTherapeuticProjectSchema.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
  });

  it('catálogo: kind fechado; rótulo ≤200 sem dado pessoal; patch vazio é recusado', () => {
    expect(catalogKindSchema.safeParse('activities').success).toBe(true);
    expect(catalogKindSchema.safeParse('symptoms').success).toBe(false);
    expect(createCatalogItemSchema.safeParse({ label: 'Realizar cambios posturales.' }).success).toBe(true);
    expect(createCatalogItemSchema.safeParse({ label: 'llamar al 11 4463 5919' }).success).toBe(false);
    expect(createCatalogItemSchema.safeParse({ label: 'x'.repeat(201) }).success).toBe(false);
    expect(createCatalogItemSchema.safeParse({ label: 'ok', extra: 1 }).success).toBe(false);
    expect(updateCatalogItemSchema.safeParse({}).success).toBe(false);
    expect(updateCatalogItemSchema.safeParse({ active: false }).success).toBe(true);
    expect(updateCatalogItemSchema.safeParse({ label: 'novo rótulo', sortOrder: 5 }).success).toBe(true);
  });
});
