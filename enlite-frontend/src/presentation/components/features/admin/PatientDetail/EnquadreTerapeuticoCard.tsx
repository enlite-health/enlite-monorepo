import { PlaceholderCard } from './PlaceholderCard';

/**
 * Spec 014 US-D2: card sem dado, sem endpoint — vira "título + Próximamente real" (era o kanban
 * de 4 colunas sempre vazias com botão "Agregar nuevo" `disabled` em cada uma).
 */
export function EnquadreTerapeuticoCard() {
  return <PlaceholderCard titleKey="admin.patients.detail.matchingCard.title" testId="enquadre-terapeutico-card" />;
}
