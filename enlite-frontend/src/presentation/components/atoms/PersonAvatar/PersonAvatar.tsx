/**
 * PersonAvatar — átomo de avatar por INICIAIS com cor determinística por identificador (spec 022,
 * Rodada 2/R2-F — núcleo extraído de `MessageAvatar.tsx`, que agora é um wrapper fino em cima
 * deste átomo; ver docstring dele para o histórico e a régua de cor/contraste, que não muda aqui).
 *
 * Extraído para reuso fora do chat: o popup de menção estilo ClickUp (`configureMentionSuggestion`
 * → módulo `features/mentions`) precisa do MESMO avatar, com a bolinha de presença.
 *
 * `presence` é OPCIONAL e ausente por padrão: sem ela, o DOM é idêntico ao de antes (div única,
 * sem wrapper) — os 3 lugares que já usam avatar por iniciais (`MessageAvatar` em `ThreadView`/
 * `NotificationCard`) nunca pedem presença e continuam bit-a-bit iguais.
 */
import { getInitials } from '@presentation/utils/getInitials';
import { PresenceDot, type Presence } from '@presentation/components/atoms/PresenceDot';

const AVATAR_BG_CLASSES = ['bg-primary', 'bg-new-car', 'bg-clinic', 'bg-blue-yonder'] as const;

function hashToIndex(input: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

export interface PersonAvatarProps {
  /** Chave do hash de cor — estável por pessoa (nunca o nome, que pode mudar/ficar "?" antes de resolver). */
  uid: string;
  /** Nome de exibição já resolvido — usado só para as iniciais. */
  name: string;
  size?: number;
  className?: string;
  /** Bolinha de presença no canto (Rodada 2, popup de menção estilo ClickUp). Ausente = sem
   * bolinha nenhuma — comportamento idêntico ao `MessageAvatar` de antes desta extração. */
  presence?: Presence;
  'data-testid'?: string;
}

export function PersonAvatar({
  uid, name, size = 32, className = '', presence, 'data-testid': testId = 'person-avatar',
}: PersonAvatarProps): JSX.Element {
  const bgClass = AVATAR_BG_CLASSES[hashToIndex(uid, AVATAR_BG_CLASSES.length)];
  const circle = (
    <div
      data-testid={testId}
      aria-hidden="true"
      style={{ width: size, height: size, minWidth: size }}
      className={`rounded-full ${bgClass} text-white flex items-center justify-center flex-shrink-0 font-lexend font-semibold text-xs ${className}`}
    >
      {getInitials(name)}
    </div>
  );

  if (!presence) return circle;

  return (
    <div className="relative inline-flex flex-shrink-0" style={{ width: size, height: size }}>
      {circle}
      <PresenceDot
        presence={presence}
        className="absolute bottom-0 right-0 w-2.5 h-2.5 border-2 border-white"
      />
    </div>
  );
}
