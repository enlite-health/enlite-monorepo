import {
  patientChatIdsSchema,
  patientChatCandidatesQuerySchema,
} from '../patientChatIdsSchema';

const GROUP_A = '120363001111111111@g.us';
const GROUP_B = '5491112345678-1600000000@g.us';

describe('patientChatIdsSchema', () => {
  it('aceita o par de grupos', () => {
    const r = patientChatIdsSchema.safeParse({ familyChatId: GROUP_A, providersChatId: GROUP_B });
    expect(r.success).toBe(true);
  });

  it('aceita null nos dois (desvincular)', () => {
    expect(patientChatIdsSchema.safeParse({ familyChatId: null, providersChatId: null }).success).toBe(true);
  });

  it('apara espaços das pontas', () => {
    const r = patientChatIdsSchema.safeParse({ familyChatId: `  ${GROUP_A}  `, providersChatId: null });
    expect(r.success && r.data.familyChatId).toBe(GROUP_A);
  });

  it('RECUSA conversa 1-1 (@c.us) — a trava que a task pede', () => {
    const r = patientChatIdsSchema.safeParse({ familyChatId: '5491162180721@c.us', providersChatId: null });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('@g.us');
  });

  it.each([
    ['sem sufixo', '120363001234567890'],
    ['letras', 'abc@g.us'],
    ['vazio', ''],
    ['só sufixo', '@g.us'],
  ])('recusa %s', (_l, value) => {
    expect(patientChatIdsSchema.safeParse({ familyChatId: value, providersChatId: null }).success).toBe(false);
  });

  it('recusa acima de 64 caracteres (tamanho da coluna)', () => {
    const tooLong = `${'1'.repeat(64)}@g.us`;
    expect(patientChatIdsSchema.safeParse({ familyChatId: tooLong, providersChatId: null }).success).toBe(false);
  });

  it('recusa o MESMO grupo nos dois papéis', () => {
    const r = patientChatIdsSchema.safeParse({ familyChatId: GROUP_A, providersChatId: GROUP_A });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['providersChatId']);
  });

  it('campo desconhecido é 400, não no-op silencioso', () => {
    const r = patientChatIdsSchema.safeParse({ familyChatId: null, providersChatId: null, foo: 'x' });
    expect(r.success).toBe(false);
  });

  it('campo faltando é rejeitado — a tela grava o par inteiro', () => {
    expect(patientChatIdsSchema.safeParse({ familyChatId: GROUP_A }).success).toBe(false);
  });

  it('tipo errado é rejeitado', () => {
    expect(patientChatIdsSchema.safeParse({ familyChatId: 123, providersChatId: null }).success).toBe(false);
  });
});

describe('patientChatCandidatesQuerySchema', () => {
  it('limit ausente é válido', () => {
    expect(patientChatCandidatesQuerySchema.safeParse({}).success).toBe(true);
  });

  it('coage string para número', () => {
    const r = patientChatCandidatesQuerySchema.safeParse({ limit: '25' });
    expect(r.success && r.data.limit).toBe(25);
  });

  it.each([['0', 0], ['51', 51], ['negativo', -1], ['fracionário', 1.5], ['texto', 'abc']])(
    'recusa limit %s',
    (_l, limit) => {
      expect(patientChatCandidatesQuerySchema.safeParse({ limit }).success).toBe(false);
    },
  );

  it('aceita as bordas 1 e 50', () => {
    expect(patientChatCandidatesQuerySchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(patientChatCandidatesQuerySchema.safeParse({ limit: 50 }).success).toBe(true);
  });
});
