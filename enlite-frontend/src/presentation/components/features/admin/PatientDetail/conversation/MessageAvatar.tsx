/**
 * MessageAvatar — avatar do cabeçalho do CARD de mensagem (spec 022, ajustes de UI B5, molde
 * ClickUp). Sempre INICIAIS com cor determinística por `uid`, nunca foto.
 *
 * 🔒 Por quê nunca foto (achado desta sessão, `grep -rn "photoUrl\|avatar_url" src`):
 * `StaffDirectoryEntry`/`AdminStaffDirectoryController` (`GET /api/admin/staff-directory`) só
 * expõe `{ uid, displayName }` — não existe `photoUrl` de staff em lugar nenhum que a conversa já
 * leia. O pedido original ("foto se o diretório JÁ tiver") é condicional a um campo que HOJE não
 * existe nesse contrato; criar endpoint/campo novo para isto é escopo novo (regra dura: achado
 * fora do aprovado vai para lista, não pro diff). `WorkerAvatar` (`atoms/WorkerAvatar`) é o
 * componente de foto do domínio de WORKER (AT) — semântica errada para staff interno, e mesmo lá
 * teria um `avatarUrl` que não temos aqui. Por isso: iniciais sempre, componente PRÓPRIO (não
 * reaproveita `WorkerAvatar` por semântica, mas reaproveita a MESMA forma: `rounded-full` +
 * `object-cover`/`flex items-center justify-center`).
 *
 * 🔒 Cor por hash do `uid` — só entre os 4 tokens do tema que passam WCAG AA (≥ 4.5:1) com texto
 * branco (medido nesta sessão, luminância relativa W3C): `primary` (18.43:1), `new-car` (6.46:1),
 * `clinic` (5.33:1), `blue-yonder` (4.76:1). Os outros tokens do tema (`care`, `learn`,
 * `pink-cancel`, `turquoise`, `coordination`, `cyan-focus`, `wait`, `navbar-active`, `cancelled`)
 * ficam TODOS abaixo de 4.5:1 com branco — nunca usados aqui. Nenhuma cor nova foi criada.
 */
const AVATAR_BG_CLASSES = ['bg-primary', 'bg-new-car', 'bg-clinic', 'bg-blue-yonder'] as const;

function hashToIndex(input: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

export interface MessageAvatarProps {
  /** Chave do hash de cor — `authorUid` (estável por autor, nunca o nome, que pode ficar "?" antes de resolver). */
  uid: string;
  /** Nome de exibição já resolvido (`useStaffDisplayName`) — usado só para as iniciais. */
  name: string;
  size?: number;
  className?: string;
}

export function MessageAvatar({ uid, name, size = 32, className = '' }: MessageAvatarProps): JSX.Element {
  const bgClass = AVATAR_BG_CLASSES[hashToIndex(uid, AVATAR_BG_CLASSES.length)];
  return (
    <div
      data-testid="message-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, minWidth: size }}
      className={`rounded-full ${bgClass} text-white flex items-center justify-center flex-shrink-0 font-lexend font-semibold text-xs ${className}`}
    >
      {getInitials(name)}
    </div>
  );
}
