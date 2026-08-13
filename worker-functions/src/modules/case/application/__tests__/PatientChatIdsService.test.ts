import {
  PatientChatIdsService,
  PatientChatIdsNotFoundError,
  ChatIdAlreadyLinkedError,
  ChatIdOwnedBySamePatientRoleError,
  UnknownChatRoleError,
} from '../PatientChatIdsService';
import type { PatientChatIdsRepository, ChatIdConflict } from '../../infrastructure/PatientChatIdsRepository';
import type { PatientChatRolesRepository } from '../../infrastructure/PatientChatRolesRepository';
import type { PatientChatRoleSpec, PatientChatRoleCatalog } from '../../domain/PatientChatRole';

// Só para o caso "sem repo injetado": os repositórios reais abrem pool no construtor.
jest.mock('../../infrastructure/PatientChatIdsRepository', () => ({
  PatientChatIdsRepository: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../infrastructure/PatientChatRolesRepository', () => ({
  PatientChatRolesRepository: jest.fn().mockImplementation(() => ({})),
}));

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const FAMILY = '120363001111111111@g.us';
const PROVIDERS = '120363002222222222@g.us';
const PLAN = '120363003333333333@g.us';

function spec(code: string, isExclusive: boolean): PatientChatRoleSpec {
  return {
    code,
    labelEs: code,
    labelPtBr: code,
    isExclusive,
    displayOrder: 0,
    isActive: true,
    matchKeywords: [],
  };
}

/** O catálogo que a 262 semeia. HEALTH_PLAN nasce compartilhável. */
const SEEDED = [spec('FAMILY', true), spec('PROVIDERS', true), spec('HEALTH_PLAN', false)];

function rolesRepoMock(active: PatientChatRoleSpec[] = SEEDED) {
  return {
    listActive: jest.fn().mockResolvedValue(active),
  } as unknown as jest.Mocked<PatientChatRolesRepository>;
}

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

function service(
  repo: jest.Mocked<PatientChatIdsRepository>,
  rolesRepo: jest.Mocked<PatientChatRolesRepository> = rolesRepoMock(),
): PatientChatIdsService {
  return new PatientChatIdsService(repo, rolesRepo);
}

describe('PatientChatIdsService', () => {
  it('grava N papéis e devolve o estado final vindo do repositório', async () => {
    const repo = repoMock();
    const out = await service(repo).update(PATIENT, { FAMILY, PROVIDERS, HEALTH_PLAN: PLAN });

    expect(out).toEqual({ FAMILY, PROVIDERS, HEALTH_PLAN: PLAN });
    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, { FAMILY, PROVIDERS, HEALTH_PLAN: PLAN }, expect.any(Map), undefined);
  });

  it('null desvincula, e nem consulta conflito (não há o que colidir)', async () => {
    const repo = repoMock();
    await service(repo).update(PATIENT, { FAMILY: null, PROVIDERS: null });

    expect(repo.findLinkedElsewhere).not.toHaveBeenCalled();
    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, { FAMILY: null, PROVIDERS: null }, expect.any(Map), undefined);
  });

  it('papel ausente do mapa não é enviado ao repositório', async () => {
    const repo = repoMock();
    await service(repo).update(PATIENT, { FAMILY });

    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, { FAMILY }, expect.any(Map), undefined);
  });

  it('paciente inexistente → PatientChatIdsNotFoundError, sem escrever', async () => {
    const repo = repoMock({ findById: jest.fn().mockResolvedValue(null) } as never);
    await expect(service(repo).update(PATIENT, { FAMILY })).rejects.toBeInstanceOf(
      PatientChatIdsNotFoundError,
    );
    expect(repo.applyChatIds).not.toHaveBeenCalled();
  });

  // ── vocabulário: o catálogo é DADO, e o serviço é quem o confere ───────────
  // Saiu do schema Zod de propósito. Um schema com a lista embutida voltaria a
  // exigir deploy a cada papel novo — exatamente o que a 262 elimina.

  it('papel FORA do catálogo → UnknownChatRoleError, sem escrever', async () => {
    const repo = repoMock();
    const promise = service(repo).update(PATIENT, { NEIGHBOURS: FAMILY });

    await expect(promise).rejects.toBeInstanceOf(UnknownChatRoleError);
    await expect(promise).rejects.toMatchObject({ roles: ['NEIGHBOURS'] });
    expect(repo.applyChatIds).not.toHaveBeenCalled();
  });

  it('papel DESATIVADO na tela deixa de ser gravável — mesmo erro', async () => {
    // `listActive` é o recorte: desativar tira o papel da escrita, mas não
    // apaga vínculo nenhum (a auditoria da Candela olha para trás).
    const repo = repoMock();
    const rolesRepo = rolesRepoMock([spec('FAMILY', true)]);

    await expect(
      service(repo, rolesRepo).update(PATIENT, { HEALTH_PLAN: PLAN }),
    ).rejects.toBeInstanceOf(UnknownChatRoleError);
  });

  it('acusa TODOS os papéis desconhecidos de uma vez, não só o primeiro', async () => {
    const repo = repoMock();
    await expect(
      service(repo).update(PATIENT, { NEIGHBOURS: FAMILY, MANAGEMENT: PROVIDERS }),
    ).rejects.toMatchObject({ roles: ['NEIGHBOURS', 'MANAGEMENT'] });
  });

  it('DESVINCULAR papel desconhecido também é recusado (não é no-op silencioso)', async () => {
    const repo = repoMock();
    await expect(service(repo).update(PATIENT, { NEIGHBOURS: null })).rejects.toBeInstanceOf(
      UnknownChatRoleError,
    );
  });

  it('lê o catálogo UMA vez e passa o MESMO objeto para a gravação', async () => {
    // Ler duas vezes abriria uma janela em que a validação e a escrita
    // enxergariam políticas diferentes.
    const repo = repoMock();
    const rolesRepo = rolesRepoMock();
    await service(repo, rolesRepo).update(PATIENT, { FAMILY });

    expect(rolesRepo.listActive).toHaveBeenCalledTimes(1);
    const catalog = (repo.applyChatIds as jest.Mock).mock.calls[0][2] as PatientChatRoleCatalog;
    expect(catalog.get('HEALTH_PLAN')?.isExclusive).toBe(false);
  });

  // ── unicidade ─────────────────────────────────────────────────────────────

  it('chat_id já preso a outro paciente NO MESMO papel → 409 com o conflito', async () => {
    const conflict: ChatIdConflict = { chatId: FAMILY, patientId: OTHER, role: 'FAMILY', exclusive: true };
    const repo = repoMock({ findLinkedElsewhere: jest.fn().mockResolvedValue([conflict]) } as never);

    const promise = service(repo).update(PATIENT, { FAMILY });

    await expect(promise).rejects.toBeInstanceOf(ChatIdAlreadyLinkedError);
    await expect(promise).rejects.toMatchObject({ conflicts: [conflict] });
    expect(repo.applyChatIds).not.toHaveBeenCalled();
  });

  it('colisão CRUZADA (FAMILY daqui == PROVIDERS de outro) também é 409', async () => {
    const conflict: ChatIdConflict = { chatId: FAMILY, patientId: OTHER, role: 'PROVIDERS', exclusive: true };
    const repo = repoMock({ findLinkedElsewhere: jest.fn().mockResolvedValue([conflict]) } as never);

    await expect(service(repo).update(PATIENT, { FAMILY })).rejects.toBeInstanceOf(
      ChatIdAlreadyLinkedError,
    );
  });

  it('acusa os DOIS conflitos quando os dois grupos estão tomados', async () => {
    const conflicts: ChatIdConflict[] = [
      { chatId: FAMILY, patientId: OTHER, role: 'FAMILY', exclusive: true },
      { chatId: PROVIDERS, patientId: OTHER, role: 'PROVIDERS', exclusive: true },
    ];
    const repo = repoMock({ findLinkedElsewhere: jest.fn().mockResolvedValue(conflicts) } as never);

    await expect(service(repo).update(PATIENT, { FAMILY, PROVIDERS })).rejects.toMatchObject({
      conflicts,
    });
  });

  // ── mesmo paciente, papel diferente (achado de review, 11/08) ──────────────
  // `findLinkedElsewhere` só enxerga OUTROS pacientes — mover um chat_id entre
  // papéis do MESMO paciente sem incluir o papel antigo explicitamente batia
  // direto na constraint e voltava como "outro paciente" (mensagem falsa).

  it('chat_id já é do MESMO paciente, em papel FORA do body → ChatIdOwnedBySamePatientRoleError', async () => {
    const repo = repoMock({
      findById: jest.fn().mockResolvedValue({
        id: PATIENT, firstName: 'Maria', lastName: 'Perez', chatIds: { FAMILY: PROVIDERS },
      }),
    } as never);

    const promise = service(repo).update(PATIENT, { HEALTH_PLAN: PROVIDERS });

    await expect(promise).rejects.toBeInstanceOf(ChatIdOwnedBySamePatientRoleError);
    await expect(promise).rejects.toMatchObject({
      conflicts: [{ chatId: PROVIDERS, requestedRole: 'HEALTH_PLAN', currentRole: 'FAMILY' }],
    });
    expect(repo.applyChatIds).not.toHaveBeenCalled();
    // e nem chega a consultar OUTROS pacientes — o conflito já é conhecido.
    expect(repo.findLinkedElsewhere).not.toHaveBeenCalled();
  });

  it('MOVER o mesmo grupo incluindo o papel antigo (mesmo que null) NÃO é conflito', async () => {
    // Esta é a forma explícita de mover: o papel antigo está NO BODY.
    const repo = repoMock({
      findById: jest.fn().mockResolvedValue({
        id: PATIENT, firstName: 'Maria', lastName: 'Perez', chatIds: { FAMILY: PROVIDERS },
      }),
    } as never);

    await expect(
      service(repo).update(PATIENT, { FAMILY: null, HEALTH_PLAN: PROVIDERS }),
    ).resolves.toBeDefined();
    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, { FAMILY: null, HEALTH_PLAN: PROVIDERS }, expect.any(Map), undefined);
  });

  it('re-salvar o MESMO chat_id no MESMO papel não é conflito (no-op)', async () => {
    const repo = repoMock({
      findById: jest.fn().mockResolvedValue({
        id: PATIENT, firstName: 'Maria', lastName: 'Perez', chatIds: { FAMILY },
      }),
    } as never);

    await expect(service(repo).update(PATIENT, { FAMILY })).resolves.toBeDefined();
  });

  it('grupo de OUTRO paciente que não é o pedido não bloqueia', async () => {
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: '120363009999999999@g.us', patientId: OTHER, role: 'FAMILY', exclusive: true },
      ]),
    } as never);

    await expect(service(repo).update(PATIENT, { FAMILY })).resolves.toEqual({ FAMILY });
  });

  // ── unicidade como propriedade DO PAPEL, lida do CATÁLOGO ──────────────────
  // Estes casos não espionam mais nenhuma função: a política é dado, então o
  // ensaio é trocar a linha do catálogo — que é o que um admin faz na tela.

  it('papel COMPARTILHADO: o mesmo grupo pode ser de dois pacientes', async () => {
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: PLAN, patientId: OTHER, role: 'HEALTH_PLAN', exclusive: false },
      ]),
    } as never);

    await expect(service(repo).update(PATIENT, { HEALTH_PLAN: PLAN })).resolves.toEqual({
      HEALTH_PLAN: PLAN,
    });
  });

  it('o MESMO caso vira 409 quando o admin marca o papel como exclusivo na tela', async () => {
    // A prova de que a política mora no dado: mesmo serviço, mesmo repositório,
    // resposta oposta — só o catálogo mudou.
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: PLAN, patientId: OTHER, role: 'HEALTH_PLAN', exclusive: false },
      ]),
    } as never);
    const rolesRepo = rolesRepoMock([spec('HEALTH_PLAN', true)]);

    await expect(
      service(repo, rolesRepo).update(PATIENT, { HEALTH_PLAN: PLAN }),
    ).rejects.toBeInstanceOf(ChatIdAlreadyLinkedError);
  });

  it('grupo de papel compartilhado NÃO pode virar um papel EXCLUSIVO daqui', async () => {
    // Basta UM dos dois lados ser exclusivo: o grupo do plano de saúde é
    // compartilhável entre planos, mas não pode ser a família de ninguém.
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: PLAN, patientId: OTHER, role: 'HEALTH_PLAN', exclusive: false },
      ]),
    } as never);

    await expect(service(repo).update(PATIENT, { FAMILY: PLAN })).rejects.toBeInstanceOf(
      ChatIdAlreadyLinkedError,
    );
  });

  it('sem repo injetado, instancia os padrões', () => {
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
    expect(new UnknownChatRoleError(['NEIGHBOURS']).name).toBe('UnknownChatRoleError');
    expect(new UnknownChatRoleError(['NEIGHBOURS']).message).toContain('NEIGHBOURS');
  });
});

describe('PatientChatIdsService.syncFromClickUp', () => {
  it('paciente inexistente (ou soft-deleted): tudo skipped, nada gravado', async () => {
    const repo = repoMock({ findById: jest.fn().mockResolvedValue(null) } as never);

    const out = await service(repo).syncFromClickUp(PATIENT, { FAMILY, PROVIDERS });

    expect(out).toEqual({
      applied: [],
      unchanged: [],
      skipped: [
        { role: 'FAMILY', chatId: FAMILY, reason: 'patient_not_found' },
        { role: 'PROVIDERS', chatId: PROVIDERS, reason: 'patient_not_found' },
      ],
    });
    expect(repo.applyChatIds).not.toHaveBeenCalled();
  });

  it('valor já igual ao atual: unchanged, sem NENHUMA escrita (o reconcile roda a cada 10min)', async () => {
    const repo = repoMock({
      findById: jest.fn().mockResolvedValue({
        id: PATIENT, firstName: 'Maria', lastName: 'Perez',
        chatIds: { FAMILY, PROVIDERS },
      }),
    } as never);

    const out = await service(repo).syncFromClickUp(PATIENT, { FAMILY, PROVIDERS });

    expect(out).toEqual({ applied: [], unchanged: ['FAMILY', 'PROVIDERS'], skipped: [] });
    expect(repo.applyChatIds).not.toHaveBeenCalled();
  });

  it('grava só o diff: papel novo aplica, papel igual fica unchanged', async () => {
    const repo = repoMock({
      findById: jest.fn().mockResolvedValue({
        id: PATIENT, firstName: 'Maria', lastName: 'Perez',
        chatIds: { FAMILY },
      }),
    } as never);

    const out = await service(repo).syncFromClickUp(PATIENT, { FAMILY, PROVIDERS });

    expect(out).toEqual({ applied: ['PROVIDERS'], unchanged: ['FAMILY'], skipped: [] });
    expect(repo.applyChatIds).toHaveBeenCalledTimes(1);
    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, { PROVIDERS }, expect.any(Map), expect.anything());
  });

  it('conflito num papel não derruba o outro: salva papel a papel e reporta o perdedor', async () => {
    // PROVIDERS já é de OUTRO paciente (exclusivo); FAMILY está livre.
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: PROVIDERS, patientId: OTHER, role: 'PROVIDERS', exclusive: true },
      ]),
    } as never);

    const out = await service(repo).syncFromClickUp(PATIENT, { FAMILY, PROVIDERS });

    expect(out.applied).toEqual(['FAMILY']);
    expect(out.skipped).toEqual([
      { role: 'PROVIDERS', chatId: PROVIDERS, reason: 'ChatIdAlreadyLinkedError' },
    ]);
    expect(repo.applyChatIds).toHaveBeenCalledTimes(1);
    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, { FAMILY }, expect.any(Map), expect.anything());
  });

  it('erro de infraestrutura NÃO vira skipped: sobe para o chamador', async () => {
    const repo = repoMock({
      applyChatIds: jest.fn().mockRejectedValue(new Error('connection refused')),
    } as never);

    await expect(service(repo).syncFromClickUp(PATIENT, { FAMILY })).rejects.toThrow(
      'connection refused',
    );
  });

  it('23505 cru do banco é CONFLITO (skipped), não falha de infraestrutura', async () => {
    // A trava de unicidade do banco é quem arbitra de verdade; um dado em
    // disputa não pode virar loop de erro no reconcile.
    const repo = repoMock({
      applyChatIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      ),
    } as never);

    const out = await service(repo).syncFromClickUp(PATIENT, { FAMILY });

    expect(out).toEqual({
      applied: [],
      unchanged: [],
      skipped: [{ role: 'FAMILY', chatId: FAMILY, reason: 'unique_violation' }],
    });
  });

  it('conflito com UM papel só não repete a mesma chamada (sem retry condenado)', async () => {
    const repo = repoMock({
      findLinkedElsewhere: jest.fn().mockResolvedValue([
        { chatId: FAMILY, patientId: OTHER, role: 'FAMILY', exclusive: true },
      ]),
    } as never);

    const out = await service(repo).syncFromClickUp(PATIENT, { FAMILY });

    expect(out.skipped).toEqual([
      { role: 'FAMILY', chatId: FAMILY, reason: 'ChatIdAlreadyLinkedError' },
    ]);
    // Uma única passada de validação — papel-a-papel repetiria a chamada idêntica.
    expect(repo.findLinkedElsewhere).toHaveBeenCalledTimes(1);
  });

  it('grupo que MUDOU de campo no ClickUp vira move explícito (papel antigo desvincula)', async () => {
    // ClickUp: era "Chat ID Equipo", operador moveu para "Chat ID Familia".
    const repo = repoMock({
      findById: jest.fn().mockResolvedValue({
        id: PATIENT, firstName: 'Maria', lastName: 'Perez',
        chatIds: { PROVIDERS: FAMILY },
      }),
    } as never);

    const out = await service(repo).syncFromClickUp(PATIENT, { FAMILY });

    expect(out.applied).toEqual(['FAMILY']);
    expect(repo.applyChatIds).toHaveBeenCalledWith(PATIENT, { FAMILY, PROVIDERS: null }, expect.any(Map), expect.anything());
  });

  it('paciente soft-deleted entre a leitura e a escrita: patient_not_found, sem erro', async () => {
    const repo = repoMock({
      findById: jest
        .fn()
        .mockResolvedValueOnce({ id: PATIENT, firstName: 'M', lastName: 'P', chatIds: {} })
        .mockResolvedValueOnce(null),
    } as never);

    const out = await service(repo).syncFromClickUp(PATIENT, { FAMILY });

    expect(out).toEqual({
      applied: [],
      unchanged: [],
      skipped: [{ role: 'FAMILY', chatId: FAMILY, reason: 'patient_not_found' }],
    });
  });
});
