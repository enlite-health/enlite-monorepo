import {
  PatientChatIdsService,
  PatientChatIdsNotFoundError,
  ChatIdAlreadyLinkedError,
} from '../PatientChatIdsService';
import type { PatientChatIdsRepository, ChatIdConflict } from '../../infrastructure/PatientChatIdsRepository';
import * as roles from '../../domain/PatientChatRole';

// Só para o caso "sem repo injetado": o repositório real abre pool no construtor.
jest.mock('../../infrastructure/PatientChatIdsRepository', () => ({
  PatientChatIdsRepository: jest.fn().mockImplementation(() => ({})),
}));

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const FAMILY = '120363001111111111@g.us';
const PROVIDERS = '120363002222222222@g.us';
const PLAN = '120363003333333333@g.us';

function repoMock(over: Partial<jest.Mocked<PatientChatIdsRepository>> = {}) {
  return {
    findById: jest.fn().mockResolvedValue({
      id: PATIENT, firstName: 'Maria', lastName: 'Perez', chatIds: {},
    }),
    findLinkedElsewhere: jest.fn().mockResolvedValue([] as ChatIdConflict[]),
    applyChatIds: jest.fn().mockImplementation((_id: string, changes: Record<string, string | null>) =>
      Promise.resolve(
        Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null)),
      ),
    ),
    ...over,
  } as unknown as jest.Mocked<PatientChatIdsRepository>;
}

describe('PatientChatIdsService', () => {
  it('grava N papéis e devolve o estado final vindo do repositório', async () => {
    const repo = repoMock();
    const out = await new PatientChatIdsService(repo).update(PATIENT, {
      FAMILY, PROVIDERS, HEALTH_PLAN: PLAN,
    });

    expect(out).toEqual({ FAMILY, PROVIDERS, HEALTH_PLAN: PLAN });
    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, {
      FAMILY, PROVIDERS, HEALTH_PLAN: PLAN,
    });
  });

  it('null desvincula, e nem consulta conflito (não há o que colidir)', async () => {
    const repo = repoMock();
    await new PatientChatIdsService(repo).update(PATIENT, { FAMILY: null, PROVIDERS: null });

    expect(repo.findLinkedElsewhere).not.toHaveBeenCalled();
    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, { FAMILY: null, PROVIDERS: null });
  });

  it('papel ausente do mapa não é enviado ao repositório', async () => {
    const repo = repoMock();
    await new PatientChatIdsService(repo).update(PATIENT, { FAMILY });

    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, { FAMILY });
  });

  it('paciente inexistente → PatientChatIdsNotFoundError, sem escrever', async () => {
    const repo = repoMock({ findById: jest.fn().mockResolvedValue(null) } as never);
    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { FAMILY }),
    ).rejects.toBeInstanceOf(PatientChatIdsNotFoundError);
    expect(repo.applyChatIds).not.toHaveBeenCalled();
  });

  it('chat_id já preso a outro paciente NO MESMO papel → 409 com o conflito', async () => {
    const conflict: ChatIdConflict = { chatId: FAMILY, patientId: OTHER, role: 'FAMILY', exclusive: true };
    const repo = repoMock({ findLinkedElsewhere: jest.fn().mockResolvedValue([conflict]) } as never);

    const promise = new PatientChatIdsService(repo).update(PATIENT, { FAMILY });

    await expect(promise).rejects.toBeInstanceOf(ChatIdAlreadyLinkedError);
    await expect(promise).rejects.toMatchObject({ conflicts: [conflict] });
    expect(repo.applyChatIds).not.toHaveBeenCalled();
  });

  it('colisão CRUZADA (FAMILY daqui == PROVIDERS de outro) também é 409', async () => {
    const conflict: ChatIdConflict = { chatId: FAMILY, patientId: OTHER, role: 'PROVIDERS', exclusive: true };
    const repo = repoMock({ findLinkedElsewhere: jest.fn().mockResolvedValue([conflict]) } as never);

    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { FAMILY }),
    ).rejects.toBeInstanceOf(ChatIdAlreadyLinkedError);
  });

  it('acusa os DOIS conflitos quando os dois grupos estão tomados', async () => {
    const conflicts: ChatIdConflict[] = [
      { chatId: FAMILY, patientId: OTHER, role: 'FAMILY', exclusive: true },
      { chatId: PROVIDERS, patientId: OTHER, role: 'PROVIDERS', exclusive: true },
    ];
    const repo = repoMock({ findLinkedElsewhere: jest.fn().mockResolvedValue(conflicts) } as never);

    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { FAMILY, PROVIDERS }),
    ).rejects.toMatchObject({ conflicts });
  });

  it('grupo de OUTRO paciente que não é o pedido não bloqueia', async () => {
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: '120363009999999999@g.us', patientId: OTHER, role: 'FAMILY', exclusive: true },
      ]),
    } as never);

    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { FAMILY }),
    ).resolves.toEqual({ FAMILY });
  });

  // ── unicidade como propriedade DO PAPEL ───────────────────────────────────
  // Ensaio do dia em que o Marcel responder "o grupo do plano é UM POR PLANO,
  // compartilhado entre pacientes": `HEALTH_PLAN.exclusive` vira false no
  // catálogo, e as linhas gravadas passam a chegar aqui com exclusive=false.
  // Estes dois casos provam que o serviço já se comporta certo nesse dia, sem
  // mais nenhuma alteração — o `mockReturnValue` abaixo simula só a virada do
  // catálogo (o PONTO ÚNICO da decisão).

  it('papel COMPARTILHADO: o mesmo grupo pode ser de dois pacientes', async () => {
    const spy = jest.spyOn(roles, 'isExclusiveChatRole').mockReturnValue(false);
    try {
      const repo = repoMock({
        findLinkedElsewhere: jest.fn().mockResolvedValue([
          { chatId: PLAN, patientId: OTHER, role: 'HEALTH_PLAN', exclusive: false },
        ]),
      } as never);

      await expect(
        new PatientChatIdsService(repo).update(PATIENT, { HEALTH_PLAN: PLAN }),
      ).resolves.toEqual({ HEALTH_PLAN: PLAN });
    } finally {
      spy.mockRestore();
    }
  });

  it('grupo de papel compartilhado NÃO pode virar um papel EXCLUSIVO daqui', async () => {
    // Aqui o catálogo segue valendo: FAMILY é exclusivo, então basta esse lado.
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: PLAN, patientId: OTHER, role: 'HEALTH_PLAN', exclusive: false },
      ]),
    } as never);

    await expect(
      new PatientChatIdsService(repo).update(PATIENT, { FAMILY: PLAN }),
    ).rejects.toBeInstanceOf(ChatIdAlreadyLinkedError);
  });

  it('sem repo injetado, instancia o padrão', () => {
    expect(() => new PatientChatIdsService()).not.toThrow();
  });

  it('as mensagens de erro não vazam nome de paciente', () => {
    const err = new ChatIdAlreadyLinkedError([
      { chatId: FAMILY, patientId: OTHER, role: 'FAMILY', exclusive: true },
    ]);
    expect(err.message).toContain(FAMILY);
    expect(err.message).not.toContain('Maria');
    expect(err.name).toBe('ChatIdAlreadyLinkedError');
    expect(new PatientChatIdsNotFoundError(PATIENT).name).toBe('PatientChatIdsNotFoundError');
  });
});
