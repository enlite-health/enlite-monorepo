/**
 * createMentionSuggestion — teste unitário da parte pura (`items()`), sem DOM (spec 022, Rodada
 * 2/R2-F). `render()` (ReactRenderer + editor real) já é coberto de ponta a ponta por
 * `MessageComposer.test.tsx`.
 */
import { describe, it, expect, vi } from 'vitest';
import { configureMentionSuggestion } from '../createMentionSuggestion';

describe('configureMentionSuggestion (extraído do MessageComposer, Rodada 2/R2-F)', () => {
  it('items() devolve os candidatos e chama onResults com o resultado bruto', async () => {
    const entries = [{ uid: 'u-1', displayName: 'QA Staff Um' }];
    const fetchCandidates = vi.fn().mockResolvedValue(entries);
    const onResults = vi.fn();
    const suggestion = configureMentionSuggestion({ fetchCandidates, onResults });

    const result = await suggestion.items!({ query: 'qa' } as any);

    expect(result).toEqual(entries);
    expect(fetchCandidates).toHaveBeenCalledWith('qa');
    expect(onResults).toHaveBeenCalledWith(entries);
  });

  it('items() respeita maxResults (corta o excedente, nunca chama onResults com o corte)', async () => {
    const entries = [
      { uid: 'u-1', displayName: 'A' },
      { uid: 'u-2', displayName: 'B' },
      { uid: 'u-3', displayName: 'C' },
    ];
    const fetchCandidates = vi.fn().mockResolvedValue(entries);
    const onResults = vi.fn();
    const suggestion = configureMentionSuggestion({ fetchCandidates, maxResults: 2, onResults });

    const result = await suggestion.items!({ query: '' } as any);

    expect(result).toHaveLength(2);
    // onResults recebe o bruto (F5, para o cache de nome aproveitar TODO resultado visto, não só
    // os que o popup mostra) — só o retorno pro TipTap é cortado.
    expect(onResults).toHaveBeenCalledWith(entries);
  });

  it('items() falha (rede/403/500): devolve [] em vez de propagar o erro (autocomplete não é canal de alerta)', async () => {
    const fetchCandidates = vi.fn().mockRejectedValue(new Error('network'));
    const suggestion = configureMentionSuggestion({ fetchCandidates });

    const result = await suggestion.items!({ query: 'qa' } as any);

    expect(result).toEqual([]);
  });

  it('minQueryLength/char default: 0 e "@" quando não informado', () => {
    const suggestion = configureMentionSuggestion({ fetchCandidates: vi.fn() });
    expect(suggestion.char).toBe('@');
    expect(suggestion.minQueryLength).toBe(0);
  });

  it('minQueryLength customizado é repassado', () => {
    const suggestion = configureMentionSuggestion({ fetchCandidates: vi.fn(), minQueryLength: 2 });
    expect(suggestion.minQueryLength).toBe(2);
  });
});
