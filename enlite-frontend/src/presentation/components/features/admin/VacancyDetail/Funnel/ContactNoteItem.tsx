import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import type { ContactNote } from '@domain/entities/ContactNote';

interface ContactNoteItemProps {
  note: ContactNote;
  /** True quando o operador logado é o autor E ainda está na janela de 2h. */
  canDelete: boolean;
  isDeleting: boolean;
  onDelete: (noteId: string) => void;
}

function formatNoteDate(iso: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function ContactNoteItem({
  note,
  canDelete,
  isDeleting,
  onDelete,
}: ContactNoteItemProps): JSX.Element {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  // DELETE .../contact-notes/:noteId → funnel:write (D269). Botão raw
  // `<button>` (não `<Button>`): useActionGate direto, combinado com a
  // regra de negócio existente (autor + janela de 2h).
  const { allowed: canWriteFunnel } = useActionGate('funnel', 'write');
  const canDeleteThisNote = canDelete && canWriteFunnel;

  const author = note.createdByAdminName ?? note.createdByAdminEmail;

  return (
    <div
      data-testid="contact-note-item"
      className="flex flex-col gap-1 bg-slate-50 rounded-xl px-4 py-3"
    >
      <div className="flex items-start justify-between gap-2">
        <Text as="p" size="sm" color="secondary" className="min-w-0 flex-1">
          {note.noteText}
        </Text>

        {canDeleteThisNote && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={isDeleting}
            aria-label={t('admin.vacancyDetail.funnelTable.contactNotes.deleteAria')}
            data-testid="contact-note-delete"
            className="shrink-0 text-red-500 hover:text-red-700 transition-colors disabled:opacity-50"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {canDeleteThisNote && confirming ? (
        <div className="flex items-center gap-3 pt-1">
          <Text as="span" size="xs" color="muted">
            {t('admin.vacancyDetail.funnelTable.contactNotes.deleteConfirm')}
          </Text>
          <button
            type="button"
            onClick={() => onDelete(note.id)}
            disabled={isDeleting}
            data-testid="contact-note-delete-confirm"
            className="text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            <Text as="span" size="xs" weight="medium" color="inherit">
              {isDeleting
                ? t('admin.vacancyDetail.funnelTable.contactNotes.deleting')
                : t('admin.vacancyDetail.funnelTable.contactNotes.deleteYes')}
            </Text>
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={isDeleting}
            className="text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            <Text as="span" size="xs" weight="medium" color="inherit">
              {t('admin.vacancyDetail.funnelTable.contactNotes.deleteCancel')}
            </Text>
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          {author && (
            <Text as="span" size="xs" color="muted">
              {author}
            </Text>
          )}
          <Text as="span" size="xs" color="muted">
            {formatNoteDate(note.createdAt)}
          </Text>
        </div>
      )}
    </div>
  );
}
