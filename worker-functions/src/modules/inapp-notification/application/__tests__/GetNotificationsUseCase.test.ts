/**
 * GetNotificationsUseCase — TDD (Spec 022, Bloco 4, T406). Molde: mock de repositório inteiro
 * (aqui, diferente de `FanOutNotificationUseCase.test.ts`, NÃO precisamos inspecionar SQL — o
 * comportamento sob teste é a COMPOSIÇÃO de linhas + checagem de acesso, já provada em
 * `NotificationRepository.test.ts`/matriz ABAC separadamente).
 *
 * Revisão de D-13 no gate fecho B5 (21/09): a versão original resolvia `patientDisplayName`
 * sob a célula do ATOR do evento (quem mencionou), não do destinatário. Achado do gate: quem
 * posta sempre tem a célula, então o nome do paciente vazava para QUALQUER destinatário
 * mencionado, mesmo sem célula nenhuma de paciente — o efeito de privacidade era o inverso do
 * fallback "um paciente". Decisão do Gabriel: resolver sob a célula do DESTINATÁRIO (quem faz a
 * requisição `GET /api/admin/notifications`).
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

describe('GetNotificationsUseCase (D-13 revisado no fecho B5: célula do DESTINATÁRIO)', () => {
  it('destinatário TEM patient_conversation:read: resolve o patientDisplayName real', async () => {
    const repo = repoWith([row()]);
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(true) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.patientDisplayName).toBe('Ana Silva');
    expect(checker.canReadPatientConversation).toHaveBeenCalledWith('me');
  });

  it('destinatário SEM patient_conversation:read: patientDisplayName é null, mesmo com patientId presente e o ATOR ainda tendo a célula', async () => {
    const repo = repoWith([row()]);
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(false) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.patientDisplayName).toBeNull();
    expect(repo.findPatientDisplayName).not.toHaveBeenCalled(); // nem tenta ler o nome sem a checagem passar
    expect(checker.canReadPatientConversation).not.toHaveBeenCalledWith('actor-1'); // nunca checa o ator
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

  it('2 notificações de ATORES DIFERENTES para o MESMO destinatário: checa a permissão UMA vez só (cache por request, é sempre o mesmo destinatário)', async () => {
    const repo = repoWith([row({ id: 'n1', actorUid: 'actor-1' }), row({ id: 'n2', actorUid: 'actor-2' })]);
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(true) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(checker.canReadPatientConversation).toHaveBeenCalledTimes(1);
    expect(checker.canReadPatientConversation).toHaveBeenCalledWith('me');
  });

  it('repassa unreadOnly/limit para o repositório sem alterar', async () => {
    const repo = repoWith([]);
    const useCase = new GetNotificationsUseCase(repo);

    await useCase.execute({ recipientUid: 'me', unreadOnly: true, limit: 10 });

    expect(repo.listForRecipient).toHaveBeenCalledWith('me', { unreadOnly: true, limit: 10 });
  });
});
