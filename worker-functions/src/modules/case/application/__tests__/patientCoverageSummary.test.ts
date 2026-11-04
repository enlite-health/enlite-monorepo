import {
  deriveCurrentCoverage,
  deriveEntryDate,
  type SummarizableService,
} from '../patientCoverageSummary';

const linked = (code: string, name: string, over: Partial<SummarizableService> = {}): SummarizableService => ({
  active: true,
  startDate: null,
  payer: { state: 'LINKED', isPrivate: false, names: { providerCode: code, providerName: name } },
  ...over,
});

describe('deriveCurrentCoverage', () => {
  it('1 serviço ativo vinculado => 1 provedor', () => {
    expect(deriveCurrentCoverage([linked('OSDE', 'OSDE')])).toEqual({
      providers: [{ code: 'OSDE', name: 'OSDE' }],
      privateServices: 0, hiddenServices: 0, unlinkedServices: 0, activeServices: 1,
    });
  });

  it('2 serviços, 2 obras sociais => ordenadas por nome', () => {
    const out = deriveCurrentCoverage([linked('SW', 'Swiss Medical'), linked('OS', 'OSDE')]);
    expect(out?.providers.map((p) => p.name)).toEqual(['OSDE', 'Swiss Medical']);
    expect(out?.activeServices).toBe(2);
  });

  it('2 serviços na mesma obra social => 1 provedor', () => {
    const out = deriveCurrentCoverage([linked('OS', 'OSDE'), linked('OS', 'OSDE')]);
    expect(out?.providers).toEqual([{ code: 'OS', name: 'OSDE' }]);
    expect(out?.activeServices).toBe(2);
  });

  it('serviço sem vínculo => unlinkedServices', () => {
    const out = deriveCurrentCoverage([{ active: true, startDate: null, payer: { state: 'NO_CONTRACT' } }]);
    expect(out).toMatchObject({ unlinkedServices: 1, providers: [], activeServices: 1 });
  });

  it('vínculo PRIVATE => privateServices e nenhum provedor', () => {
    const out = deriveCurrentCoverage([
      { active: true, startDate: null, payer: { state: 'LINKED', isPrivate: true, names: { providerCode: 'P', providerName: 'Particular' } } },
    ]);
    expect(out).toMatchObject({ privateServices: 1, providers: [], activeServices: 1 });
  });

  it('nenhum serviço ativo => activeServices 0 e providers vazio', () => {
    expect(deriveCurrentCoverage([linked('OS', 'OSDE', { active: false })])).toEqual({
      providers: [], privateServices: 0, hiddenServices: 0, unlinkedServices: 0, activeServices: 0,
    });
  });

  it('serviço encerrado não conta na cobertura mas conta na data', () => {
    const services = [linked('OS', 'OSDE', { active: false, startDate: '2024-01-10' }), linked('SW', 'Swiss', { startDate: '2025-05-05' })];
    const out = deriveCurrentCoverage(services);
    expect(out?.providers).toEqual([{ code: 'SW', name: 'Swiss' }]);
    expect(out?.activeServices).toBe(1);
    expect(deriveEntryDate(services)).toBe('2024-01-10');
  });

  it('names null e não privado => hiddenServices', () => {
    const out = deriveCurrentCoverage([{ active: true, startDate: null, payer: { state: 'LINKED', isPrivate: false, names: null } }]);
    expect(out).toMatchObject({ hiddenServices: 1, providers: [], activeServices: 1 });
  });

  it('services null => null (não 0)', () => {
    expect(deriveCurrentCoverage(null)).toBeNull();
    expect(deriveCurrentCoverage(undefined)).toBeNull();
  });
});

describe('deriveEntryDate', () => {
  it('entryDate: menor start_date entre ativo e encerrado', () => {
    expect(deriveEntryDate([
      linked('A', 'A', { startDate: '2025-03-01' }),
      linked('B', 'B', { active: false, startDate: '2023-12-31' }),
      linked('C', 'C', { startDate: null }),
    ])).toBe('2023-12-31');
  });

  it('entryDate: sem start_date => null', () => {
    expect(deriveEntryDate([linked('A', 'A'), linked('B', 'B')])).toBeNull();
  });

  it('entryDate: lista vazia => null', () => {
    expect(deriveEntryDate([])).toBeNull();
  });
});
