import { matchQuestionIds, normalizeQuestionText } from '../talentumQuestionMatching';
import type { TalentumQuestion } from '../ITalentumApiClient';

const q = (question: string, extra: Partial<TalentumQuestion> = {}): TalentumQuestion => ({
  question, type: 'text', responseType: ['text'], desiredResponse: 'r', weight: 5,
  required: false, analyzed: true, earlyStoppage: false, ...extra,
});

describe('matchQuestionIds (casamento pergunta local × remota)', () => {
  it('normaliza: trim, espaços colapsados, case-insensitive', () => {
    expect(normalizeQuestionText('  ¿Tiene   EXPERIENCIA? ')).toBe('¿tiene experiencia?');
  });

  it('(1) texto normalizado idêntico herda o questionId, mesmo com ordem trocada', () => {
    const out = matchQuestionIds(
      [q('Pregunta B'), q('  pregunta   a ')],
      [{ questionId: 'qa', question: 'Pregunta A' }, { questionId: 'qb', question: 'PREGUNTA B' }],
    );
    expect(out.map((o) => o.questionId)).toEqual(['qb', 'qa']);
  });

  it('(2) texto editado: as sobras casam por POSIÇÃO com as remotas que sobraram', () => {
    const out = matchQuestionIds(
      [q('igual'), q('editada 1'), q('editada 2')],
      [{ questionId: 'r1', question: 'velha 1' }, { questionId: 'r2', question: 'igual' }, { questionId: 'r3', question: 'velha 2' }],
    );
    expect(out.map((o) => o.questionId)).toEqual(['r2', 'r1', 'r3']);
  });

  it('(3a) local sem par vai SEM questionId (nova) — a chave nem existe', () => {
    const out = matchQuestionIds([q('a'), q('nova')], [{ questionId: 'ra', question: 'a' }]);
    expect(out[0].questionId).toBe('ra');
    expect(out[1]).not.toHaveProperty('questionId');
  });

  it('(3b) remota sem par é omitida (removida): nenhum id sobrando na saída', () => {
    const out = matchQuestionIds([q('a')], [{ questionId: 'ra', question: 'a' }, { questionId: 'rb', question: 'b' }]);
    expect(out).toHaveLength(1);
    expect(out.map((o) => o.questionId)).not.toContain('rb');
  });

  it('um questionId remoto nunca é usado duas vezes; preserva os campos locais', () => {
    const out = matchQuestionIds([q('x', { weight: 9 }), q('X', { weight: 2 })], [{ questionId: 'r', question: 'x' }]);
    expect(out.filter((o) => o.questionId === 'r')).toHaveLength(1);
    expect(out[0]).toMatchObject({ questionId: 'r', weight: 9 });
    expect(out[1]).not.toHaveProperty('questionId');
  });

  it('sem remotas: tudo novo; sem locais: lista vazia', () => {
    expect(matchQuestionIds([q('a')], [])[0]).not.toHaveProperty('questionId');
    expect(matchQuestionIds([], [{ questionId: 'r', question: 'a' }])).toEqual([]);
  });
});
