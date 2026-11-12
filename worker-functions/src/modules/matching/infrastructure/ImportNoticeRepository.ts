import type { Pool, PoolClient } from 'pg';
import { TactiqLinkRepository } from './TactiqLinkRepository';
import type { ImportNoticeRecipients } from '../application/ImportBlockNotifier';

type Db = Pool | PoolClient;

/** Quem recebe o aviso da importação bloqueada (spec 083): uid ativo por e-mail e o nome do FUNCIONÁRIO (nunca dado de paciente). */
export class ImportNoticeRepository implements ImportNoticeRecipients {
  private readonly links: TactiqLinkRepository;

  constructor(private readonly db: Pool) {
    this.links = new TactiqLinkRepository(db);
  }

  /** Mesma regra do sino do vínculo (`TactiqLinkRepository.activeUserUidByEmail`), sem duplicar o SQL. */
  activeUidByEmail(email: string, ex: Db = this.db): Promise<string | null> {
    return this.links.activeUserUidByEmail(email, ex);
  }

  /** `interview_hosts.display_name` por e-mail sem caixa; `null` = fora do roster ou sem nome. */
  async hostDisplayName(email: string, ex: Db = this.db): Promise<string | null> {
    const { rows } = await ex.query<{ display_name: string | null }>(
      `SELECT display_name FROM interview_hosts WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    const name = rows[0]?.display_name?.trim();
    return name ? name : null;
  }
}
