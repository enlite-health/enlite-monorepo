import {
  createTherapeuticProjectSchema,
  annulTherapeuticProjectSchema,
  createCatalogItemSchema,
  updateCatalogItemSchema,
  createCatalogItemSchemaFor,
  updateCatalogItemSchemaFor,
  catalogKindSchema,
  createShiftTemplateSchema,
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
  contactStatus: {},
};

// 091: `mode:'new'` leva os blocos por diagnóstico (`diagnosisPlans`) no lugar dos ids planos; `version` (ids planos, formato antigo)
// é o corpo do `mode:'edit'` sobre versão plana. Nenhum dos dois leva `segmentId` (o segmento saiu de vez, DF-1).
const { specificObjectiveIds: _o, activityIds: _a, ...versionSemIdsPlanos } = version;
const plan = (diagnosisUri: string) => ({ diagnosisUri, specificObjectiveIds: [UUID], activityIds: [UUID] });
const newVersion = { ...versionSemIdsPlanos, diagnosisPlans: [plan(version.diagnoses[0].uri)] };

describe('therapeuticProjectSchemas — contactStatus (spec 048)', () => {
  const edit = (v: Record<string, unknown>) => createTherapeuticProjectSchema.safeParse({ mode: 'edit', fromVersionId: UUID, version: v });

  it('ausente → falha (vazio ambíguo: cliente antigo não apaga pendência em silêncio); {} passa', () => {
    const { contactStatus: _c, ...sem } = version;
    expect(edit(sem).success).toBe(false);
    expect(edit(version).success).toBe(true);
  });

  it('status e ids no MESMO campo → falha, nas duas formas (contactRefs e careTeamIds)', () => {
    expect(edit({ ...version, contactStatus: { RESPONSIBLE: 'PENDING' }, contactRefs: [{ kind: 'RESPONSIBLE', id: UUID }] }).success).toBe(false);
    expect(edit({ ...version, contactStatus: { COVERAGE: 'NOT_NEEDED' }, contactRefs: [{ kind: 'COVERAGE', id: UUID }] }).success).toBe(false);
    expect(edit({ ...version, contactStatus: { CARE_TEAM: 'PENDING' }, careTeamIds: [UUID] }).success).toBe(false);
  });

  it('status num campo e ids em OUTRO campo passa', () => {
    expect(edit({ ...version, contactStatus: { RESPONSIBLE: 'PENDING' }, contactRefs: [{ kind: 'EXTERNAL', id: UUID }], careTeamIds: [UUID] }).success).toBe(true);
  });

  it('valor fora de PENDING|NOT_NEEDED e chave desconhecida → falha', () => {
    expect(edit({ ...version, contactStatus: { RESPONSIBLE: 'DONE' } }).success).toBe(false);
    expect(edit({ ...version, contactStatus: { OTHER: 'PENDING' } }).success).toBe(false);
  });

  it('o mesmo vale no modo new', () => {
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, contactStatus: { CARE_TEAM: 'PENDING' }, careTeamIds: [UUID] } }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, contactStatus: { CARE_TEAM: 'PENDING' } } }).success).toBe(true);
  });
});

describe('therapeuticProjectSchemas — a borda (spec 017)', () => {
  it('Novo e Editar: discriminado por mode; edit exige fromVersionId', () => {
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: newVersion }).success).toBe(true);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'edit', fromVersionId: UUID, version }).success).toBe(true);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'edit', version }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'novo', version }).success).toBe(false);
  });

  it('modalidade (D301, Ana 08/09): obrigatória e fechada em IN_PERSON | ONLINE | HYBRID', () => {
    for (const modality of ['IN_PERSON', 'ONLINE', 'HYBRID']) {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, modality } }).success).toBe(true);
    }
    const { modality: _m, ...semModalidade } = newVersion;
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: semModalidade }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, modality: 'presencial' } }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, modality: null } }).success).toBe(false);
  });

  it('🔒 major/minor/patientId/country NÃO entram pelo corpo (.strict())', () => {
    for (const extra of [{ major: 3 }, { minor: 1 }, { patientId: UUID }, { country: 'BR' }]) {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, ...extra } }).success).toBe(false);
    }
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: newVersion, major: 3 }).success).toBe(false);
  });

  it('teto 4000 nos dois textos clínicos (lex C6) e listas não vazias', () => {
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, clinicalContext: 'x'.repeat(THERAPEUTIC_TEXT_MAX) } }).success).toBe(true);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, clinicalContext: 'x'.repeat(THERAPEUTIC_TEXT_MAX + 1) } }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, generalObjective: '   ' } }).success).toBe(false);
    // `pathologyTypeIds` (campo antigo do catálogo) é recusado pela borda `.strict()`: o segmento deriva do CID-11 no servidor.
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, pathologyTypeIds: [UUID] } }).success).toBe(false);
    for (const key of ['diagnoses', 'diagnosisPlans'] as const) {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, [key]: [] } }).success).toBe(false);
    }
    // Editar sobre versão plana (formato antigo): os ids planos seguem 1..50.
    for (const key of ['specificObjectiveIds', 'activityIds'] as const) {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'edit', fromVersionId: UUID, version: { ...version, [key]: [] } }).success).toBe(false);
    }
  });

  it('prazo: endDate antes de startDate → inválido; formato ISO obrigatório', () => {
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, endDate: '2026-08-31' } }).success).toBe(false);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, startDate: '01/09/2026' } }).success).toBe(false);
  });

  it('diagnóstico é snapshot estrito {uri, code?, title} — campo a mais é recusado (lex C19); code é opcional (REQ-21)', () => {
    const diag = { ...version.diagnoses[0], note: 'texto livre' };
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, diagnoses: [diag] } }).success).toBe(false);
    const comPlano = { diagnosisPlans: [plan('u')] };
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, ...comPlano, diagnoses: [{ uri: 'u', title: 't' }] } }).success).toBe(true);
    expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, ...comPlano, diagnoses: [{ uri: 'u', code: '', title: 't' }] } }).success).toBe(true);
  });

  describe('091 (DF-1) — o segmento saiu: `segmentId`/`segment` não entram pelo corpo, nem no Novo nem no Editar (.strict())', () => {
    it('new e edit sem segmentId → válidos (ele deixou de ser obrigatório)', () => {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: newVersion }).success).toBe(true);
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'edit', fromVersionId: UUID, version }).success).toBe(true);
    });

    it('new com segmentId (uuid ou não), segmentLabel ou segment:{id,label} → inválido (400)', () => {
      for (const extra of [{ segmentId: UUID }, { segmentId: 'x' }, { segmentLabel: 'x' }, { segment: { id: UUID, label: 'x' } }]) {
        expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, ...extra } }).success).toBe(false);
      }
    });

    it('edit com segmentId ou segment → inválido, no formato plano e no por diagnóstico', () => {
      for (const base of [version, { ...versionSemIdsPlanos, diagnosisPlans: newVersion.diagnosisPlans }]) {
        for (const extra of [{ segmentId: UUID }, { segment: { id: UUID, label: 'x' } }]) {
          expect(createTherapeuticProjectSchema.safeParse({ mode: 'edit', fromVersionId: UUID, version: { ...base, ...extra } }).success).toBe(false);
        }
      }
    });
  });

  describe('091 — blocos por diagnóstico (diagnosisPlans): o Novo só os aceita, e eles cobrem os diagnósticos uma vez cada', () => {
    it('new com ids planos no corpo → inválido (o Novo é só por diagnóstico)', () => {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, specificObjectiveIds: [UUID], activityIds: [UUID] } }).success).toBe(false);
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...versionSemIdsPlanos } }).success).toBe(false);
    });

    it('bloco de diagnóstico que não está em diagnoses, repetido ou faltando → inválido', () => {
      const dois = { ...newVersion, diagnoses: [...version.diagnoses, { uri: 'http://id.who.int/icd/entity/2', title: 'Outro' }] };
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, diagnosisPlans: [plan('http://id.who.int/icd/entity/9')] } }).success).toBe(false);
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...dois, diagnosisPlans: [plan(version.diagnoses[0].uri)] } }).success).toBe(false);
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...dois, diagnosisPlans: [plan(version.diagnoses[0].uri), plan(version.diagnoses[0].uri)] } }).success).toBe(false);
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...dois, diagnosisPlans: [plan(version.diagnoses[0].uri), plan('http://id.who.int/icd/entity/2')] } }).success).toBe(true);
    });

    it('bloco vazio (0 objetivos e 0 atividades) é aceito na borda (se pode é do domínio); id que não é uuid → inválido', () => {
      const vazio = [{ diagnosisUri: version.diagnoses[0].uri, specificObjectiveIds: [], activityIds: [] }];
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, diagnosisPlans: vazio } }).success).toBe(true);
      const ruim = [{ diagnosisUri: version.diagnoses[0].uri, specificObjectiveIds: ['x'], activityIds: [] }];
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'new', version: { ...newVersion, diagnosisPlans: ruim } }).success).toBe(false);
    });

    it('edit por diagnóstico (versão de origem nova) → válido; edit sem NENHUM dos dois formatos → inválido', () => {
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'edit', fromVersionId: UUID, version: newVersion }).success).toBe(true);
      expect(createTherapeuticProjectSchema.safeParse({ mode: 'edit', fromVersionId: UUID, version: versionSemIdsPlanos }).success).toBe(false);
    });
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

  // 091: objetivo exige `serviceCode`, atividade exige `objectiveId` — o corpo mínimo válido de cada kind.
  const dono = (kind: 'specific-objectives' | 'activities'): Record<string, unknown> =>
    kind === 'specific-objectives' ? { serviceCode: 'AT' } : { objectiveId: UUID };

  it('spec 061: título 150 (151 recusa no create e no update com label); PATCH só com description não exige label', () => {
    for (const kind of ['specific-objectives', 'activities'] as const) {
      expect(createCatalogItemSchemaFor(kind).safeParse({ label: 'x'.repeat(150), ...dono(kind) }).success).toBe(true);
      expect(createCatalogItemSchemaFor(kind).safeParse({ label: 'x'.repeat(151), ...dono(kind) }).success).toBe(false);
      expect(updateCatalogItemSchemaFor(kind).safeParse({ label: 'x'.repeat(151) }).success).toBe(false);
      expect(updateCatalogItemSchemaFor(kind).safeParse({ label: 'x'.repeat(150) }).success).toBe(true);
      expect(updateCatalogItemSchemaFor(kind).safeParse({ description: 'DESCRIPCION-SINTETICA-1' }).success).toBe(true);
    }
  });

  it('spec 061: descrição 1000 ok, 1001 recusa; "" no PATCH vira null (limpar); PII recusa sem ecoar o texto', () => {
    for (const kind of ['specific-objectives', 'activities'] as const) {
      expect(createCatalogItemSchemaFor(kind).safeParse({ label: 'TITULO-SINTETICO-1', description: 'a'.repeat(1000), ...dono(kind) }).success).toBe(true);
      expect(createCatalogItemSchemaFor(kind).safeParse({ label: 'TITULO-SINTETICO-1', description: 'a'.repeat(1001), ...dono(kind) }).success).toBe(false);
      expect(updateCatalogItemSchemaFor(kind).safeParse({ description: 'a'.repeat(1001) }).success).toBe(false);
      const limpar = updateCatalogItemSchemaFor(kind).safeParse({ description: '   ' });
      expect(limpar.success).toBe(true);
      expect(limpar.success && (limpar.data as { description?: unknown }).description).toBeNull();
      const nulo = updateCatalogItemSchemaFor(kind).safeParse({ description: null });
      expect(nulo.success && (nulo.data as { description?: unknown }).description).toBeNull();
      const pii = createCatalogItemSchemaFor(kind).safeParse({ label: 'TITULO-SINTETICO-1', description: 'llamar al 11 4463 5919', ...dono(kind) });
      expect(pii.success).toBe(false);
      expect(JSON.stringify(pii)).not.toContain('4463');
    }
  });

  it('091 (DF-1): `segments` NÃO é kind de catálogo (400/404 na rota): o enum fechado só tem objetivos e atividades', () => {
    expect(catalogKindSchema.safeParse('segments').success).toBe(false);
    expect(catalogKindSchema.safeParse('specific-objectives').success).toBe(true);
    expect(catalogKindSchema.safeParse('activities').success).toBe(true);
  });

  it('091 (DF-1): `segmentId` não existe em objetivos nem atividades (.strict() → 400), no create e no PATCH, uuid ou null', () => {
    const UUID_SEG = '22222222-2222-4222-8222-222222222222';
    for (const kind of ['specific-objectives', 'activities'] as const) {
      expect(createCatalogItemSchemaFor(kind).safeParse({ label: 'Objetivo', ...dono(kind) }).success).toBe(true);
      for (const segmentId of [UUID_SEG, null, 'nao-uuid']) {
        expect(createCatalogItemSchemaFor(kind).safeParse({ label: 'Objetivo', ...dono(kind), segmentId }).success).toBe(false);
        expect(updateCatalogItemSchemaFor(kind).safeParse({ segmentId }).success).toBe(false);
      }
    }
  });

  it('motivos de saída (492): kind novo NÃO aceita `segmentId` (400) e o rótulo passa pela mesma guarda de dado pessoal', () => {
    const UUID_SEG = '22222222-2222-4222-8222-222222222222';
    const kind = 'service-exit-reasons' as const;
    expect(createCatalogItemSchemaFor(kind).safeParse({ label: 'Cambio de disponibilidad' }).success).toBe(true);
    expect(createCatalogItemSchemaFor(kind).safeParse({ label: 'Cambio', segmentId: UUID_SEG }).success).toBe(false);
    expect(updateCatalogItemSchemaFor(kind).safeParse({ segmentId: UUID_SEG }).success).toBe(false);
    expect(updateCatalogItemSchemaFor(kind).safeParse({ active: false }).success).toBe(true);
    expect(createCatalogItemSchemaFor(kind).safeParse({ label: 'fulano@example.com' }).success).toBe(false);
    // O kind novo NÃO é catálogo terapêutico: o schema do domínio clínico continua recusando.
    expect(catalogKindSchema.safeParse(kind).success).toBe(false);
  });
});

describe('createShiftTemplateSchema — guardias predefinidas (spec 074)', () => {
  it('R3 guardia com items vazio é recusada', () => {
    expect(createShiftTemplateSchema.safeParse({ label: 'QA', items: [] }).success).toBe(false);
  });

  it('R4 guardia com startTime 25:00 é recusada', () => {
    expect(createShiftTemplateSchema.safeParse({ label: 'QA', items: [{ startTime: '25:00', durationMinutes: 60 }] }).success).toBe(false);
  });

  it('R5 guardia válida com 2 turnos passa', () => {
    const r = createShiftTemplateSchema.safeParse({
      label: 'QA', items: [{ startTime: '08:00', durationMinutes: 720 }, { startTime: '20:00', durationMinutes: 720 }],
    });
    expect(r.success).toBe(true);
  });
});
