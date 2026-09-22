/**
 * PresenceDot — bolinha de presença (spec 022, Rodada 2/R2-F). Decisão do Gabriel (22/09):
 * "bolinha de presença no canto (verde online / cinza offline, com aria-label)" no popup de
 * menção estilo ClickUp. Átomo isolado (não só uma div solta em `PersonAvatar`) porque presença é
 * reusável fora do avatar (ex.: uma futura lista de staff sem avatar ao lado do nome).
 *
 * `role="img"` + `aria-label`: a cor sozinha não é acessível (daltonismo, leitor de tela) — o
 * estado tem de ser dizível, não só visível.
 *
 * 🔒 P2 (achado do gate, medido nesta sessão via fórmula WCAG 2.1 — luminância relativa,
 * `(L1+0.05)/(L2+0.05)`): as cores originais falhavam o contraste NÃO-TEXTUAL de 1.4.11 (≥3:1)
 * contra o fundo branco por trás da borda — `bg-green-500` (Tailwind padrão, #22C55E) media
 * **2.28:1** e `bg-gray-400` (paleta CUSTOM deste projeto, #ECEFF1 — quase branco, ver memória
 * "escala de cinza não é Tailwind") media **1.15:1**. Trocados por `green-600` (#16A34A,
 * **3.30:1**) e `gray-800` (#737373, custom, **4.74:1** — o único cinza da escala que se enxerga
 * contra branco). Ambos SEMPRE com a borda branca (`border-white`, aplicada por quem usa este
 * átomo) separando do avatar atrás — é essa borda, não o avatar, o "adjacente" do 1.4.11.
 */
import { useTranslation } from 'react-i18next';

export type Presence = 'online' | 'offline';

export interface PresenceDotProps {
  presence: Presence;
  className?: string;
}

const COLOR_CLASS: Record<Presence, string> = {
  online: 'bg-green-600',
  offline: 'bg-gray-800',
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
