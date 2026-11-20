import { projectInForceFor, type ProjectVersionInForce } from '../TherapeuticProjectVigencia';

const S1 = 'serv-1';
const S2 = 'serv-2';
const v = (id: string, over: Partial<ProjectVersionInForce> = {}): ProjectVersionInForce => ({
  id,
  contractedServiceId: S1,
  startDate: '2026-09-01',
  endDate: '2026-12-31',
  createdAt: '2026-09-01T10:00:00.000Z',
  annulledAt: null,
  ...over,
});

describe('projectInForceFor — PTI vigente por serviço contratado e data (spec 092)', () => {
  it('2 serviços do mesmo paciente: devolve o PTI do serviço pedido, nunca o do outro (o defeito do currentVersionOf por paciente)', () => {
    const versions = [
      v('do-s1', { contractedServiceId: S1, createdAt: '2026-09-01T10:00:00.000Z' }),
      v('do-s2', { contractedServiceId: S2, createdAt: '2026-10-01T10:00:00.000Z' }), // mais recente, mas de outro serviço
    ];
    expect(projectInForceFor(versions, S1, '2026-11-10')?.id).toBe('do-s1');
    expect(projectInForceFor(versions, S2, '2026-11-10')?.id).toBe('do-s2');
  });

  it('data fora do prazo → null (antes do início e depois do fim); as bordas contam (inclusivo)', () => {
    const versions = [v('a', { startDate: '2026-09-01', endDate: '2026-09-30' })];
    expect(projectInForceFor(versions, S1, '2026-08-31')).toBeNull();
    expect(projectInForceFor(versions, S1, '2026-10-01')).toBeNull();
    expect(projectInForceFor(versions, S1, '2026-09-01')?.id).toBe('a');
    expect(projectInForceFor(versions, S1, '2026-09-30')?.id).toBe('a');
  });

  it('versão anulada é ignorada, mesmo sendo a mais recente; sobra a anterior', () => {
    const versions = [
      v('antiga', { createdAt: '2026-09-01T10:00:00.000Z' }),
      v('anulada', { createdAt: '2026-10-01T10:00:00.000Z', annulledAt: '2026-10-02T00:00:00.000Z' }),
    ];
    expect(projectInForceFor(versions, S1, '2026-11-10')?.id).toBe('antiga');
  });

  it('empate de prazo → a de created_at mais recente (D328)', () => {
    const versions = [
      v('v1.0', { createdAt: '2026-09-01T10:00:00.000Z' }),
      v('v1.1', { createdAt: '2026-10-15T10:00:00.000Z' }),
      v('v0.9', { createdAt: '2026-08-01T10:00:00.000Z' }),
    ];
    expect(projectInForceFor(versions, S1, '2026-11-10')?.id).toBe('v1.1');
  });

  it('a mais recente que NÃO cobre a data perde para a mais antiga que cobre', () => {
    const versions = [
      v('cobre', { startDate: '2026-09-01', endDate: '2026-12-31', createdAt: '2026-09-01T10:00:00.000Z' }),
      v('futura', { startDate: '2027-01-01', endDate: '2027-06-30', createdAt: '2026-10-01T10:00:00.000Z' }),
    ];
    expect(projectInForceFor(versions, S1, '2026-11-10')?.id).toBe('cobre');
  });

  it('nenhuma versão / todas anuladas / só de outro serviço → null (DC-4)', () => {
    expect(projectInForceFor([], S1, '2026-11-10')).toBeNull();
    expect(projectInForceFor([v('x', { annulledAt: '2026-10-02T00:00:00.000Z' })], S1, '2026-11-10')).toBeNull();
    expect(projectInForceFor([v('y', { contractedServiceId: S2 })], S1, '2026-11-10')).toBeNull();
  });
});
