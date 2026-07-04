import { Text } from '@presentation/components/atoms/Text';

interface NotesCountBadgeProps {
  count: number;
}

/**
 * Pill compacto que mostra quantos comentários (contact notes) um candidato tem.
 * Renderiza nada quando count é 0 — a própria presença sinaliza "tem comentário".
 * Compartilhado entre a tabela do funil e o card do Kanban para manter consistência.
 */
export function NotesCountBadge({ count }: NotesCountBadgeProps): JSX.Element | null {
  if (count <= 0) return null;
  return (
    <span
      data-testid="notes-count-badge"
      aria-label={`${count} comentario${count !== 1 ? 's' : ''}`}
      className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-primary text-white"
    >
      <Text as="span" size="xs" weight="medium" color="white" className="text-[10px] leading-none">
        {count}
      </Text>
    </span>
  );
}
