import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { useContactNotes } from '@hooks/admin/useContactNotes';
import { ContactNoteItem } from './ContactNoteItem';

const MAX_NOTE_LENGTH = 240;

interface ContactNotesModalProps {
  vacancyId: string;
  workerId: string;
  workerName: string | null;
  onClose: () => void;
}

export function ContactNotesModal({
  vacancyId,
  workerId,
  workerName,
  onClose,
}: ContactNotesModalProps): JSX.Element {
  const { t } = useTranslation();
  const {
    notes,
    isLoading,
    isCreating,
    deletingId,
    error,
    fetchNotes,
    createNote,
    deleteNote,
  } = useContactNotes(vacancyId, workerId);

  const [noteText, setNoteText] = useState('');

  useEffect(() => {
    void fetchNotes();
  }, [fetchNotes]);

  const trimmedText = noteText.trim();
  const isSubmitDisabled =
    trimmedText.length === 0 || noteText.length > MAX_NOTE_LENGTH || isCreating;

  async function handleSubmit() {
    if (isSubmitDisabled) return;
    await createNote({ noteText: trimmedText });
    setNoteText('');
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleBackdropClick}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex flex-col gap-0.5">
            <Heading level={3} weight="semibold" color="secondary">
              {t('admin.vacancyDetail.funnelTable.contactNotes.modalTitle')}
            </Heading>
            {workerName && (
              <Text as="span" size="xs" color="muted">
                {workerName}
              </Text>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Notes list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3 min-h-0">
          {isLoading && notes.length === 0 && (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          )}

          {!isLoading && notes.length === 0 && (
            <div className="py-8 flex justify-center">
              <Text size="sm" color="muted">
                {t('admin.vacancyDetail.funnelTable.contactNotes.emptyState')}
              </Text>
            </div>
          )}

          {error && (
            <Text size="xs" color="muted" className="text-red-600">
              {t('admin.vacancyDetail.funnelTable.contactNotes.loadError')}
            </Text>
          )}

          {notes.map((note) => (
            <ContactNoteItem
              key={note.id}
              note={note}
              canDelete={note.canDelete}
              isDeleting={deletingId === note.id}
              onDelete={deleteNote}
            />
          ))}
        </div>

        {/* Compose area */}
        <div className="px-6 py-4 border-t border-slate-200 flex flex-col gap-2">
          <Textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            maxLength={MAX_NOTE_LENGTH}
            rows={3}
            resize="none"
            placeholder={t(
              'admin.vacancyDetail.funnelTable.contactNotes.textareaPlaceholder',
            )}
            disabled={isCreating}
          />
          <div className="flex items-center justify-between">
            <Text as="span" size="xs" color="muted">
              {t('admin.vacancyDetail.funnelTable.contactNotes.charCounter', {
                count: noteText.length,
              })}
            </Text>
            {/* POST .../contact-notes → funnel:write (D269). */}
            <ActionButton
              resource="funnel"
              action="write"
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={isSubmitDisabled}
              isLoading={isCreating}
            >
              {isCreating
                ? t(
                    'admin.vacancyDetail.funnelTable.contactNotes.registering',
                  )
                : t(
                    'admin.vacancyDetail.funnelTable.contactNotes.registerButton',
                  )}
            </ActionButton>
          </div>
        </div>
      </div>
    </div>
  );
}
