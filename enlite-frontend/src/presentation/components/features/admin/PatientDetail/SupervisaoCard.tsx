import { PlaceholderCard } from './PlaceholderCard';

/**
 * Spec 014 US-D2: card sem dado, sem endpoint — vira "título + Próximamente real" (era mesa
 * fantasma: tabela sempre vazia, botão "Nuevo" `disabled` sem ação, busca `readOnly` decorativa).
 */
export function SupervisaoCard() {
  return <PlaceholderCard titleKey="admin.patients.detail.supervisionCard.title" testId="supervisao-card" />;
}
