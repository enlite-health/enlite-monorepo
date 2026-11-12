/** Tons do selo do painel de custos e o par fundo/texto de cada um (só classes padrão do Tailwind, sem hex). O teste de contraste lê ESTE mapa. */
export type ChipTone = 'neutral' | 'new' | 'estimated' | 'none' | 'alert';

/** Par fundo/texto por tom. O teste de contraste lê ESTE mapa. */
export const CHIP_TONES: Record<ChipTone, { bg: string; fg: string; extra?: string }> = {
  neutral: { bg: 'bg-gray-300', fg: 'text-primary' },
  new: { bg: 'bg-blue-100', fg: 'text-blue-950' },
  estimated: { bg: 'bg-amber-100', fg: 'text-amber-950' },
  none: { bg: 'bg-red-100', fg: 'text-red-950' },
  alert: { bg: 'bg-amber-100', fg: 'text-amber-950', extra: 'ring-1 ring-inset ring-amber-800' },
};
