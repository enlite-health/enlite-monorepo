import {
  normalizeForMatch,
  toMatchTerms,
  scoreGroupName,
  rankChatCandidates,
  roleAffinity,
  orderCandidatesForRole,
  type ChatCandidate,
} from '../rankChatCandidates';
import type { PeriskopeGroupChat } from '@modules/notification';

function group(chatId: string, chatName: string | null, memberCount: number | null = 10): PeriskopeGroupChat {
  // `orgPhone` não participa do ranqueamento — ele só viaja até a tela para
  // responder "o nosso número está nesse grupo?".
  return { chatId, chatName, memberCount, orgPhone: '5491176360496@c.us' };
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
      expect(scoreGroupName([], 'Flia Perez')).toEqual({ score: 0, matchedTerms: [], contiguousBonus: false });
    });
    it('score 0 quando o grupo não tem nome', () => {
      expect(scoreGroupName(['perez'], null)).toEqual({ score: 0, matchedTerms: [], contiguousBonus: false });
    });
    it('score 0 quando o nome do grupo normaliza para vazio', () => {
      expect(scoreGroupName(['perez'], '!!!')).toEqual({ score: 0, matchedTerms: [], contiguousBonus: false });
    });
    it('score 0 quando nada bate', () => {
      expect(scoreGroupName(['perez'], 'Flia Gomez')).toEqual({ score: 0, matchedTerms: [], contiguousBonus: false });
    });
    it('meio termo batendo = 0.5', () => {
      const r = scoreGroupName(['maria', 'gomez'], 'Flia Maria Lopez');
      expect(r.score).toBe(0.5);
      expect(r.matchedTerms).toEqual(['maria']);
      expect(r.contiguousBonus).toBe(false);
    });
    it('nome inteiro contíguo: score continua sendo a cobertura de termos, e contiguousBonus fica marcado à parte', () => {
      // Achado de review 11/08: a versão antiga somava +0.25 ao score e
      // CLAMPAVA em 1 — como a cobertura de termos aqui já é 1, o clamp
      // escondia o bônus por completo (1.0 + 0.25 → min(1, 1.25) = 1, igual a
      // não ter bônus nenhum). Agora o bônus não entra na conta do score: vira
      // um campo separado, consumido como CRITÉRIO DE DESEMPATE em
      // rankChatCandidates — é isso que o próximo describe prova.
      const r = scoreGroupName(['maria', 'perez'], 'Flia Maria Perez - Prestadores');
      expect(r.score).toBe(1); // cobertura de termos: 2/2
      expect(r.matchedTerms).toEqual(['maria', 'perez']);
      expect(r.contiguousBonus).toBe(true);
    });
    it('mesmos termos fora de ordem NÃO ganham o bônus de contiguidade', () => {
      const espalhado = scoreGroupName(['maria', 'perez'], 'Perez, Maria');
      expect(espalhado.score).toBe(1); // já era 1 pela cobertura de termos
      expect(espalhado.contiguousBonus).toBe(false);
      const parcial = scoreGroupName(['maria', 'perez', 'lopez'], 'Perez Lopez');
      expect(parcial.score).toBeCloseTo(0.6667, 3); // 2/3, sem bônus
      expect(parcial.contiguousBonus).toBe(false);
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

    it('contiguousBonus DESEMPATA scores iguais ANTES do alfabeto (achado de review, 11/08)', () => {
      // "Zzz Maria Perez" contém "maria perez" CONTÍGUO; "Aaa Perez Maria" tem
      // os DOIS termos (mesmo score=1) mas em ordem trocada — não contíguo. Se
      // o bônus não desempatasse nada (o bug antigo: soma pré-clamp, sempre
      // saturado em 1 quando a cobertura já é 1), o alfabeto poria "Aaa..."
      // primeiro. Com o fix, o contíguo vence mesmo perdendo no alfabeto.
      const tied = [
        group('aaa@g.us', 'Aaa Perez Maria'),
        group('zzz@g.us', 'Zzz Maria Perez'),
      ];
      const out = rankChatCandidates({ patientName: 'Maria Perez', groups: tied, limit: 10 });

      expect(out.map(c => c.score)).toEqual([1, 1]); // scores EMPATADOS
      expect(out.map(c => c.chatId)).toEqual(['zzz@g.us', 'aaa@g.us']); // contíguo primeiro
      expect(out[0].contiguousBonus).toBe(true);
      expect(out[1].contiguousBonus).toBe(false);
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

// ── DESEMPATE POR PAPEL ──────────────────────────────────────────────────────

describe('roleAffinity / orderCandidatesForRole', () => {
  const FAMILY = { code: 'FAMILY', matchKeywords: ['flia', 'familia'] };
  const PROVIDERS = { code: 'PROVIDERS', matchKeywords: ['equipo', 'prestadores'] };
  const ROLES = [FAMILY, PROVIDERS];

  function candidate(chatId: string, chatName: string, score: number): ChatCandidate {
    return {
      chatId, chatName, memberCount: null, score, matchedTerms: [],
      linkedToOtherPatient: false, contiguousBonus: false,
    };
  }

  describe('roleAffinity', () => {
    it('1 quando o nome do grupo tem palavra DESTE papel', () => {
      expect(roleAffinity('Flia Perez', FAMILY, [PROVIDERS])).toBe(1);
      expect(roleAffinity('Equipo Perez', PROVIDERS, [FAMILY])).toBe(1);
    });

    it('-1 quando o nome se declara de OUTRO papel', () => {
      expect(roleAffinity('Equipo Perez', FAMILY, [PROVIDERS])).toBe(-1);
    });

    it('0 quando o nome não diz nada sobre papel', () => {
      expect(roleAffinity('Perez Maria', FAMILY, [PROVIDERS])).toBe(0);
    });

    it('nome com palavra DOS DOIS papéis fica com o papel perguntado (1 ganha do -1)', () => {
      // "Flia y equipo Perez" existe na base real. Rebaixá-lo seria pior: ele é
      // candidato legítimo para os dois, e quem escolhe é a pessoa.
      expect(roleAffinity('Flia y equipo Perez', FAMILY, [PROVIDERS])).toBe(1);
      expect(roleAffinity('Flia y equipo Perez', PROVIDERS, [FAMILY])).toBe(1);
    });

    it('ignora acento e caixa — as palavras do catálogo já vêm normalizadas', () => {
      expect(roleAffinity('FLIA. PÉREZ', FAMILY, [PROVIDERS])).toBe(1);
    });

    it('casa palavra INTEIRA, não pedaço — "familiar" não é "familia"', () => {
      // Pedaço casaria "prestadora de servicios" com PROVIDERS em qualquer
      // grupo; o desempate ficaria ruidoso sem ganhar precisão.
      expect(roleAffinity('Grupo familiar Perez', FAMILY, [PROVIDERS])).toBe(0);
    });

    it('nome nulo e papel sem palavras nenhuma → 0', () => {
      expect(roleAffinity(null, FAMILY, [PROVIDERS])).toBe(0);
      expect(roleAffinity('Flia Perez', { code: 'X', matchKeywords: [] }, [])).toBe(0);
    });
  });

  describe('orderCandidatesForRole', () => {
    const flia = candidate('1@g.us', 'Flia Perez', 1);
    const equipo = candidate('2@g.us', 'Equipo Perez', 1);

    it('resolve o EMPATE a favor do papel perguntado', () => {
      // Sem isto, localeCompare põe "Equipo" antes de "Flia" nos dois seletores.
      expect(orderCandidatesForRole([flia, equipo], FAMILY, ROLES).map(c => c.chatId)).toEqual([
        '1@g.us', '2@g.us',
      ]);
      expect(orderCandidatesForRole([flia, equipo], PROVIDERS, ROLES).map(c => c.chatId)).toEqual([
        '2@g.us', '1@g.us',
      ]);
    });

    it('NUNCA reordena scores diferentes — a invariante que protege o top 3', () => {
      // Um grupo de "flia" de OUTRO paciente (score menor) não pode subir acima
      // do grupo certo deste paciente só porque tem a palavra certa.
      const certo = candidate('1@g.us', 'Perez Maria', 1);
      const fliaAlheia = candidate('9@g.us', 'Flia Gomez', 0.4);

      expect(
        orderCandidatesForRole([certo, fliaAlheia], FAMILY, ROLES).map(c => c.chatId),
      ).toEqual(['1@g.us', '9@g.us']);
    });

    it('a sequência de scores é a MESMA antes e depois — prova estrutural da invariante', () => {
      const list = [
        candidate('a@g.us', 'Equipo Perez', 1),
        candidate('b@g.us', 'Flia Perez', 1),
        candidate('c@g.us', 'Perez', 0.6),
        candidate('d@g.us', 'Flia Perez Jr', 0.6),
        candidate('e@g.us', 'Gomez', 0.2),
      ];
      const before = list.map(c => c.score);
      const after = orderCandidatesForRole(list, FAMILY, ROLES).map(c => c.score);
      expect(after).toEqual(before);
    });

    it('mantém a lista inteira — desempate reordena, não filtra', () => {
      const list = [flia, equipo, candidate('3@g.us', 'Perez', 0.5)];
      const out = orderCandidatesForRole(list, FAMILY, ROLES);
      expect(out).toHaveLength(3);
      expect(out.map(c => c.chatId).sort()).toEqual(['1@g.us', '2@g.us', '3@g.us']);
    });

    it('não muta a lista recebida', () => {
      const list = [equipo, flia];
      orderCandidatesForRole(list, FAMILY, ROLES);
      expect(list.map(c => c.chatId)).toEqual(['2@g.us', '1@g.us']);
    });

    it('empate sem afinidade nenhuma cai no alfabeto — ordem estável e reproduzível', () => {
      const a = candidate('a@g.us', 'Perez A', 1);
      const b = candidate('b@g.us', 'Perez B', 1);
      expect(orderCandidatesForRole([b, a], FAMILY, ROLES).map(c => c.chatId)).toEqual([
        'a@g.us', 'b@g.us',
      ]);
    });

    it('papel único no catálogo: sem "outro" para rebaixar, ninguém leva -1', () => {
      const out = orderCandidatesForRole([equipo, flia], FAMILY, [FAMILY]);
      expect(out.map(c => c.chatId)).toEqual(['1@g.us', '2@g.us']);
    });

    it('lista vazia devolve lista vazia', () => {
      expect(orderCandidatesForRole([], FAMILY, ROLES)).toEqual([]);
    });
  });
});
