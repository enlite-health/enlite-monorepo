import { DiagnosisSource } from '../DiagnosisSource';
import { selectDisplayedDiagnosis, selectPublicDiagnosisLabel } from '../PublicDiagnosisSelection';

// Fixtures sintéticas: nenhum título/código CID real.
interface Fx {
  conceptTitle: string;
  conceptLanguage: string;
  source: DiagnosisSource;
  isPrimary: boolean;
  active: boolean;
}

function d(
  title: string,
  o: Partial<Omit<Fx, 'conceptTitle'>> = {},
): Fx {
  return {
    conceptTitle: title,
    conceptLanguage: 'es',
    source: DiagnosisSource.PANEL,
    isPrimary: false,
    active: true,
    ...o,
  };
}

describe('selectPublicDiagnosisLabel — spec 042 §4 (A1)', () => {
  it('caso 1: exatamente 1 ativo, mesmo sem is_primary → mostra esse', () => {
    expect(selectPublicDiagnosisLabel([d('Sintético A', { isPrimary: false })])).toBe('Sintético A');
  });

  it('caso 2: 2+ ativos e exatamente 1 principal → o principal', () => {
    const rows = [d('Sintético A'), d('Sintético B', { isPrimary: true }), d('Sintético C')];
    expect(selectPublicDiagnosisLabel(rows)).toBe('Sintético B');
  });

  it('caso 3: 2+ ativos e NENHUM principal → null (não adivinha)', () => {
    const rows = [d('Sintético A'), d('Sintético B')];
    expect(selectPublicDiagnosisLabel(rows)).toBeNull();
    expect(selectDisplayedDiagnosis(rows)).toBeNull();
  });

  it('caso 3b: 2+ principais de origens diferentes (PANEL e CLICKUP) → vence PANEL', () => {
    const rows = [
      d('Do ClickUp', { isPrimary: true, source: DiagnosisSource.CLICKUP }),
      d('Do Painel', { isPrimary: true, source: DiagnosisSource.PANEL }),
    ];
    expect(selectPublicDiagnosisLabel(rows)).toBe('Do Painel');
  });

  it('caso 3b: CLICKUP e BACKFILL principais → vence CLICKUP', () => {
    const rows = [
      d('Do Backfill', { isPrimary: true, source: DiagnosisSource.BACKFILL }),
      d('Do ClickUp', { isPrimary: true, source: DiagnosisSource.CLICKUP }),
    ];
    expect(selectPublicDiagnosisLabel(rows)).toBe('Do ClickUp');
  });

  it('caso 4: 0 ativos e lista vazia → null', () => {
    expect(selectPublicDiagnosisLabel([])).toBeNull();
    expect(selectPublicDiagnosisLabel([d('Sintético A', { active: false, isPrimary: true })])).toBeNull();
  });

  it('inativo é ignorado: 1 ativo + 1 inativo principal → o ativo (caso 1)', () => {
    const rows = [d('Inativo', { active: false, isPrimary: true }), d('Ativo')];
    expect(selectPublicDiagnosisLabel(rows)).toBe('Ativo');
  });

  it('inativos não contam para o "2+": 2 ativos sem principal + inativo principal → null', () => {
    const rows = [d('A'), d('B'), d('Inativo', { active: false, isPrimary: true })];
    expect(selectPublicDiagnosisLabel(rows)).toBeNull();
  });
});

describe('selectPublicDiagnosisLabel — idioma (A2)', () => {
  it('(a) única ativa em en → null', () => {
    expect(selectPublicDiagnosisLabel([d('Synthetic', { conceptLanguage: 'en' })])).toBeNull();
  });

  it('(b) principal en + secundário es não-principal → null (idioma checado DEPOIS de escolher)', () => {
    const rows = [d('Synthetic', { isPrimary: true, conceptLanguage: 'en' }), d('Sintético B')];
    expect(selectPublicDiagnosisLabel(rows)).toBeNull();
  });

  it('(c) principal es + outro en → título do es', () => {
    const rows = [d('Sintético A', { isPrimary: true }), d('Synthetic', { conceptLanguage: 'en' })];
    expect(selectPublicDiagnosisLabel(rows)).toBe('Sintético A');
  });

  it('(d) idioma desconhecido → null', () => {
    expect(selectPublicDiagnosisLabel([d('Sintético', { conceptLanguage: 'fr' })])).toBeNull();
  });

  it('título vazio ou só espaços → null (seção ausente, nunca string vazia)', () => {
    expect(selectPublicDiagnosisLabel([d('   ')])).toBeNull();
  });
});
