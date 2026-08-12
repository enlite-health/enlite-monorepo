import { ChatwootClient } from '@modules/notification/infrastructure/ChatwootClient';
import { logger } from '@shared/logging';

/**
 * Constrói o ChatwootClient compartilhado para espelho de outbound, ou retorna null
 * quando CHATWOOT_MIRROR_ENABLED != 'true' ou faltam credenciais.
 *
 * Extraído de src/index.ts para manter o composition root abaixo do limite de 400 linhas.
 */
export function buildChatwootClient(): ChatwootClient | null {
  if (process.env.CHATWOOT_MIRROR_ENABLED !== 'true') return null;
  const baseUrl = process.env.CHATWOOT_URL;
  const apiToken = process.env.CHATWOOT_API_TOKEN;
  const accountId = Number(process.env.CHATWOOT_ACCOUNT_ID || '1');
  const inboxId = Number(process.env.CHATWOOT_TWILIO_INBOX_ID || '1');
  if (!baseUrl || !apiToken) {
    logger.warn({ msg: '[Chatwoot] MIRROR_ENABLED=true mas CHATWOOT_URL/CHATWOOT_API_TOKEN ausentes — espelho desabilitado.' });
    return null;
  }
  logger.info({ msg: '[Chatwoot] Espelho de outbound habilitado', accountId, inboxId });
  return new ChatwootClient({ baseUrl, apiToken, accountId, inboxId });
}
