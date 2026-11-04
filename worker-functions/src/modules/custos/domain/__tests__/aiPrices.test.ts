import { estimateAiCostUsd } from '../aiPrices';

describe('estimateAiCostUsd (T056)', () => {
  it('gemini-2.5-flash: 0.30 entrada / 2.50 saída por milhão', () => {
    expect(estimateAiCostUsd('gemini-2.5-flash', 1_000_000, 1_000_000)).toBeCloseTo(2.8, 10);
    expect(estimateAiCostUsd('gemini-2.5-flash', 0, 0)).toBe(0);
  });
  it('modelo sem preço (ou nome herdado do protótipo) -> null, nunca 0', () => {
    expect(estimateAiCostUsd('modelo-novo', 100, 100)).toBeNull();
    expect(estimateAiCostUsd('toString', 100, 100)).toBeNull();
  });
});
