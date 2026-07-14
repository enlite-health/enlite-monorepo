import { describe, it, expect } from 'vitest';
import {
  ensureAudioDefault,
  safeResponseType,
  withAudioDefault,
} from '../prescreeningResponseType';

describe('prescreeningResponseType', () => {
  describe('safeResponseType', () => {
    it('respeita ["text"] deliberado', () => {
      expect(safeResponseType(['text'])).toEqual(['text']);
    });
    it('ordena canônico ["audio","text"] → ["text","audio"]', () => {
      expect(safeResponseType(['audio', 'text'])).toEqual(['text', 'audio']);
    });
    it.each([null, undefined, [], 'text', 42, ['foo']])(
      'default ["text","audio"] para entrada inválida/vazia %p',
      (input) => {
        expect(safeResponseType(input as unknown)).toEqual(['text', 'audio']);
      },
    );
  });

  describe('ensureAudioDefault (fonte IA)', () => {
    it('força áudio quando a IA gera só ["text"]', () => {
      expect(ensureAudioDefault(['text'])).toEqual(['text', 'audio']);
    });
    it.each([null, undefined, [], ['audio']])(
      'garante ["text","audio"] para %p',
      (input) => {
        expect(ensureAudioDefault(input as unknown)).toEqual(['text', 'audio']);
      },
    );
  });

  describe('withAudioDefault', () => {
    it('marca áudio em toda pergunta semeada, preservando os demais campos', () => {
      const out = withAudioDefault([
        { question: 'A?', responseType: ['text'], weight: 5 },
        { question: 'B?', responseType: undefined },
      ]);
      expect(out[0]).toEqual({ question: 'A?', responseType: ['text', 'audio'], weight: 5 });
      expect(out[1].responseType).toEqual(['text', 'audio']);
    });
    it('não muta a entrada', () => {
      const input = [{ responseType: ['text'] }];
      withAudioDefault(input);
      expect(input[0].responseType).toEqual(['text']);
    });
  });
});
