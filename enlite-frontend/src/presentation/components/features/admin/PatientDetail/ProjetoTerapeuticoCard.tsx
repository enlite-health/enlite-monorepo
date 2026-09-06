import { PlaceholderCard } from './PlaceholderCard';

/**
 * Spec 014 US-D2 (spec explicitamente pede: "Proyecto Terapéutico fica com título +
 * 'Próximamente' real"): eram 10 rótulos `—` fixos (nenhum ligado a `patient`) + botões "Nuevo"/
 * "Editar" `disabled` sem ação + tabela de versões sempre vazia.
 */
export function ProjetoTerapeuticoCard() {
  return <PlaceholderCard titleKey="admin.patients.detail.therapeuticProjectCard.title" testId="projeto-terapeutico-card" />;
}
