/**
 * GetNotificationsUseCase — TDD (Spec 022, Bloco 4, T406). Molde: mock de repositório inteiro
 * (aqui, diferente de `FanOutNotificationUseCase.test.ts`, NÃO precisamos inspecionar SQL — o
 * comportamento sob teste é a COMPOSIÇÃO de linhas + checagem de acesso do ator, já provada em
 * `NotificationRepository.test.ts`/matriz ABAC separadamente).
 */
import { GetNotificationsUseCase } from '../GetNotificationsUseCase';
import type { NotificationRepository, NotificationEventRow } from '../../infrastructure/NotificationRepository';
import type { ActorPatientConversationAccessChecker } from '../ports';

function row(overrides: Partial<NotificationEventRow> = {}): NotificationEventRow {
  return {
    id: 'n1',
    typeCode: 'CONVERSATION_MENTIONED',
    actorUid: 'actor-1',
    actorDisplayName: 'Fulano',
    patientId: 'p1',
    conversationId: 'c1',
    messageId: 'm1',
    createdAt: new Date('2026-09-21T10:00:00.000Z'),
    readAt: null,
    ...overrides,
  };
}

function repoWith(rows: NotificationEventRow[], patientName: string | null = 'Ana Silva'): NotificationRepository {
  return {
    listForRecipient: jest.fn().mockResolvedValue(rows),
    findPatientDisplayName: jest.fn().mockResolvedValue(patientName),
  } as unknown as NotificationRepository;
}

describe('GetNotificationsUseCase (D-13)', () => {
  it('ator AINDA tem patient_conversation:read: resolve o patientDisplayName real', async () => {
    const repo = repoWith([row()]);
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(true) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.patientDisplayName).toBe('Ana Silva');
    expect(checker.canReadPatientConversation).toHaveBeenCalledWith('actor-1');
  });

  it('ator PERDEU a célula (D-05/D-13): patientDisplayName é null, mesmo com patientId presente', async () => {
    const repo = repoWith([row()]);
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(false) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.patientDisplayName).toBeNull();
    expect(repo.findPatientDisplayName).not.toHaveBeenCalled(); // nem tenta ler o nome sem a checagem passar
  });

  it('sem accessChecker (composição incompleta): nunca lança, patientDisplayName fica null', async () => {
    const repo = repoWith([row()]);
    const useCase = new GetNotificationsUseCase(repo);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.patientDisplayName).toBeNull();
  });

  it('patientId null no evento (notificação sem paciente associado): nunca chama o checker', async () => {
    const repo = repoWith([row({ patientId: null })]);
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn() };
    const useCase = new GetNotificationsUseCase(repo, checker);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.patientDisplayName).toBeNull();
    expect(checker.canReadPatientConversation).not.toHaveBeenCalled();
  });

  it('2 notificações do MESMO ator: checa a permissão UMA vez só (cache por request)', async () => {
    const repo = repoWith([row({ id: 'n1' }), row({ id: 'n2' })]);
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(true) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(checker.canReadPatientConversation).toHaveBeenCalledTimes(1);
  });

  it('repassa unreadOnly/limit para o repositório sem alterar', async () => {
    const repo = repoWith([]);
    const useCase = new GetNotificationsUseCase(repo);

    await useCase.execute({ recipientUid: 'me', unreadOnly: true, limit: 10 });

    expect(repo.listForRecipient).toHaveBeenCalledWith('me', { unreadOnly: true, limit: 10 });
  });
});
