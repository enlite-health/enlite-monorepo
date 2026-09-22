/**
 * Barrel do módulo de menção (spec 022, Rodada 2/R2-F) — presença, notificações e menção nascem
 * modularizados para reuso fora do compositor de conversa. Ver `mentionPopupPosition.ts`,
 * `MentionPopupList.tsx`, `createMentionSuggestion.ts`, `mentionChip.ts`.
 */
export { clampMentionPopupPosition } from './mentionPopupPosition';
export type { AnchorRect, PopupSize, ViewportSize, PopupPosition } from './mentionPopupPosition';
export { MentionPopupList } from './MentionPopupList';
export type { MentionPopupListProps } from './MentionPopupList';
export { configureMentionSuggestion } from './createMentionSuggestion';
export type { ConfigureMentionSuggestionOptions } from './createMentionSuggestion';
export { mentionChipRenderText, mentionChipRenderHTML } from './mentionChip';
