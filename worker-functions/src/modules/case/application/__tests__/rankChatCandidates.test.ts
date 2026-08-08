import {
  normalizeForMatch,
  toMatchTerms,
  scoreGroupName,
  rankChatCandidates,
} from '../rankChatCandidates';
import type { PeriskopeGroupChat } from '@modules/notification';

function group(chatId: string, chatName: string | null, memberCount: number | null = 10): PeriskopeGroupChat {
  return { chatId, chatName, memberCount };
}

describe('rankChatCandidates', () => {
  describe('normalizeForMatch', () => {
    it('tira acento, caixa e pontuação', () => {
      expect(normalizeForMatch('Flia. PÉREZ-Gómez')).toBe('flia perez gomez');
    });
    it('colapsa espaços e apara as pontas', () => {
      expect(normalizeForMatch('  a   b  ')).toBe('a b');
    });
    it('mantém dígitos', () => {
      expect(normalizeForMatch('Caso 123')).toBe('caso 123');
    });
    it('devolve vazio para string só de pontuação', () => {
      expect(normalizeForMatch('---')).toBe('');
    });
  });

  describe('toMatchTerms', () => {
    it('descarta stopwords genéricas e termos de 1 caractere', () => {
      expect(toMatchTerms('Grupo de la flia Perez A')).toEqual(['perez']);
    });
    it('não repete termo', () => {
      expect(toMatchTerms('Perez Perez')).toEqual(['perez']);
    });
    it('devolve vazio quando sobra só stopword', () => {
      expect(toMatchTerms('grupo familia')).toEqual([]);
    });
  });

  describe('scoreGroupName', () => {
    it('score 0 quando o paciente não tem termo útil', () => {
      expect(scoreGroupName([], 'Flia Perez')).toEqual({ score: 0, matchedTerms: [] });
    });
    it('score 0 quando o grupo não tem nome', () => {
      expect(scoreGroupName(['perez'], null)).toEqual({ score: 0, matchedTerms: [] });
    });
    it('score 0 quando o nome do grupo normaliza para vazio', () => {
      expect(scoreGroupName(['perez'], '!!!')).toEqual({ score: 0, matchedTerms: [] });
    });
    it('score 0 quando nada bate', () => {
      expect(scoreGroupName(['perez'], 'Flia Gomez')).toEqual({ score: 0, matchedTerms: [] });
    });
    it('meio termo batendo = 0.5', () => {
      const r = scoreGroupName(['maria', 'gomez'], 'Flia Maria Lopez');
      expect(r.score).toBe(0.5);
      expect(r.matchedTerms).toEqual(['maria']);
    });
    it('nome inteiro contíguo ganha bônus e satura em 1', () => {
      const r = scoreGroupName(['maria', 'perez'], 'Flia Maria Perez - Prestadores');
      expect(r.score).toBe(1); // 1.0 + 0.25 saturado
      expect(r.matchedTerms).toEqual(['maria', 'perez']);
    });
    it('mesmos termos fora de ordem NÃO ganham o bônus de contiguidade', () => {
      const espalhado = scoreGroupName(['maria', 'perez'], 'Perez, Maria');
      expect(espalhado.score).toBe(1); // já era 1 pela cobertura de termos
      const parcial = scoreGroupName(['maria', 'perez', 'lopez'], 'Perez Lopez');
      expect(parcial.score).toBeCloseTo(0.6667, 3); // 2/3, sem bônus
    });
    it('prefixo (≥4 chars) casa abreviação nos dois sentidos', () => {
      expect(scoreGroupName(['rodriguez'], 'Flia Rodrig').score).toBeGreaterThan(0);
      expect(scoreGroupName(['rodrig'], 'Flia Rodriguez').score).toBeGreaterThan(0);
    });
    it('prefixo curto (<4 chars) NÃO casa — senão "an" pegaria meio dicionário', () => {
      expect(scoreGroupName(['an'], 'Flia Ana').score).toBe(0);
    });
    it('ignora acento dos dois lados', () => {
      expect(scoreGroupName(toMatchTerms('María Pérez'), 'Flia Maria Perez').score).toBe(1);
    });
  });

  describe('rankChatCandidates', () => {
    const groups = [
      group('1@g.us', 'Flia Maria Perez'),
      group('2@g.us', 'Prestadores Maria Perez', 14),
      group('3@g.us', 'Flia Gomez'),
      group('4@g.us', 'Maria Lopez'),
      group('5@g.us', null),
    ];

    it('devolve só quem tem score > 0, do mais parecido para o menos', () => {
      const out = rankChatCandidates({ patientName: 'Maria Perez', groups, limit: 10 });
      expect(out.map(c => c.chatId)).toEqual(['1@g.us', '2@g.us', '4@g.us']);
      expect(out[0].score).toBe(1);
      expect(out[2].score).toBe(0.5);
    });

    it('respeita o limite', () => {
      const out = rankChatCandidates({ patientName: 'Maria Perez', groups, limit: 2 });
      expect(out).toHaveLength(2);
    });

    it('empate é resolvido por nome do grupo, não pela ordem do Periskope', () => {
      const tied = [group('b@g.us', 'Zeta Perez'), group('a@g.us', 'Alfa Perez')];
      const out = rankChatCandidates({ patientName: 'Perez', groups: tied, limit: 10 });
      expect(out.map(c => c.chatId)).toEqual(['a@g.us', 'b@g.us']);
    });

    it('marca o grupo já preso a outro paciente', () => {
      const out = rankChatCandidates({
        patientName: 'Maria Perez',
        groups,
        linkedElsewhere: new Set(['2@g.us']),
        limit: 10,
      });
      expect(out.find(c => c.chatId === '2@g.us')?.linkedToOtherPatient).toBe(true);
      expect(out.find(c => c.chatId === '1@g.us')?.linkedToOtherPatient).toBe(false);
    });

    it('sem linkedElsewhere, ninguém é marcado', () => {
      const out = rankChatCandidates({ patientName: 'Maria Perez', groups, limit: 10 });
      expect(out.every(c => c.linkedToOtherPatient === false)).toBe(true);
    });

    it('paciente sem nome útil devolve lista vazia — não chuta candidato', () => {
      expect(rankChatCandidates({ patientName: '   ', groups, limit: 10 })).toEqual([]);
      expect(rankChatCandidates({ patientName: 'grupo familia', groups, limit: 10 })).toEqual([]);
    });

    it('preserva chatName e memberCount do Periskope', () => {
      const out = rankChatCandidates({ patientName: 'Maria Perez', groups, limit: 10 });
      const prestadores = out.find(c => c.chatId === '2@g.us');
      expect(prestadores).toMatchObject({ chatName: 'Prestadores Maria Perez', memberCount: 14 });
    });

    it('NÃO decide papel: família e prestadores do mesmo paciente saem os dois na lista', () => {
      const out = rankChatCandidates({ patientName: 'Maria Perez', groups, limit: 10 });
      const names = out.map(c => c.chatName);
      expect(names).toContain('Flia Maria Perez');
      expect(names).toContain('Prestadores Maria Perez');
    });
  });
});
