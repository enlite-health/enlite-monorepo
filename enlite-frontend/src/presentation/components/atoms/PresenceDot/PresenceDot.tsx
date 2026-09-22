/**
 * PresenceDot — bolinha de presença (spec 022, Rodada 2/R2-F). Decisão do Gabriel (22/09):
 * "bolinha de presença no canto (verde online / cinza offline, com aria-label)" no popup de
 * menção estilo ClickUp. Átomo isolado (não só uma div solta em `PersonAvatar`) porque presença é
 * reusável fora do avatar (ex.: uma futura lista de staff sem avatar ao lado do nome).
 *
 * `role="img"` + `aria-label`: a cor sozinha não é acessível (daltonismo, leitor de tela) — o
 * estado tem de ser dizível, não só visível.
 */
import { useTranslation } from 'react-i18next';

export type Presence = 'online' | 'offline';

export interface PresenceDotProps {
  presence: Presence;
  className?: string;
}

const COLOR_CLASS: Record<Presence, string> = {
  online: 'bg-green-500',
  offline: 'bg-gray-400',
};

export function PresenceDot({ presence, className = '' }: PresenceDotProps): JSX.Element {
  const { t } = useTranslation();
  const label = t(`common.presence.${presence}`, presence === 'online' ? 'En línea' : 'Desconectado');
  return (
    <span
      data-testid="presence-dot"
      role="img"
      aria-label={label}
      className={`inline-block rounded-full ${COLOR_CLASS[presence]} ${className}`}
    />
  );
}
