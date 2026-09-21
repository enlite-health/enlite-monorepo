import { GetUnreadCountUseCase } from '../GetUnreadCountUseCase';
import type { NotificationRepository } from '../../infrastructure/NotificationRepository';

describe('GetUnreadCountUseCase', () => {
  it('repassa recipientUid ao repositório e devolve a contagem', async () => {
    const repo = { countUnread: jest.fn().mockResolvedValue(7) } as unknown as NotificationRepository;
    const useCase = new GetUnreadCountUseCase(repo);

    expect(await useCase.execute('me')).toBe(7);
    expect(repo.countUnread).toHaveBeenCalledWith('me');
  });
});
