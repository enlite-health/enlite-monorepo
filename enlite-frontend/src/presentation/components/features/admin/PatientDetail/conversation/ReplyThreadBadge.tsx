/**
 * ReplyThreadBadge — selo (pill) de contagem de respostas no rodapé do card de mensagem de TOPO
 * (ajustes de UI B5, rodada 2, pedido do Gabriel: trocar o texto "N respuestas" por um selo
 * intuitivo). Fica no rodapé, agrupado com "Responder" (`ConversationPanel.MessageItem`), nunca
 * numa reply (thread é de 1 nível — ver `ThreadView.MessageContent`, `footer` nunca passado lá).
 *
 * 🔒 Contraste do número (medido nesta sessão, luminância relativa W3C): `bg-primary` (`#180149`)
 * com texto branco dá 18.43:1 — muito acima do piso AA (4.5:1). Mesmo par cor de fundo/texto que
 * o botão "Enviar" do compositor já usa (`Button variant="primary"`), reaproveitado aqui.
 *
 * 🔒 `count >= 100` mostra "99+" (VISUAL — o selo é pequeno, um número de 3+ dígitos não cabe sem
 * quebrar o layout do rodapé). O `aria-label`/`title` sempre levam a contagem REAL (nunca "99+"
 * capado) — quem usa leitor de tela ou passa o mouse recebe o número exato, só o dígito impresso
 * no selo é que trunca.
 *
 * 🔒 Texto SEM a palavra "thread"/"hilo"/"fio" (pedido do Gabriel): nada de técnico no que o
 * usuário lê. `aria-label`/`title` são só "N respuesta(s)"/"N resposta(s)" — nunca "... en el
 * hilo"/"... na thread". "Thread" continua valendo como nome de CÓDIGO (`onOpenThread`, o
 * componente `ReplyThreadBadge`, `ThreadView.tsx`) — só o texto visível ao usuário mudou.
 */
import { useTranslation } from 'react-i18next';
import { MessageCircle } from 'lucide-react';

const BADGE_DISPLAY_CAP = 99;

export interface ReplyThreadBadgeProps {
  count: number;
  onOpenThread: () => void;
}

export function ReplyThreadBadge({ count, onOpenThread }: ReplyThreadBadgeProps): JSX.Element | null {
  const { t } = useTranslation();

  if (count < 1) return null;

  const displayCount = count > BADGE_DISPLAY_CAP ? `${BADGE_DISPLAY_CAP}+` : String(count);
  const label = t('admin.patients.detail.conversation.thread.repliesBadge', { count });

  return (
    <button
      type="button"
      onClick={onOpenThread}
      aria-label={label}
      title={label}
      data-testid="conversation-message-replies"
      className="flex items-center gap-1 rounded-full bg-primary text-white px-2 py-0.5 text-xs leading-none hover:opacity-90"
    >
      <MessageCircle size={12} aria-hidden="true" />
      <span data-testid="conversation-message-replies-count">{displayCount}</span>
    </button>
  );
}
