import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { useVacancyNotes } from '@hooks/admin/useVacancyNotes';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { formatDateTime } from './draftVacancyFormat';
import { VacancyNoteForm } from './VacancyNoteForm';
import type { CreateVacancyNotePayload } from '@domain/entities/VacancyNote';

interface VacancyNotesPanelProps {
  vacancyId: string;
}

export function VacancyNotesPanel({ vacancyId }: VacancyNotesPanelProps) {
  const { t, i18n } = useTranslation();
  const { notes, isLoading, isCreating, error, fetchNotes, createNote } = useVacancyNotes(vacancyId);
  const { allowed: canCreate } = useActionGate('vacancy', 'update');
  const [showForm, setShowForm] = useState(false);
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    void fetchNotes();
  }, [fetchNotes]);

  const handleSubmit = async (payload: CreateVacancyNotePayload) => {
    setSaveError(false);
    try {
      await createNote(payload);
      setShowForm(false);
    } catch {
      setSaveError(true);
    }
  };

  return (
    <div
      data-testid="vacancy-notes-panel"
      className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4"
    >
      <div className="flex items-center justify-between">
        <Heading level={3} weight="semibold" color="secondary">
          {t('admin.vacancyDetail.notes.title')}
        </Heading>
        {canCreate && !showForm && (
          <Button
            data-testid="vacancy-notes-new-button"
            size="sm"
            onClick={() => setShowForm(true)}
          >
            {t('admin.vacancyDetail.notes.newButton')}
          </Button>
        )}
      </div>

      {showForm && (
        <div className="flex flex-col gap-2">
          <VacancyNoteForm
            onSubmit={handleSubmit}
            onCancel={() => {
              setShowForm(false);
              setSaveError(false);
            }}
            isSaving={isCreating}
          />
          {saveError && (
            <Text size="sm" color="inherit" className="text-red-600">
              {t('admin.vacancyDetail.notes.saveError')}
            </Text>
          )}
        </div>
      )}

      {!isLoading && !showForm && error && notes.length === 0 && (
        <Text size="sm" color="inherit" className="text-red-600">
          {t('admin.vacancyDetail.notes.loadError')}
        </Text>
      )}

      {!isLoading && notes.length === 0 && !error && (
        <Text size="sm" color="secondary">
          {t('admin.vacancyDetail.notes.empty')}
        </Text>
      )}

      {notes.length > 0 && (
        <Table>
          <TableHeader>
            <TableHead>{t('admin.vacancyDetail.notes.when')}</TableHead>
            <TableHead>{t('admin.vacancyDetail.notes.category')}</TableHead>
            <TableHead>{t('admin.vacancyDetail.notes.contact')}</TableHead>
            <TableHead>{t('admin.vacancyDetail.notes.body')}</TableHead>
            <TableHead>{t('admin.vacancyDetail.notes.author')}</TableHead>
          </TableHeader>
          <TableBody>
            {notes.map((n) => (
              <TableRow key={n.id} data-testid={`vacancy-note-row-${n.id}`}>
                <TableCell>{formatDateTime(n.occurredAt, i18n.language)}</TableCell>
                <TableCell>
                  {t(`admin.vacancyDetail.notes.categoryOptions.${n.category}`, n.category)}
                </TableCell>
                <TableCell>{n.contact}</TableCell>
                <TableCell>{n.body}</TableCell>
                <TableCell>{n.authorEmail ?? n.createdBy}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
