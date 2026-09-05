import { DiagnosisSource } from '../DiagnosisSource';
import { PrimaryDiagnosisPolicy } from '../PrimaryDiagnosisPolicy';

interface Fixture {
  label: string;
  source: DiagnosisSource;
  isPrimary: boolean;
  active: boolean;
}

function d(label: string, source: DiagnosisSource, isPrimary: boolean, active = true): Fixture {
  return { label, source, isPrimary, active };
}

describe('PrimaryDiagnosisPolicy — qual principal vence entre origens (Strategy, D263)', () => {
  it('só uma origem com principal ativo: essa vence', () => {
    const rows = [d('clickup-primary', DiagnosisSource.CLICKUP, true)];
    expect(PrimaryDiagnosisPolicy.winningPrimary(rows)?.label).toBe('clickup-primary');
  });

  it('PANEL vence CLICKUP quando os dois têm principal ativo (REGRA-03)', () => {
    const rows = [
      d('clickup-primary', DiagnosisSource.CLICKUP, true),
      d('panel-primary', DiagnosisSource.PANEL, true),
    ];
    expect(PrimaryDiagnosisPolicy.winningPrimary(rows)?.label).toBe('panel-primary');
  });

  it('CLICKUP vence BACKFILL quando os dois têm principal ativo', () => {
    const rows = [
      d('backfill-primary', DiagnosisSource.BACKFILL, true),
      d('clickup-primary', DiagnosisSource.CLICKUP, true),
    ];
    expect(PrimaryDiagnosisPolicy.winningPrimary(rows)?.label).toBe('clickup-primary');
  });

  it('ignora principal INATIVO — o espelho do ClickUp não desativa o do painel, mas se o do painel morrer sozinho o CLICKUP assume', () => {
    const rows = [
      d('panel-primary-inativo', DiagnosisSource.PANEL, true, false),
      d('clickup-primary', DiagnosisSource.CLICKUP, true, true),
    ];
    expect(PrimaryDiagnosisPolicy.winningPrimary(rows)?.label).toBe('clickup-primary');
  });

  it('ignora linha não-principal mesmo que ativa', () => {
    const rows = [
      d('panel-nao-principal', DiagnosisSource.PANEL, false, true),
      d('clickup-primary', DiagnosisSource.CLICKUP, true, true),
    ];
    expect(PrimaryDiagnosisPolicy.winningPrimary(rows)?.label).toBe('clickup-primary');
  });

  it('lista vazia ou sem nenhum principal ativo devolve null — nunca inventa um vencedor', () => {
    expect(PrimaryDiagnosisPolicy.winningPrimary([])).toBeNull();
    expect(PrimaryDiagnosisPolicy.winningPrimary([d('inativo', DiagnosisSource.PANEL, true, false)])).toBeNull();
    expect(PrimaryDiagnosisPolicy.winningPrimary([d('nao-principal', DiagnosisSource.PANEL, false, true)])).toBeNull();
  });
});
