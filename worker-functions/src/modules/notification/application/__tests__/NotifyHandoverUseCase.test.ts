/**
 * NotifyHandoverUseCase.test.ts
 *
 * Cenários:
 * 1. kill-switch OFF (default) → {skipped:true}, NENHUMA chamada
 * 2. team=recruitment → mensagem no grupo de recrutamento, com nome, phone,
 *    motivo e link da conversa; ticket best-effort tentado
 * 3. team=community_manager → grupo de comunidade
 * 4. motivo longo → truncado a 200 chars + '…' na mensagem
 * 5. grupo não configurado pro team → groupNotified=false, ticket ainda tentado
 * 6. falha do grupo (false) e do ticket (false) → resultado reporta, NUNCA lança
 * 7. sem workerName → 'Sin nombre'
 */
import { NotifyHandoverUseCase } from '../NotifyHandoverUseCase';

jest.mock('@shared/logging', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  reportError: jest.fn(),
}));

const RECRUITMENT_GROUP = '120363334377379340@g.us';
const COMMUNITY_GROUP = '120363000000000000@g.us';

describe('NotifyHandoverUseCase', () => {
  let groupNotify: { sendToGroup: jest.Mock };
  let ticketService: { createTicket: jest.Mock };
  let useCase: NotifyHandoverUseCase;
  const OLD_ENV = process.env;

  const baseInput = {
    workerPhone: '+5491122364870',
    workerName: 'Gastón Rodríguez',
    team: 'recruitment' as const,
    reason: 'Pregunta valor hora / encuadre',
    conversationId: 1145,
  };

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.HANDOVER_NOTIFY_ENABLED = 'true';
    process.env.PERISKOPE_GROUP_RECRUITMENT_ID = RECRUITMENT_GROUP;
    process.env.PERISKOPE_GROUP_COMMUNITY_ID = COMMUNITY_GROUP;
    process.env.CHATWOOT_URL = 'https://chatwoot.example.app';
    groupNotify = { sendToGroup: jest.fn().mockResolvedValue(true) };
    ticketService = { createTicket: jest.fn().mockResolvedValue(true) };
    useCase = new NotifyHandoverUseCase(
      groupNotify as never,
      ticketService as never,
    );
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('kill-switch OFF → skipped, nenhuma chamada', async () => {
    delete process.env.HANDOVER_NOTIFY_ENABLED;
    const result = await useCase.execute(baseInput);
    expect(result).toEqual({ skipped: true, groupNotified: false, ticketCreated: false });
    expect(groupNotify.sendToGroup).not.toHaveBeenCalled();
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it('recruitment → grupo certo, mensagem com nome/phone/motivo/link', async () => {
    const result = await useCase.execute(baseInput);
    expect(result).toEqual({ skipped: false, groupNotified: true, ticketCreated: true });
    expect(groupNotify.sendToGroup).toHaveBeenCalledTimes(1);
    const [groupId, message] = groupNotify.sendToGroup.mock.calls[0];
    expect(groupId).toBe(RECRUITMENT_GROUP);
    expect(message).toContain('Reclutamiento');
    expect(message).toContain('Gastón Rodríguez');
    expect(message).toContain('+5491122364870');
    expect(message).toContain('Pregunta valor hora');
    expect(message).toContain(
      'https://chatwoot.example.app/app/accounts/1/conversations/1145',
    );
    expect(ticketService.createTicket).toHaveBeenCalledWith(
      '+5491122364870',
      expect.stringContaining('Handover Luz'),
    );
  });

  it('community_manager → grupo de comunidade', async () => {
    await useCase.execute({ ...baseInput, team: 'community_manager' });
    expect(groupNotify.sendToGroup.mock.calls[0][0]).toBe(COMMUNITY_GROUP);
    expect(groupNotify.sendToGroup.mock.calls[0][1]).toContain('Comunidad');
  });

  it('motivo longo é truncado a 200 chars na mensagem', async () => {
    const longReason = 'x'.repeat(300);
    await useCase.execute({ ...baseInput, reason: longReason });
    const message: string = groupNotify.sendToGroup.mock.calls[0][1];
    expect(message).toContain(`${'x'.repeat(200)}…`);
    expect(message).not.toContain('x'.repeat(201));
  });

  it('grupo não configurado → groupNotified=false, ticket ainda tentado', async () => {
    delete process.env.PERISKOPE_GROUP_RECRUITMENT_ID;
    const result = await useCase.execute(baseInput);
    expect(result).toEqual({ skipped: false, groupNotified: false, ticketCreated: true });
    expect(groupNotify.sendToGroup).not.toHaveBeenCalled();
    expect(ticketService.createTicket).toHaveBeenCalledTimes(1);
  });

  it('falhas best-effort são reportadas, nunca lançadas', async () => {
    groupNotify.sendToGroup.mockResolvedValue(false);
    ticketService.createTicket.mockResolvedValue(false);
    const result = await useCase.execute(baseInput);
    expect(result).toEqual({ skipped: false, groupNotified: false, ticketCreated: false });
  });

  it('sem workerName → "Sin nombre"', async () => {
    const { workerName: _omit, ...semNome } = baseInput;
    await useCase.execute(semNome);
    expect(groupNotify.sendToGroup.mock.calls[0][1]).toContain('Sin nombre');
  });
});
