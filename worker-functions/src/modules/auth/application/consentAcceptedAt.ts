/**
 * Hora em que a cuidadora marcou a caixa do aceite (o app guarda e manda no `phone/confirm`). O servidor NÃO confia no
 * relógio do aparelho às cegas: a janela aceita é [agora − 24 h, agora + 5 min].
 *   - futuro: aceite não pode ter acontecido depois de agora; os 5 min só absorvem relógio de celular adiantado.
 *   - anterior a 24 h: o aceite pendente é de uma sessão velha (app fechado, outro texto da política); a pessoa marca de novo.
 * Fora da janela (ou data ilegível) = `null`: quem chama devolve INVALID_CONSENT_AT e NADA é gravado.
 * Dentro da janela, a hora é limitada a `agora` (nunca grava uma hora futura, mesmo no limite dos 5 min).
 */
export const CONSENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CONSENT_MAX_SKEW_MS = 5 * 60 * 1000;

export function resolveConsentAcceptedAt(raw: string, now: Date = new Date()): Date | null {
  // ISO-8601 com fuso explícito: `2026-11-24` ou `1700000000` seriam lidos como hora local/ambígua.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  const delta = now.getTime() - at.getTime();
  if (delta < -CONSENT_MAX_SKEW_MS || delta > CONSENT_MAX_AGE_MS) return null;
  return at.getTime() > now.getTime() ? now : at;
}
