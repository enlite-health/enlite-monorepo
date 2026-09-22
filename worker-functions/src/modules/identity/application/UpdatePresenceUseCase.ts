/**
 * UpdatePresenceUseCase — heartbeat de presença (change 022-ux-mencao-e-notificacao, Rodada
 * 2/R2-B). Delegação fina ao repositório — o throttle de 30s mora inteiro na cláusula SQL de
 * `AdminRepository.touchPresence` (atômico, sem round-trip de leitura). Esta camada existe pela
 * mesma razão que `MarkAllNotificationsReadUseCase` existe fininha: separa APLICAÇÃO de
 * controller mesmo quando o corpo é uma linha, para outro caller (teste, job) não precisar
 * conhecer o repositório concreto.
 */
import { AdminRepository } from '../infrastructure/AdminRepository';

export class UpdatePresenceUseCase {
  constructor(private readonly adminRepo: AdminRepository = new AdminRepository()) {}

  /**
   * Sempre resolve — o throttle (skip silencioso quando o `last_seen_at` atual tem menos de 30s)
   * não é erro, é o comportamento correto: o cliente manda heartbeat a cada ~60s sem precisar
   * saber se o servidor de fato regravou desta vez.
   */
  async execute(firebaseUid: string): Promise<void> {
    await this.adminRepo.touchPresence(firebaseUid);
  }
}
