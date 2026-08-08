import {
  PatientChatIdsService,
  PatientChatIdsNotFoundError,
  ChatIdAlreadyLinkedError,
} from '../PatientChatIdsService';
import type { PatientChatIdsRepository, ChatIdConflict } from '../../infrastructure/PatientChatIdsRepository';

// Só para o caso "sem repo injetado": o repositório real abre pool no construtor.
jest.mock('../../infrastructure/PatientChatIdsRepository', () => ({
  PatientChatIdsRepository: jest.fn().mockImplementation(() => ({})),
}));

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const FAMILY = '120363001111111111@g.us';
const PROVIDERS = '120363002222222222@g.us';

function repoMock(over: Partial<jest.Mocked<PatientChatIdsRepository>> = {}) {
  return {
    findById: jest.fn().mockResolvedValue({
      id: PATIENT, firstName: 'Maria', lastName: 'Perez',
      familyChatId: null, providersChatId: null,
    }),
    findLinkedElsewhere: jest.fn().mockResolvedValue([] as ChatIdConflict[]),
    updateChatIds: jest.fn().mockResolvedValue(true),
    ...over,
  } as unknown as jest.Mocked<PatientChatIdsRepository>;
}

describe('PatientChatIdsService', () => {
  it('grava o par e devolve o que gravou', async () => {
    const repo = repoMock();
    const out = await new PatientChatIdsService(repo).update(PATIENT, {
      familyChatId: FAMILY, providersChatId: PROVIDERS,
    });

    expect(out).toEqual({ familyChatId: FAMILY, providersChatId: PROVIDERS });
    expect(repo.updateChatIds).toHaveBeenCalledWith(PATIENT, {
      familyChatId: FAMILY, providersChatId: PROVIDERS,
    });
  });

  it('null desvincula, e nem consulta conflito (não há o que colidir)', async () => {
    const repo = repoMock();
    await new PatientChatIdsService(repo).update(PATIENT, {
      familyChatId: null, providersChatId: null,
    });

    expect(repo.findLinkedElsewhere).not.toHaveBeenCalled();
    expect(repo.updateChatIds).toHaveBeenCalledWith(PATIENT, {
      familyChatId: null, providersChatId: null,
    });
  });

  it('paciente inexistente → PatientChatIdsNotFoundError, sem escrever', async () => {
    const repo = repoMock({ findById: jest.fn().mockResolvedValue(null) } as never);
    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { familyChatId: FAMILY, providersChatId: null }),
    ).rejects.toBeInstanceOf(PatientChatIdsNotFoundError);
    expect(repo.updateChatIds).not.toHaveBeenCalled();
  });

  it('chat_id já preso a outro paciente NO MESMO papel → 409 com o conflito', async () => {
    const conflict: ChatIdConflict = { chatId: FAMILY, patientId: OTHER, role: 'family' };
    const repo = repoMock({ findLinkedElsewhere: jest.fn().mockResolvedValue([conflict]) } as never);

    const promise = new PatientChatIdsService(repo).update(PATIENT, {
      familyChatId: FAMILY, providersChatId: null,
    });

    await expect(promise).rejects.toBeInstanceOf(ChatIdAlreadyLinkedError);
    await expect(promise).rejects.toMatchObject({ conflicts: [conflict] });
    expect(repo.updateChatIds).not.toHaveBeenCalled();
  });

  it('colisão CRUZADA (family daqui == providers de outro) também é 409', async () => {
    const conflict: ChatIdConflict = { chatId: FAMILY, patientId: OTHER, role: 'providers' };
    const repo = repoMock({ findLinkedElsewhere: jest.fn().mockResolvedValue([conflict]) } as never);

    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { familyChatId: FAMILY, providersChatId: null }),
    ).rejects.toBeInstanceOf(ChatIdAlreadyLinkedError);
  });

  it('acusa os DOIS conflitos quando os dois grupos estão tomados', async () => {
    const conflicts: ChatIdConflict[] = [
      { chatId: FAMILY, patientId: OTHER, role: 'family' },
      { chatId: PROVIDERS, patientId: OTHER, role: 'providers' },
    ];
    const repo = repoMock({ findLinkedElsewhere: jest.fn().mockResolvedValue(conflicts) } as never);

    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { familyChatId: FAMILY, providersChatId: PROVIDERS }),
    ).rejects.toMatchObject({ conflicts });
  });

  it('grupo de OUTRO paciente que não é o pedido não bloqueia', async () => {
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: '120363009999999999@g.us', patientId: OTHER, role: 'family' },
      ]),
    } as never);

    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { familyChatId: FAMILY, providersChatId: null }),
    ).resolves.toEqual({ familyChatId: FAMILY, providersChatId: null });
  });

  it('UPDATE que não pegou linha (corrida de exclusão) → not found', async () => {
    const repo = repoMock({ updateChatIds: jest.fn().mockResolvedValue(false) } as never);
    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { familyChatId: FAMILY, providersChatId: null }),
    ).rejects.toBeInstanceOf(PatientChatIdsNotFoundError);
  });

  it('sem repo injetado, instancia o padrão', () => {
    expect(() => new PatientChatIdsService()).not.toThrow();
  });

  it('as mensagens de erro não vazam nome de paciente', () => {
    const err = new ChatIdAlreadyLinkedError([{ chatId: FAMILY, patientId: OTHER, role: 'family' }]);
    expect(err.message).toContain(FAMILY);
    expect(err.name).toBe('ChatIdAlreadyLinkedError');
    expect(new PatientChatIdsNotFoundError(PATIENT).name).toBe('PatientChatIdsNotFoundError');
  });
});
