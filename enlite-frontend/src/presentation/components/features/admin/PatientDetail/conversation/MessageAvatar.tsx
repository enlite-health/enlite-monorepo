/**
 * MessageAvatar — avatar do cabeçalho do CARD de mensagem (spec 022, ajustes de UI B5, molde
 * ClickUp). Sempre INICIAIS com cor determinística por `uid`, nunca foto.
 *
 * 🔒 Por quê nunca foto (achado desta sessão, `grep -rn "photoUrl\|avatar_url" src`):
 * `StaffDirectoryEntry`/`AdminStaffDirectoryController` (`GET /api/admin/staff-directory`) só
 * expõe `{ uid, displayName, isOnline }` — não existe `photoUrl` de staff em lugar nenhum que a
 * conversa já leia. O pedido original ("foto se o diretório JÁ tiver") é condicional a um campo
 * que HOJE não existe nesse contrato; criar endpoint/campo novo para isto é escopo novo (regra
 * dura: achado fora do aprovado vai para lista, não pro diff). `WorkerAvatar` (`atoms/WorkerAvatar`)
 * é o componente de foto do domínio de WORKER (AT) — semântica errada para staff interno, e mesmo
 * lá teria um `avatarUrl` que não temos aqui. Por isso: iniciais sempre.
 *
 * 🔒 WRAPPER FINO (Rodada 2/R2-F, commit "atoms PersonAvatar/PresenceDot"): o núcleo (hash de
 * cor + iniciais) foi extraído para `@presentation/components/atoms/PersonAvatar` — reusado pelo
 * popup de menção estilo ClickUp (`features/mentions`), que também precisa de avatar+presença.
 * Este componente só fixa o `data-testid="message-avatar"` (histórico, os 2 callers de produção —
 * `ThreadView.tsx`, `NotificationCard.tsx` — e o teste próprio dependem dele) e NÃO expõe
 * `presence`: o card de mensagem nunca mostrou presença, e nada aqui pede isso hoje.
 *
 * Cor por hash do `uid` — só entre os 4 tokens do tema que passam WCAG AA (≥ 4.5:1) com texto
 * branco (medido nesta sessão, luminância relativa W3C): `primary` (18.43:1), `new-car` (6.46:1),
 * `clinic` (5.33:1), `blue-yonder` (4.76:1). Os outros tokens do tema (`care`, `learn`,
 * `pink-cancel`, `turquoise`, `coordination`, `cyan-focus`, `wait`, `navbar-active`, `cancelled`)
 * ficam TODOS abaixo de 4.5:1 com branco — nunca usados aqui. Nenhuma cor nova foi criada.
 */
import { PersonAvatar } from '@presentation/components/atoms/PersonAvatar';

export interface MessageAvatarProps {
  /** Chave do hash de cor — `authorUid` (estável por autor, nunca o nome, que pode ficar "?" antes de resolver). */
  uid: string;
  /** Nome de exibição já resolvido (`useStaffDisplayName`) — usado só para as iniciais. */
  name: string;
  size?: number;
  className?: string;
}

export function MessageAvatar({ uid, name, size = 32, className = '' }: MessageAvatarProps): JSX.Element {
  return <PersonAvatar uid={uid} name={name} size={size} className={className} data-testid="message-avatar" />;
}
