/**
 * UpdatePresenceUseCase — R2-B (change 022-ux-mencao-e-notificacao, Rodada 2). Delegação fina:
 * o throttle real mora no SQL de `AdminRepository.touchPresence` (coberto pelo unit dele mesmo,
 * `AdminRepository.touchPresence.test.ts`) — aqui só se prova que a use case chama o repositório
 * com o uid certo e nunca lança mesmo quando o repositório sinaliza "não regravou" (throttle).
 */
import { UpdatePresenceUseCase } from '../UpdatePresenceUseCase';
import type { AdminRepository } from '../../infrastructure/AdminRepository';

describe('UpdatePresenceUseCase', () => {
  it('delega ao repositório com o uid recebido', async () => {
    const touchPresence = jest.fn().mockResolvedValue(true);
    const useCase = new UpdatePresenceUseCase({ touchPresence } as unknown as AdminRepository);

    await useCase.execute('uid-1');

    expect(touchPresence).toHaveBeenCalledWith('uid-1');
  });

  it('resolve normalmente quando o repositório devolve false (throttle segurou)', async () => {
    const touchPresence = jest.fn().mockResolvedValue(false);
    const useCase = new UpdatePresenceUseCase({ touchPresence } as unknown as AdminRepository);

    await expect(useCase.execute('uid-1')).resolves.toBeUndefined();
  });
});
