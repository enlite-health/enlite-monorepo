import { GetScaleCatalogUseCase } from '../GetScaleCatalogUseCase';
import { fakePort, fakeState } from './fakeDailyReport';

describe('GetScaleCatalogUseCase', () => {
  it('devolve as escalas ordenadas por código e um version estável (hash do conteúdo = ETag)', async () => {
    const uc = new GetScaleCatalogUseCase(fakePort(fakeState()));
    const a = await uc.execute();
    const b = await uc.execute();
    expect(a.scales.map((s) => s.code)).toEqual(['AUT', 'CNT', 'GEN', 'OM', 'SN']);
    expect(a.version).toMatch(/^[0-9a-f]{64}$/);
    expect(a.version).toBe(b.version);
  });
});
