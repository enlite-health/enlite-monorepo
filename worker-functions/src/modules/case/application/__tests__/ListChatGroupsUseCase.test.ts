import {
  ListChatGroupsUseCase,
  DEFAULT_GROUP_PAGE_SIZE,
  MAX_GROUP_PAGE_SIZE,
} from '../ListChatGroupsUseCase';
import type { PatientChatIdsRepository } from '../../infrastructure/PatientChatIdsRepository';
import type { PeriskopeChatReadService } from '@modules/notification';

jest.mock('../../infrastructure/PatientChatIdsRepository', () => ({
  PatientChatIdsRepository: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@modules/notification', () => ({
  PeriskopeChatReadService: jest.fn().mockImplementation(() => ({})),
}));

const PHONE_1 = '5491176360496@c.us';
const PHONE_2 = '5491127671720@c.us';

function group(chatId: string, chatName: string | null, orgPhone = PHONE_1, memberCount = 10) {
  return { chatId, chatName, memberCount, orgPhone };
}

/**
 * O caso real que motivou esta lista: os grupos de gestión são nomeados pelo
 * PAGADOR, não pelo paciente — por isso nunca apareciam no ranqueamento.
 */
const GROUPS = [
  group('1@g.us', 'Gestión: EnLite <> DAS'),
  group('2@g.us', 'Gestión: EnLite <> OSPJN'),
  group('3@g.us', 'Flia Perez'),
  group('4@g.us', 'Equipo Perez'),
  group('5@g.us', 'Grupo sem dono', PHONE_2),
];

function periskopeMock(groups: unknown = GROUPS, truncated = false) {
  return {
    listGroupChats: jest.fn().mockResolvedValue(
      groups === null ? null : { groups, truncated },
    ),
  } as unknown as PeriskopeChatReadService;
}

function repoMock(usage: Record<string, number> = {}) {
  return {
    countPatientsByChatIds: jest.fn().mockResolvedValue(usage),
  } as unknown as PatientChatIdsRepository;
}

describe('ListChatGroupsUseCase', () => {
  it('devolve TODOS os grupos, inclusive os que não parecem com paciente nenhum', async () => {
    // É a razão de existir: `Gestión: EnLite <> DAS` tem semelhança ZERO com
    // qualquer nome de paciente e por isso o ranqueamento o descartava.
    const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute();

    if (!out.ok) throw new Error('esperava ok');
    expect(out.total).toBe(5);
    expect(out.groups.map(g => g.chatId).sort()).toEqual(['1@g.us', '2@g.us', '3@g.us', '4@g.us', '5@g.us']);
  });

  it('ordena por NOME — página estável entre chamadas', async () => {
    const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute();
    if (!out.ok) throw new Error('esperava ok');
    expect(out.groups.map(g => g.chatName)).toEqual([
      'Equipo Perez', 'Flia Perez', 'Gestión: EnLite <> DAS', 'Gestión: EnLite <> OSPJN', 'Grupo sem dono',
    ]);
  });

  describe('busca por nome', () => {
    it('acha por pedaço do nome', async () => {
      const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute({ search: 'DAS' });
      if (!out.ok) throw new Error('esperava ok');
      expect(out.groups.map(g => g.chatId)).toEqual(['1@g.us']);
      expect(out.total).toBe(1);
    });

    it('ignora acento e caixa nos DOIS lados — "gestion" acha "Gestión"', async () => {
      // Quem digita não põe acento; quem nomeou o grupo pôs.
      const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute({ search: 'gestion' });
      if (!out.ok) throw new Error('esperava ok');
      expect(out.groups).toHaveLength(2);
    });

    it('busca vazia ou só espaços devolve tudo', async () => {
      for (const search of ['', '   ']) {
        const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute({ search });
        if (!out.ok) throw new Error('esperava ok');
        expect(out.total).toBe(5);
      }
    });

    it('sem resultado devolve lista vazia, não erro', async () => {
      const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute({ search: 'zzzz' });
      if (!out.ok) throw new Error('esperava ok');
      expect(out.groups).toEqual([]);
      expect(out.total).toBe(0);
      expect(out.hasMore).toBe(false);
    });

    it('grupo sem nome não quebra a busca', async () => {
      const out = await new ListChatGroupsUseCase(
        periskopeMock([group('9@g.us', null)]),
        repoMock(),
      ).execute({ search: 'x' });
      if (!out.ok) throw new Error('esperava ok');
      expect(out.groups).toEqual([]);
    });
  });

  describe('paginação', () => {
    it('respeita limit/offset e diz se há mais', async () => {
      const uc = new ListChatGroupsUseCase(periskopeMock(), repoMock());

      const p1 = await uc.execute({ limit: 2, offset: 0 });
      if (!p1.ok) throw new Error('esperava ok');
      expect(p1.groups).toHaveLength(2);
      expect(p1.total).toBe(5);
      expect(p1.hasMore).toBe(true);

      const p3 = await uc.execute({ limit: 2, offset: 4 });
      if (!p3.ok) throw new Error('esperava ok');
      expect(p3.groups).toHaveLength(1);
      expect(p3.hasMore).toBe(false);
    });

    it('as páginas não repetem nem pulam grupo', async () => {
      const uc = new ListChatGroupsUseCase(periskopeMock(), repoMock());
      const ids: string[] = [];
      for (let off = 0; off < 5; off += 2) {
        const p = await uc.execute({ limit: 2, offset: off });
        if (!p.ok) throw new Error('esperava ok');
        ids.push(...p.groups.map(g => g.chatId));
      }
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
    });

    it('`total` conta o FILTRO, não a org inteira', async () => {
      const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute({
        search: 'gestion', limit: 1,
      });
      if (!out.ok) throw new Error('esperava ok');
      expect(out.total).toBe(2);
      expect(out.groups).toHaveLength(1);
      expect(out.hasMore).toBe(true);
    });

    it.each([
      [0, 1],
      [-5, 1],
      [MAX_GROUP_PAGE_SIZE + 1, MAX_GROUP_PAGE_SIZE],
    ])('limit %s vira %s (a tela não dita o custo da query)', async (asked, expected) => {
      const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute({ limit: asked });
      if (!out.ok) throw new Error('esperava ok');
      expect(out.limit).toBe(expected);
    });

    it('offset negativo vira 0', async () => {
      const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute({ offset: -3 });
      if (!out.ok) throw new Error('esperava ok');
      expect(out.offset).toBe(0);
    });

    it('limite default é 50', async () => {
      expect(DEFAULT_GROUP_PAGE_SIZE).toBe(50);
      const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute();
      if (!out.ok) throw new Error('esperava ok');
      expect(out.limit).toBe(50);
    });
  });

  describe('uso por grupo', () => {
    it('devolve quantos pacientes já usam cada grupo', async () => {
      const out = await new ListChatGroupsUseCase(
        periskopeMock(),
        repoMock({ '1@g.us': 40 }),
      ).execute({ search: 'DAS' });

      if (!out.ok) throw new Error('esperava ok');
      expect(out.groups[0].linkedPatientCount).toBe(40);
    });

    it('grupo que ninguém usa vem com 0, não undefined', async () => {
      const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute({ search: 'DAS' });
      if (!out.ok) throw new Error('esperava ok');
      expect(out.groups[0].linkedPatientCount).toBe(0);
    });

    it('pergunta a contagem SÓ dos grupos da página', async () => {
      // Perguntar pelos 775 a cada tecla digitada varreria a tabela inteira
      // para mostrar 50 linhas.
      const repo = repoMock();
      await new ListChatGroupsUseCase(periskopeMock(), repo).execute({ limit: 2, offset: 0 });

      const asked = (repo.countPatientsByChatIds as jest.Mock).mock.calls[0][0];
      expect(asked).toHaveLength(2);
    });
  });

  it('leva a ORIGEM do grupo — é ela que explica por que um grupo não aparece', async () => {
    const out = await new ListChatGroupsUseCase(periskopeMock(), repoMock()).execute({ search: 'sem dono' });
    if (!out.ok) throw new Error('esperava ok');
    expect(out.groups[0].orgPhone).toBe(PHONE_2);
  });

  it('lista INCOMPLETA viaja até a saída — "não achei" nunca vira "cortei"', async () => {
    const out = await new ListChatGroupsUseCase(periskopeMock(GROUPS, true), repoMock()).execute();
    if (!out.ok) throw new Error('esperava ok');
    expect(out.listTruncated).toBe(true);
  });

  it('Periskope indisponível → periskope_unavailable, sem tocar no banco', async () => {
    const repo = repoMock();
    const out = await new ListChatGroupsUseCase(periskopeMock(null), repo).execute();

    expect(out).toEqual({ ok: false, reason: 'periskope_unavailable' });
    expect(repo.countPatientsByChatIds).not.toHaveBeenCalled();
  });

  it('org sem grupo nenhum → ok com lista vazia', async () => {
    const out = await new ListChatGroupsUseCase(periskopeMock([]), repoMock()).execute();
    if (!out.ok) throw new Error('esperava ok');
    expect(out).toMatchObject({ groups: [], total: 0, hasMore: false, listTruncated: false });
  });

  it('sem dependências injetadas, instancia os padrões', () => {
    expect(() => new ListChatGroupsUseCase()).not.toThrow();
  });
});
