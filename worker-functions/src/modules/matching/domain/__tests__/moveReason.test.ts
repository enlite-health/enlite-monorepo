import {
  requiredMoveReason,
  isAllowedMoveReason,
  ALL_MOVE_REASONS,
  MOVE_REASONS_BY_KIND,
  JUMP_REASONS,
  LEAVE_REJECTED_REASONS,
  MoveReasonRequiredError,
  MoveReasonInvalidError,
  type MoveReasonKind,
  type MoveOrigin,
} from '../moveReason';
import { REJECTION_REASON_CATEGORIES } from '../Encuadre';

/**
 * requiredMoveReason — a regra do motivo no arrasto do quadro B (Fase 4, DX-4.6).
 * A tabela abaixo cobre TODA combinação origem × destino droppable
 * (execucao/fase-4.md:428-430): as 10 etapas do CHECK (migration 477) + o par
 * INVITED/manual (INICIADO) + origem nula, contra os 10 destinos que a API aceita.
 * O esperado de cada célula foi ESCRITO À MÃO a partir da regra da DX-4.6 (posição no
 * quadro B — VACANCY_BOARD_COLUMNS/boardPosition de kanbanColumn.ts, confirmadas em
 * kanbanColumn.test.ts) — nenhuma célula chama requiredMoveReason nem boardPosition
 * para se calcular.
 */
describe('requiredMoveReason', () => {
  const ORIGINS: ReadonlyArray<{ label: string; from: MoveOrigin | null }> = [
    { label: 'nula (candidatura nova) — posição 0, como INVITED', from: null },
    { label: 'INVITED (auto-invite) — posição 0', from: { stage: 'INVITED', source: 'talentum' } },
    { label: 'INVITED+manual (INICIADO) — posição 1', from: { stage: 'INVITED', source: 'manual' } },
    { label: 'PRE_SCREENING — posição 2', from: { stage: 'PRE_SCREENING', source: 'talentum' } },
    { label: 'IN_PROGRESS — posição 2 (mesma de PRE_SCREENING)', from: { stage: 'IN_PROGRESS', source: 'talentum' } },
    { label: 'COMPLETED — posição 3', from: { stage: 'COMPLETED', source: 'talentum' } },
    { label: 'QUALIFIED — posição 3 (colapsa em COMPLETED)', from: { stage: 'QUALIFIED', source: 'talentum' } },
    { label: 'IN_DOUBT — posição 3 (colapsa em COMPLETED)', from: { stage: 'IN_DOUBT', source: 'talentum' } },
    { label: 'CONFIRMED — posição 4', from: { stage: 'CONFIRMED', source: 'talentum' } },
    { label: 'SELECTED — posição 5', from: { stage: 'SELECTED', source: 'talentum' } },
    { label: 'QUICK_RESPONSE_TEAM — posição 6', from: { stage: 'QUICK_RESPONSE_TEAM', source: 'talentum' } },
    { label: 'REJECTED — posição 7', from: { stage: 'REJECTED', source: 'talentum' } },
  ];

  // Destinos droppable que a API aceita (execucao/fase-4.md:429), na ordem em que
  // aparecem nas colunas da matriz EXPECTED abaixo.
  const DESTINATIONS = [
    'INVITED', // posição 0
    'PRE_SCREENING', // posição 2
    'IN_PROGRESS', // posição 2
    'COMPLETED', // posição 3
    'QUALIFIED', // posição 3
    'IN_DOUBT', // posição 3
    'CONFIRMED', // posição 4
    'SELECTED', // posição 5
    'REJECTED', // posição 7
    'QUICK_RESPONSE_TEAM', // posição 6
  ] as const;

  const J: MoveReasonKind = 'JUMP';
  const ER: MoveReasonKind = 'ENTER_REJECTED';
  const LR: MoveReasonKind = 'LEAVE_REJECTED';

  // Uma linha por ORIGEM (mesma ordem de ORIGINS), uma coluna por DESTINO (mesma
  // ordem de DESTINATIONS). Ver o raciocínio linha a linha no corpo do PR — cada
  // célula é: (a) `null` se stage igual; (b) LR se origem é REJECTED (e destino
  // diferente); (c) ER se destino é REJECTED (e origem diferente); (d) JUMP se
  // posição(destino) - posição(origem) > 1; (e) `null` no resto (recuo ou +1).
  const EXPECTED: ReadonlyArray<ReadonlyArray<MoveReasonKind | null>> = [
    /* nula                */ [null, J, J, J, J, J, J, J, ER, J],
    /* INVITED             */ [null, J, J, J, J, J, J, J, ER, J],
    /* INVITED+manual      */ [null, null, null, J, J, J, J, J, ER, J],
    /* PRE_SCREENING       */ [null, null, null, null, null, null, J, J, ER, J],
    /* IN_PROGRESS         */ [null, null, null, null, null, null, J, J, ER, J],
    /* COMPLETED           */ [null, null, null, null, null, null, null, J, ER, J],
    /* QUALIFIED           */ [null, null, null, null, null, null, null, J, ER, J],
    /* IN_DOUBT            */ [null, null, null, null, null, null, null, J, ER, J],
    /* CONFIRMED           */ [null, null, null, null, null, null, null, null, ER, J],
    /* SELECTED            */ [null, null, null, null, null, null, null, null, ER, null],
    /* QUICK_RESPONSE_TEAM */ [null, null, null, null, null, null, null, null, ER, null],
    /* REJECTED            */ [LR, LR, LR, LR, LR, LR, LR, LR, null, LR],
  ];

  for (const [i, origin] of ORIGINS.entries()) {
    describe(`origem: ${origin.label}`, () => {
      for (const [j, toStage] of DESTINATIONS.entries()) {
        const expected = EXPECTED[i][j];
        it(`→ ${toStage} = ${expected ?? 'null (sem motivo)'}`, () => {
          expect(requiredMoveReason(origin.from, toStage)).toBe(expected);
        });
      }
    });
  }

  // Os quatro casos de salto que a Q-4.1 nomeia (execucao/fase-4.md:232-235,
  // decisão do orquestrador para o P6) — chamados diretamente, fora da matriz, para
  // que o comportamento fique nomeado no relatório de teste.
  describe('os 4 casos de salto nomeados na Q-4.1', () => {
    it('Invitados → Confirmados = JUMP', () => {
      expect(requiredMoveReason({ stage: 'INVITED', source: 'talentum' }, 'CONFIRMED')).toBe('JUMP');
    });

    it('Iniciados → Confirmados = JUMP', () => {
      expect(requiredMoveReason({ stage: 'INVITED', source: 'manual' }, 'CONFIRMED')).toBe('JUMP');
    });

    it('Completado → Seleccionados = JUMP', () => {
      expect(requiredMoveReason({ stage: 'COMPLETED', source: 'talentum' }, 'SELECTED')).toBe('JUMP');
    });

    it('Confirmados → Equipo de Respuesta Rápida = JUMP', () => {
      expect(requiredMoveReason({ stage: 'CONFIRMED', source: 'talentum' }, 'QUICK_RESPONSE_TEAM')).toBe('JUMP');
    });
  });

  // Os que a fase NÃO pede motivo, nomeados (execucao/fase-4.md:106-107).
  describe('os que NÃO pedem motivo, nomeados', () => {
    it('Confirmados → Seleccionados = null (só 1 posição à frente, não é salto)', () => {
      expect(requiredMoveReason({ stage: 'CONFIRMED', source: 'talentum' }, 'SELECTED')).toBeNull();
    });

    it('Seleccionados → Equipo de Respuesta Rápida = null (só 1 posição à frente, não é salto)', () => {
      expect(requiredMoveReason({ stage: 'SELECTED', source: 'talentum' }, 'QUICK_RESPONSE_TEAM')).toBeNull();
    });

    it('todo recuo = null, por maior que seja a distância (ex.: REJECTED-like far-forward não se aplica a recuo; aqui SELECTED → INVITED)', () => {
      expect(requiredMoveReason({ stage: 'SELECTED', source: 'talentum' }, 'INVITED')).toBeNull();
      expect(requiredMoveReason({ stage: 'QUICK_RESPONSE_TEAM', source: 'talentum' }, 'PRE_SCREENING')).toBeNull();
    });

    it('etapa igual = null, mesmo com fontes diferentes (a comparação é só pelo stage)', () => {
      expect(requiredMoveReason({ stage: 'INVITED', source: 'talentum' }, 'INVITED')).toBeNull();
      expect(requiredMoveReason({ stage: 'INVITED', source: 'manual' }, 'INVITED')).toBeNull();
      expect(requiredMoveReason({ stage: 'REJECTED', source: 'talentum' }, 'REJECTED')).toBeNull();
    });
  });

  it('origem REJECTED para REJECTED (recategorizar) não exige motivo — o comportamento de hoje fica intacto', () => {
    expect(requiredMoveReason({ stage: 'REJECTED', source: 'talentum' }, 'REJECTED')).toBeNull();
  });
});

/**
 * `ALL_MOVE_REASONS` é a União das três listas — TEM que bater com o literal do CHECK
 * `wjash_reason_category_check` da migration 478
 * (`MIG/478_stage_history_reason_category.sql:36-47`), copiado à mão aqui (não lido do
 * arquivo, não recalculado por `moveReason.ts`) para que o teste morra se uma lista
 * mudar sem migration.
 */
describe('ALL_MOVE_REASONS', () => {
  // Literal do CHECK da migration 478, linha a linha.
  const CHECK_478_LITERAL = [
    'ENCUADRE_ANTECIPADO',
    'REAPROVEITADO_DE_OUTRA_VAGA',
    'INDICACAO_DA_EQUIPE',
    'DISTANCE',
    'SCHEDULE_INCOMPATIBLE',
    'INSUFFICIENT_EXPERIENCE',
    'SALARY_EXPECTATION',
    'WORKER_DECLINED',
    'OVERQUALIFIED',
    'DEPENDENCY_MISMATCH',
    'TALENTUM_NOT_QUALIFIED',
    'REAVALIACAO',
    'REJEITADO_POR_ENGANO',
    'OTHER',
  ];

  it('tem exatamente os 14 valores do CHECK da migration 478 (sem repetição)', () => {
    expect(ALL_MOVE_REASONS).toHaveLength(14);
    expect(new Set(ALL_MOVE_REASONS).size).toBe(14);
    expect([...ALL_MOVE_REASONS].sort()).toEqual([...CHECK_478_LITERAL].sort());
  });

  it('OTHER aparece uma única vez, mesmo estando em JUMP e em LEAVE_REJECTED', () => {
    expect(ALL_MOVE_REASONS.filter((r) => r === 'OTHER')).toHaveLength(1);
  });
});

describe('MOVE_REASONS_BY_KIND', () => {
  it('JUMP é a lista de salto (DX-4.4)', () => {
    expect(MOVE_REASONS_BY_KIND.JUMP).toBe(JUMP_REASONS);
    expect(MOVE_REASONS_BY_KIND.JUMP).toEqual([
      'ENCUADRE_ANTECIPADO',
      'REAPROVEITADO_DE_OUTRA_VAGA',
      'INDICACAO_DA_EQUIPE',
      'OTHER',
    ]);
  });

  it('ENTER_REJECTED REUSA REJECTION_REASON_CATEGORIES de Encuadre.ts, sem cópia', () => {
    expect(MOVE_REASONS_BY_KIND.ENTER_REJECTED).toBe(REJECTION_REASON_CATEGORIES);
  });

  it('LEAVE_REJECTED é a lista de saída de Rejeitados (DX-4.4)', () => {
    expect(MOVE_REASONS_BY_KIND.LEAVE_REJECTED).toBe(LEAVE_REJECTED_REASONS);
    expect(MOVE_REASONS_BY_KIND.LEAVE_REJECTED).toEqual(['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER']);
  });
});

describe('isAllowedMoveReason', () => {
  it('aceita uma categoria da lista do kind', () => {
    expect(isAllowedMoveReason('JUMP', 'ENCUADRE_ANTECIPADO')).toBe(true);
    expect(isAllowedMoveReason('ENTER_REJECTED', 'DISTANCE')).toBe(true);
    expect(isAllowedMoveReason('LEAVE_REJECTED', 'REAVALIACAO')).toBe(true);
  });

  it('recusa categoria de outro kind (motivo de salto usado para entrar em Rejeitados)', () => {
    expect(isAllowedMoveReason('ENTER_REJECTED', 'ENCUADRE_ANTECIPADO')).toBe(false);
    expect(isAllowedMoveReason('JUMP', 'DISTANCE')).toBe(false);
  });

  it('recusa ausência, null, undefined e tipo não-string', () => {
    expect(isAllowedMoveReason('JUMP', undefined)).toBe(false);
    expect(isAllowedMoveReason('JUMP', null)).toBe(false);
    expect(isAllowedMoveReason('JUMP', 42)).toBe(false);
    expect(isAllowedMoveReason('JUMP', '')).toBe(false);
  });

  it('OTHER é aceito nos três kinds', () => {
    expect(isAllowedMoveReason('JUMP', 'OTHER')).toBe(true);
    expect(isAllowedMoveReason('ENTER_REJECTED', 'OTHER')).toBe(true);
    expect(isAllowedMoveReason('LEAVE_REJECTED', 'OTHER')).toBe(true);
  });
});

describe('MoveReasonRequiredError / MoveReasonInvalidError', () => {
  it('carregam o kind e um nome de classe distinto (o controller usa para montar o 422)', () => {
    const required = new MoveReasonRequiredError('JUMP');
    expect(required.kind).toBe('JUMP');
    expect(required.name).toBe('MoveReasonRequiredError');
    expect(required).toBeInstanceOf(Error);

    const invalid = new MoveReasonInvalidError('ENTER_REJECTED');
    expect(invalid.kind).toBe('ENTER_REJECTED');
    expect(invalid.name).toBe('MoveReasonInvalidError');
    expect(invalid).toBeInstanceOf(Error);
  });
});
