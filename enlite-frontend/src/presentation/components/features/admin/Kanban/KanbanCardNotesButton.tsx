import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { NotesCountBadge } from '@presentation/components/features/admin/VacancyDetail/Funnel/NotesCountBadge';

interface Props {
  onOpen: () => void;
  count: number;
  /** Só o ícone (com aria-label/title), para ir na linha da tag do card. Ausente = botão largo do funil da vaga. */
  compact?: boolean;
}

/** Botão de comentários do card: o mesmo `notes-button` em duas formas (largo no funil, só ícone no evento de enquadre). */
export function KanbanCardNotesButton({ onOpen, count, compact = false }: Props) {
  const { t } = useTranslation();
  const label = t('admin.kanban.notesButton');
  return (
    <button
      data-testid="notes-button"
      type="button"
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={
        compact
          ? 'ml-auto flex items-center gap-1 px-1 h-5 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-primary transition-colors border border-transparent hover:border-slate-200'
          : 'mt-2 w-full flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-slate-600 hover:bg-slate-100 hover:text-primary transition-colors border border-transparent hover:border-slate-200'
      }
    >
      <MessageSquare className="w-3 h-3" />
      {!compact && label}
      <NotesCountBadge count={count} />
    </button>
  );
}
