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
    findRootMessageIds: jest.fn().mockResolvedValue(new Map()),
    findMessageExcerpts: jest.fn().mockResolvedValue(new Map()),
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

describe('GetNotificationsUseCase — rootMessageId (item 3, F10/F11) — UNGATED, igual ao messageId', () => {
  it('propaga o rootMessageId resolvido pelo repositório, mesmo SEM accessChecker/célula', async () => {
    const repo = repoWith([row({ messageId: 'm1', patientId: null })]);
    (repo.findRootMessageIds as jest.Mock).mockResolvedValue(new Map([['m1', 'root-1']]));
    const useCase = new GetNotificationsUseCase(repo);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.rootMessageId).toBe('root-1');
    expect(repo.findRootMessageIds).toHaveBeenCalledWith(['m1']);
  });

  it('mensagem de TOPO (rootMessageId null no repositório): dto.rootMessageId sai null', async () => {
    const repo = repoWith([row({ messageId: 'm1' })]);
    (repo.findRootMessageIds as jest.Mock).mockResolvedValue(new Map([['m1', null]]));
    const useCase = new GetNotificationsUseCase(repo);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.rootMessageId).toBeNull();
  });

  it('messageId null no evento: nunca chama findRootMessageIds para ele, dto.rootMessageId null', async () => {
    const repo = repoWith([row({ messageId: null, patientId: null })]);
    const useCase = new GetNotificationsUseCase(repo);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.rootMessageId).toBeNull();
    expect(repo.findRootMessageIds).toHaveBeenCalledWith([]);
  });

  it('2 notificações com o MESMO messageId: dedup antes de chamar o repositório (custo de leitura, F8)', async () => {
    const repo = repoWith([row({ id: 'n1', messageId: 'm1', patientId: null }), row({ id: 'n2', messageId: 'm1', patientId: null })]);
    const useCase = new GetNotificationsUseCase(repo);

    await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(repo.findRootMessageIds).toHaveBeenCalledWith(['m1']);
  });
});

describe('GetNotificationsUseCase — messageExcerpt (item 2, F7/F8) — MESMO gate de patientDisplayName', () => {
  it('destinatário TEM patient_conversation:read: messageExcerpt vem do repositório', async () => {
    const repo = repoWith([row({ messageId: 'm1' })]);
    (repo.findMessageExcerpts as jest.Mock).mockResolvedValue(new Map([['m1', 'trecho da mensagem']]));
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(true) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.messageExcerpt).toBe('trecho da mensagem');
    expect(repo.findMessageExcerpts).toHaveBeenCalledWith(['m1']);
  });

  it('destinatário SEM patient_conversation:read: messageExcerpt null, NUNCA chama findMessageExcerpts (mesmo gate de patientDisplayName)', async () => {
    const repo = repoWith([row({ messageId: 'm1' })]);
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(false) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.messageExcerpt).toBeNull();
    expect(repo.findMessageExcerpts).toHaveBeenCalledWith([]);
  });

  it('patientId null no evento (sem paciente associado): messageExcerpt null, nunca elegível', async () => {
    const repo = repoWith([row({ messageId: 'm1', patientId: null })]);
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(true) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.messageExcerpt).toBeNull();
    expect(repo.findMessageExcerpts).toHaveBeenCalledWith([]);
  });

  it('sem accessChecker (composição incompleta): messageExcerpt fica null, nunca lança', async () => {
    const repo = repoWith([row({ messageId: 'm1' })]);
    const useCase = new GetNotificationsUseCase(repo);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.messageExcerpt).toBeNull();
  });

  it('repositório resolve null para o messageId (sem body/falha de decifra): dto.messageExcerpt null', async () => {
    const repo = repoWith([row({ messageId: 'm1' })]);
    (repo.findMessageExcerpts as jest.Mock).mockResolvedValue(new Map([['m1', null]]));
    const checker: ActorPatientConversationAccessChecker = { canReadPatientConversation: jest.fn().mockResolvedValue(true) };
    const useCase = new GetNotificationsUseCase(repo, checker);

    const [dto] = await useCase.execute({ recipientUid: 'me', limit: 20 });

    expect(dto.messageExcerpt).toBeNull();
  });
});
