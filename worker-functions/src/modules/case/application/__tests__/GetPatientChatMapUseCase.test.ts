import {
  GetPatientChatMapUseCase,
  DEFAULT_CHAT_MAP_LIMIT,
  MAX_CHAT_MAP_LIMIT,
} from '../GetPatientChatMapUseCase';
import type { PatientChatIdsRepository } from '../../infrastructure/PatientChatIdsRepository';

jest.mock('../../infrastructure/PatientChatIdsRepository', () => ({
  PatientChatIdsRepository: jest.fn().mockImplementation(() => ({})),
}));

const P1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const P2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const FAMILY = '120363090000000001@g.us';
const PROVIDERS = '120363090000000002@g.us';

const ROW_1 = { patientId: P1, clickupTaskId: '86a4d52bf', familyChatId: FAMILY, providersChatId: PROVIDERS };
const ROW_2 = { patientId: P2, clickupTaskId: null, familyChatId: null, providersChatId: null };

function repoMock(over: Record<string, unknown> = {}) {
  return {
    findChatMap: jest.fn().mockResolvedValue({ rows: [ROW_1], total: 1 }),
    findByChatId: jest.fn().mockResolvedValue([]),
    ...over,
  } as unknown as PatientChatIdsRepository;
}

describe('GetPatientChatMapUseCase', () => {
  describe('mapa em massa', () => {
    it('default: filtro linked, limite 500, offset 0', async () => {
      const repo = repoMock();
      const out = await new GetPatientChatMapUseCase(repo).execute();

      expect(repo.findChatMap).toHaveBeenCalledWith({
        filter: 'linked', limit: DEFAULT_CHAT_MAP_LIMIT, offset: 0,
      });
      expect(out).toEqual({
        patients: [ROW_1], total: 1, limit: DEFAULT_CHAT_MAP_LIMIT, offset: 0, hasMore: false,
      });
    });

    it('aceita input vazio explícito', async () => {
      const repo = repoMock();
      await new GetPatientChatMapUseCase(repo).execute({});
      expect(repo.findChatMap).toHaveBeenCalledWith(
        expect.objectContaining({ filter: 'linked' }),
      );
    });

    it.each(['linked', 'unlinked', 'all'] as const)('repassa o filtro %s', async filter => {
      const repo = repoMock();
      await new GetPatientChatMapUseCase(repo).execute({ filter });
      expect(repo.findChatMap).toHaveBeenCalledWith(expect.objectContaining({ filter }));
    });

    it('a fila do backfill (unlinked) devolve quem não tem nenhum grupo', async () => {
      const repo = repoMock({ findChatMap: jest.fn().mockResolvedValue({ rows: [ROW_2], total: 1 }) });
      const out = await new GetPatientChatMapUseCase(repo).execute({ filter: 'unlinked' });
      expect(out.patients).toEqual([ROW_2]);
    });

    it('hasMore=true quando ainda sobra página', async () => {
      const repo = repoMock({ findChatMap: jest.fn().mockResolvedValue({ rows: [ROW_1], total: 357 }) });
      const out = await new GetPatientChatMapUseCase(repo).execute({ limit: 1, offset: 0 });
      expect(out).toMatchObject({ total: 357, hasMore: true, limit: 1, offset: 0 });
    });

    it('hasMore=false na última página', async () => {
      const repo = repoMock({ findChatMap: jest.fn().mockResolvedValue({ rows: [ROW_1], total: 10 }) });
      const out = await new GetPatientChatMapUseCase(repo).execute({ limit: 1, offset: 9 });
      expect(out.hasMore).toBe(false);
    });

    it('hasMore=false quando a página volta vazia além do fim', async () => {
      const repo = repoMock({ findChatMap: jest.fn().mockResolvedValue({ rows: [], total: 5 }) });
      const out = await new GetPatientChatMapUseCase(repo).execute({ offset: 100 });
      expect(out.hasMore).toBe(false);
    });

    it('limite acima do teto é cortado em MAX_CHAT_MAP_LIMIT', async () => {
      const repo = repoMock();
      await new GetPatientChatMapUseCase(repo).execute({ limit: 99999 });
      expect(repo.findChatMap).toHaveBeenCalledWith(
        expect.objectContaining({ limit: MAX_CHAT_MAP_LIMIT }),
      );
    });

    it('limite abaixo de 1 vira 1', async () => {
      const repo = repoMock();
      await new GetPatientChatMapUseCase(repo).execute({ limit: 0 });
      expect(repo.findChatMap).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    });

    it('offset negativo vira 0', async () => {
      const repo = repoMock();
      await new GetPatientChatMapUseCase(repo).execute({ offset: -50 });
      expect(repo.findChatMap).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
    });

    it('limite fracionário é truncado', async () => {
      const repo = repoMock();
      await new GetPatientChatMapUseCase(repo).execute({ limit: 10.9, offset: 3.7 });
      expect(repo.findChatMap).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 3 }),
      );
    });

    it('o teto de página (1000) é maior que a base atual (357) — cabe numa rodada', () => {
      expect(MAX_CHAT_MAP_LIMIT).toBeGreaterThan(357);
      expect(DEFAULT_CHAT_MAP_LIMIT).toBeGreaterThan(357);
    });
  });

  describe('direção reversa (chatId -> paciente)', () => {
    it('devolve o paciente e o papel, sem paginar', async () => {
      const hit = { ...ROW_1, matchedRole: 'family' as const };
      const repo = repoMock({ findByChatId: jest.fn().mockResolvedValue([hit]) });

      const out = await new GetPatientChatMapUseCase(repo).execute({ chatId: FAMILY });

      expect(repo.findByChatId).toHaveBeenCalledWith(FAMILY);
      expect(repo.findChatMap).not.toHaveBeenCalled();
      expect(out).toEqual({ patients: [hit], total: 1, limit: DEFAULT_CHAT_MAP_LIMIT, offset: 0, hasMore: false });
    });

    it('chat sem dono devolve lista vazia (não erro)', async () => {
      const repo = repoMock();
      const out = await new GetPatientChatMapUseCase(repo).execute({ chatId: FAMILY });
      expect(out).toMatchObject({ patients: [], total: 0, hasMore: false });
    });

    it('chatId tem precedência sobre filter e offset', async () => {
      const repo = repoMock({ findByChatId: jest.fn().mockResolvedValue([ROW_1]) });
      const out = await new GetPatientChatMapUseCase(repo).execute({
        chatId: PROVIDERS, filter: 'unlinked', offset: 42,
      });
      expect(repo.findChatMap).not.toHaveBeenCalled();
      expect(out.offset).toBe(0);
    });

    it('colisão cruzada aparece com os dois donos — não esconde a contagem dupla', async () => {
      const dois = [
        { ...ROW_1, matchedRole: 'family' as const },
        { ...ROW_2, patientId: P2, familyChatId: null, providersChatId: FAMILY, matchedRole: 'providers' as const },
      ];
      const repo = repoMock({ findByChatId: jest.fn().mockResolvedValue(dois) });
      const out = await new GetPatientChatMapUseCase(repo).execute({ chatId: FAMILY });
      expect(out.patients).toHaveLength(2);
      expect(out.total).toBe(2);
    });
  });

  it('nenhum campo de PII sai do payload', async () => {
    const repo = repoMock();
    const out = await new GetPatientChatMapUseCase(repo).execute();
    const keys = Object.keys(out.patients[0]);
    expect(keys.sort()).toEqual(['clickupTaskId', 'familyChatId', 'patientId', 'providersChatId']);
    for (const proibido of ['firstName', 'lastName', 'phoneWhatsapp', 'documentNumber', 'birthDate']) {
      expect(keys).not.toContain(proibido);
    }
  });

  it('sem repo injetado, instancia o padrão', () => {
    expect(() => new GetPatientChatMapUseCase()).not.toThrow();
  });
});
