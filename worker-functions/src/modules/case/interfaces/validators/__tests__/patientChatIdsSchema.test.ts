import {
  patientChatIdsSchema,
  patientChatCandidatesQuerySchema,
  patientChatMapQuerySchema,
} from '../patientChatIdsSchema';
import { PATIENT_CHAT_ROLE_MAX_LENGTH } from '../../../domain/PatientChatRole';

const GROUP_A = '120363001111111111@g.us';
const GROUP_B = '5491112345678-1600000000@g.us';
const GROUP_C = '120363003333333333@g.us';

describe('patientChatIdsSchema — contrato NOVO (mapa por papel)', () => {
  it('aceita os três papéis do catálogo de uma vez', () => {
    const r = patientChatIdsSchema.safeParse({
      chatIds: { FAMILY: GROUP_A, PROVIDERS: GROUP_B, HEALTH_PLAN: GROUP_C },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({ FAMILY: GROUP_A, PROVIDERS: GROUP_B, HEALTH_PLAN: GROUP_C });
  });

  it('aceita um papel só — os ausentes ficam INALTERADOS, não são apagados', () => {
    const r = patientChatIdsSchema.safeParse({ chatIds: { HEALTH_PLAN: GROUP_A } });
    expect(r.success && r.data).toEqual({ HEALTH_PLAN: GROUP_A });
    expect(r.success && Object.keys(r.data)).not.toContain('FAMILY');
  });

  it('null desvincula', () => {
    const r = patientChatIdsSchema.safeParse({ chatIds: { FAMILY: null, PROVIDERS: null } });
    expect(r.success && r.data).toEqual({ FAMILY: null, PROVIDERS: null });
  });

  it('mapa vazio é válido (no-op explícito)', () => {
    const r = patientChatIdsSchema.safeParse({ chatIds: {} });
    expect(r.success && r.data).toEqual({});
  });

  it('aceita papel que NÃO existe em código — o vocabulário é dado, não schema', () => {
    // Esta é a prova de que criar um papel na tela não exige deploy: o schema
    // valida a FORMA da chave e nada mais. Quem confere o vocabulário contra o
    // catálogo é o serviço, que devolve UNKNOWN_CHAT_ROLE.
    for (const role of ['FAMILY', 'PROVIDERS', 'HEALTH_PLAN', 'MANAGEMENT', 'OBRA_SOCIAL_2']) {
      expect(patientChatIdsSchema.safeParse({ chatIds: { [role]: GROUP_A } }).success).toBe(true);
    }
  });

  it.each([
    ['minúsculo', 'family'],
    ['com espaço', 'HEALTH PLAN'],
    ['com hífen', 'HEALTH-PLAN'],
    ['começando com dígito', '1FAMILY'],
    ['acento', 'FAMÍLIA'],
  ])('recusa chave de papel %s — a FORMA continua sendo lei', (_l, role) => {
    expect(patientChatIdsSchema.safeParse({ chatIds: { [role]: GROUP_A } }).success).toBe(false);
  });

  it('recusa código de papel maior que a coluna do banco', () => {
    const tooLong = 'A'.repeat(PATIENT_CHAT_ROLE_MAX_LENGTH + 1);
    expect(patientChatIdsSchema.safeParse({ chatIds: { [tooLong]: GROUP_A } }).success).toBe(false);
  });

  it('apara espaços das pontas', () => {
    const r = patientChatIdsSchema.safeParse({ chatIds: { FAMILY: `  ${GROUP_A}  ` } });
    expect(r.success && r.data.FAMILY).toBe(GROUP_A);
  });

  it('RECUSA conversa 1-1 (@c.us) — a trava que a task pede', () => {
    const r = patientChatIdsSchema.safeParse({ chatIds: { FAMILY: '5491162180721@c.us' } });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('@g.us');
  });

  it.each([
    ['sem sufixo', '120363001234567890'],
    ['letras', 'abc@g.us'],
    ['vazio', ''],
    ['só sufixo', '@g.us'],
  ])('recusa %s', (_l, value) => {
    expect(patientChatIdsSchema.safeParse({ chatIds: { FAMILY: value } }).success).toBe(false);
  });

  it('recusa acima de 64 caracteres (tamanho da coluna)', () => {
    const tooLong = `${'1'.repeat(64)}@g.us`;
    expect(patientChatIdsSchema.safeParse({ chatIds: { FAMILY: tooLong } }).success).toBe(false);
  });

  it('o VOCABULÁRIO não é conferido aqui — quem recusa papel inexistente é o serviço', () => {
    // Regressão de fronteira: se alguém trouxer a lista de papéis de volta para
    // o schema, papel criado na tela passa a exigir deploy outra vez. A recusa
    // existe (UNKNOWN_CHAT_ROLE), mas mora no PatientChatIdsService, que lê o
    // catálogo do banco — ver PatientChatIdsService.test.ts.
    expect(patientChatIdsSchema.safeParse({ chatIds: { NEIGHBOURS: GROUP_A } }).success).toBe(true);
    // A FORMA continua sendo lei: minúsculo não é código de papel.
    expect(patientChatIdsSchema.safeParse({ chatIds: { family: GROUP_A } }).success).toBe(false);
  });

  it('recusa o MESMO grupo em dois papéis, apontando o segundo', () => {
    const r = patientChatIdsSchema.safeParse({ chatIds: { FAMILY: GROUP_A, PROVIDERS: GROUP_A } });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(['PROVIDERS']);
      expect(r.error.issues[0].message).toContain('FAMILY');
    }
  });

  it('dois papéis com null NÃO contam como grupo repetido', () => {
    expect(
      patientChatIdsSchema.safeParse({ chatIds: { FAMILY: null, PROVIDERS: null, HEALTH_PLAN: null } }).success,
    ).toBe(true);
  });

  it('campo desconhecido no topo é 400', () => {
    expect(patientChatIdsSchema.safeParse({ chatIds: {}, foo: 'x' }).success).toBe(false);
  });

  it('body vazio é 400 — não casa com nenhum dos dois contratos', () => {
    expect(patientChatIdsSchema.safeParse({}).success).toBe(false);
  });

  it('tipo errado é rejeitado', () => {
    expect(patientChatIdsSchema.safeParse({ chatIds: { FAMILY: 123 } }).success).toBe(false);
    expect(patientChatIdsSchema.safeParse({ chatIds: 'x' }).success).toBe(false);
  });
});

describe('patientChatIdsSchema — contrato LEGADO (migration 260)', () => {
  it('traduz { familyChatId, providersChatId } para FAMILY/PROVIDERS', () => {
    const r = patientChatIdsSchema.safeParse({ familyChatId: GROUP_A, providersChatId: GROUP_B });
    expect(r.success && r.data).toEqual({ FAMILY: GROUP_A, PROVIDERS: GROUP_B });
  });

  it('null legado desvincula', () => {
    const r = patientChatIdsSchema.safeParse({ familyChatId: null, providersChatId: null });
    expect(r.success && r.data).toEqual({ FAMILY: null, PROVIDERS: null });
  });

  it('o legado NÃO toca no HEALTH_PLAN — bundle antigo não apaga o que não conhece', () => {
    const r = patientChatIdsSchema.safeParse({ familyChatId: GROUP_A, providersChatId: null });
    expect(r.success && Object.keys(r.data).sort()).toEqual(['FAMILY', 'PROVIDERS']);
  });

  it('legado com campo faltando é 400 (lá o par era obrigatório)', () => {
    expect(patientChatIdsSchema.safeParse({ familyChatId: GROUP_A }).success).toBe(false);
  });

  it('legado com @c.us é 400', () => {
    expect(
      patientChatIdsSchema.safeParse({ familyChatId: '5491162180721@c.us', providersChatId: null }).success,
    ).toBe(false);
  });

  it('legado com o mesmo grupo nos dois papéis é 400', () => {
    expect(
      patientChatIdsSchema.safeParse({ familyChatId: GROUP_A, providersChatId: GROUP_A }).success,
    ).toBe(false);
  });

  it('legado + campo desconhecido é 400', () => {
    expect(
      patientChatIdsSchema.safeParse({ familyChatId: null, providersChatId: null, foo: 'x' }).success,
    ).toBe(false);
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

describe('patientChatMapQuerySchema', () => {
  const GROUP = '120363001111111111@g.us';

  it('query vazia é válida (usa os defaults do use case)', () => {
    const r = patientChatMapQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({});
  });

  it.each(['linked', 'unlinked', 'all'])('aceita filter=%s', filter => {
    expect(patientChatMapQuerySchema.safeParse({ filter }).success).toBe(true);
  });

  it('recusa filter fora do enum', () => {
    expect(patientChatMapQuerySchema.safeParse({ filter: 'todos' }).success).toBe(false);
  });

  it('aceita chatId de GRUPO e coage limit/offset', () => {
    const r = patientChatMapQuerySchema.safeParse({ chatId: GROUP, limit: '250', offset: '10' });
    expect(r.success && r.data).toEqual({ chatId: GROUP, limit: 250, offset: 10 });
  });

  it('recusa chatId 1-1 (@c.us) — só grupo é vínculo de paciente', () => {
    expect(patientChatMapQuerySchema.safeParse({ chatId: '5491162180721@c.us' }).success).toBe(false);
  });

  it.each([['0', 0], ['acima do teto', 1001], ['fracionário', 2.5]])(
    'recusa limit %s',
    (_l, limit) => {
      expect(patientChatMapQuerySchema.safeParse({ limit }).success).toBe(false);
    },
  );

  it('aceita as bordas 1 e 1000 de limit, e offset 0', () => {
    expect(patientChatMapQuerySchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(patientChatMapQuerySchema.safeParse({ limit: 1000 }).success).toBe(true);
    expect(patientChatMapQuerySchema.safeParse({ offset: 0 }).success).toBe(true);
  });

  it('recusa offset negativo', () => {
    expect(patientChatMapQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  it('campo desconhecido é 400, não no-op silencioso', () => {
    expect(patientChatMapQuerySchema.safeParse({ foo: 'x' }).success).toBe(false);
  });
});
