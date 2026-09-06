import { PlaceholderCard } from './PlaceholderCard';

/**
 * Spec 014 US-D2: card sem dado, sem endpoint — vira "título + Próximamente real" (era mesa
 * fantasma: tabela sempre vazia, botões "Editar"/"Nuevo" `disabled` sem ação, busca `readOnly`).
 */
export function RelatoriosAtendimentosCard() {
  return <PlaceholderCard titleKey="admin.patients.detail.attendanceReportsCard.title" testId="relatorios-atendimentos-card" />;
}
