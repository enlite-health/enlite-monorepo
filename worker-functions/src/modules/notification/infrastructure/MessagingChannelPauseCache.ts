import { Pool } from 'pg';

const DEFAULT_TTL_MS = 20000; // 20s — dentro da janela 15-30s do parecer

/**
 * MessagingChannelPauseCache — cache em memória do kill-switch
 * messaging_channel_pause, com expiração (TTL).
 *
 * Mesmo padrão do contentActionsCache de InboundWhatsAppController, mas com
 * expiração: o kill-switch precisa refletir uma pausa administrativa em
 * segundos, não "até o próximo deploy" (contentActionsCache nunca expira
 * porque templates raramente mudam — pausa de canal é o oposto: mudança
 * urgente e precisa propagar rápido).
 */
export class MessagingChannelPauseCache {
  private readonly cache = new Map<string, { paused: boolean; expiresAt: number }>();

  constructor(
    private readonly db: Pool,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  async isPaused(channel: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(channel);
    if (cached && cached.expiresAt > now) {
      return cached.paused;
    }

    const result = await this.db.query<{ paused: boolean }>(
      `SELECT paused FROM messaging_channel_pause WHERE channel = $1 LIMIT 1`,
      [channel],
    );
    // Canal sem linha na tabela = nunca pausado explicitamente = não pausado.
    const paused = result.rows[0]?.paused ?? false;

    this.cache.set(channel, { paused, expiresAt: now + this.ttlMs });
    return paused;
  }

  /** Invalida o cache imediatamente. Sem argumento, limpa todos os canais. */
  invalidate(channel?: string): void {
    if (channel) {
      this.cache.delete(channel);
    } else {
      this.cache.clear();
    }
  }
}
