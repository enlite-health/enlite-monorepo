/**
 * deriveFunnelStage.test.ts
 *
 * Testa a lógica de derivação de funnel stage (migration 230):
 * - subtype='INITIATED' (Talentum webhook) → 'PRE_SCREENING' (canônico interno)
 * - Zod NÃO foi alterado: webhook ainda aceita 'INITIATED' como subtype
 * - Outros subtypes inalterados
 *
 * Cenários do spec:
 *   3. deriveFunnelStage(subtype='INITIATED') === 'PRE_SCREENING'. Zod ainda aceita 'INITIATED' como subtype.
 */

import { ProcessTalentumPrescreening } from '../ProcessTalentumPrescreening';
import { TalentumPrescreeningResponseParsed } from '@modules/integration';

function makePayload(subtype: string, statusLabel?: string): TalentumPrescreeningResponseParsed {
  return {
    action: 'PRESCREENING_RESPONSE',
    subtype: subtype as 'INITIATED' | 'IN_PROGRESS' | 'COMPLETED' | 'ANALYZED',
    data: {
      prescreening: { id: 'tp-test', name: 'Caso Test' },
      profile: {
        id: 'prof-test',
        firstName: 'Ana',
        lastName: 'Test',
        email: 'ana@test.com',
        phoneNumber: '+5491100001111',
        registerQuestions: [],
      },
      response: {
        id: 'resp-test',
        state: [],
        score: 80,
        statusLabel: statusLabel as 'QUALIFIED' | 'NOT_QUALIFIED' | 'IN_DOUBT' | 'PENDING' | undefined,
      },
    },
  };
}

// Instanciar via cast para acessar o método (agora public para testabilidade)
function getUseCase(): ProcessTalentumPrescreening {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (ProcessTalentumPrescreening as any)(
    {}, {}, {}, { connect: jest.fn(), query: jest.fn() }, { publish: jest.fn() },
  );
}

describe('deriveFunnelStage — migration 230', () => {
  let useCase: ProcessTalentumPrescreening;

  beforeEach(() => {
    useCase = getUseCase();
  });

  it('subtype=INITIATED → PRE_SCREENING (conversão interna — Zod NÃO alterado)', () => {
    // O Talentum ainda envia subtype='INITIATED' no webhook.
    // deriveFunnelStage converte internamente para PRE_SCREENING antes de gravar na WJA.
    const payload = makePayload('INITIATED');
    (payload.data.response as any).statusLabel = undefined;

    expect(useCase.deriveFunnelStage(payload)).toBe('PRE_SCREENING');
  });

  it('subtype=IN_PROGRESS → IN_PROGRESS (inalterado)', () => {
    const payload = makePayload('IN_PROGRESS');
    (payload.data.response as any).statusLabel = undefined;
    expect(useCase.deriveFunnelStage(payload)).toBe('IN_PROGRESS');
  });

  it('subtype=COMPLETED → COMPLETED (inalterado)', () => {
    const payload = makePayload('COMPLETED');
    (payload.data.response as any).statusLabel = undefined;
    expect(useCase.deriveFunnelStage(payload)).toBe('COMPLETED');
  });

  it('subtype=ANALYZED + statusLabel=QUALIFIED → QUALIFIED', () => {
    const payload = makePayload('ANALYZED', 'QUALIFIED');
    expect(useCase.deriveFunnelStage(payload)).toBe('QUALIFIED');
  });

  it('subtype=ANALYZED + statusLabel=NOT_QUALIFIED → NOT_QUALIFIED', () => {
    const payload = makePayload('ANALYZED', 'NOT_QUALIFIED');
    expect(useCase.deriveFunnelStage(payload)).toBe('NOT_QUALIFIED');
  });

  it('subtype=ANALYZED + statusLabel=IN_DOUBT → IN_DOUBT', () => {
    const payload = makePayload('ANALYZED', 'IN_DOUBT');
    expect(useCase.deriveFunnelStage(payload)).toBe('IN_DOUBT');
  });

  it('subtype=ANALYZED + statusLabel=PENDING → ANALYZED (sentinel local — pula upsert WJA)', () => {
    const payload = makePayload('ANALYZED', 'PENDING');
    expect(useCase.deriveFunnelStage(payload)).toBe('ANALYZED');
  });

  it('subtype=ANALYZED sem statusLabel → ANALYZED (sentinel — pula upsert WJA)', () => {
    const payload = makePayload('ANALYZED');
    (payload.data.response as any).statusLabel = undefined;
    expect(useCase.deriveFunnelStage(payload)).toBe('ANALYZED');
  });

  it('Zod ainda aceita INITIATED como subtype válido (NÃO foi alterado — regra dura)', () => {
    // Prova: o schema Zod do webhook está em talentumPrescreeningSchema.ts.
    // Este teste importa diretamente o schema para confirmar que 'INITIATED' ainda é aceito.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TalentumPrescreeningPayloadSchema } = require('@modules/integration/interfaces/webhooks/validators/talentumPrescreeningSchema');

    const validPayload = {
      action: 'PRESCREENING_RESPONSE',
      subtype: 'INITIATED',
      data: {
        prescreening: { id: 'tp-1', name: 'CASO 1' },
        profile: {
          id: 'pr-1', firstName: 'X', lastName: 'Y',
          email: 'x@test.com', phoneNumber: '+5491100001111',
          registerQuestions: [],
        },
        response: {
          id: 'r-1', state: [], score: 0, statusLabel: undefined,
        },
      },
    };

    const result = TalentumPrescreeningPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subtype).toBe('INITIATED');
    }
  });
});
