import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@presentation/components/atoms/Label';
import { Input } from '@presentation/components/atoms/Input';
import { Select } from '@presentation/components/atoms/Select';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { Button } from '@presentation/components/atoms/Button';
import {
  VACANCY_NOTE_CATEGORIES,
  type VacancyNoteCategory,
  type CreateVacancyNotePayload,
} from '@domain/entities/VacancyNote';
import { toOperationDateTimeLocal, parseOperationDateTimeLocal } from '@presentation/utils/dateTimeFormat';

interface VacancyNoteFormProps {
  onSubmit: (payload: CreateVacancyNotePayload) => void;
  onCancel: () => void;
  isSaving: boolean;
}

export function VacancyNoteForm({ onSubmit, onCancel, isSaving }: VacancyNoteFormProps) {
  const { t } = useTranslation();
  const [when, setWhen] = useState(() => toOperationDateTimeLocal(new Date()));
  const [category, setCategory] = useState<VacancyNoteCategory>('CONTATO');
  const [contact, setContact] = useState('');
  const [body, setBody] = useState('');

  const categoryOptions = VACANCY_NOTE_CATEGORIES.map((cat) => ({
    value: cat,
    label: t(`admin.vacancyDetail.notes.categoryOptions.${cat}`, cat),
  }));

  // O valor do input é a hora de -03 (Buenos Aires), não a do navegador; vira o instante UTC certo.
  const occurredAtIso = parseOperationDateTimeLocal(when);
  const isWhenValid = occurredAtIso !== null;
  const canSave = isWhenValid && contact.trim().length > 0 && body.trim().length > 0 && !isSaving;

  const handleSave = () => {
    if (!canSave || occurredAtIso === null) return;
    onSubmit({
      occurredAt: occurredAtIso,
      category,
      contact: contact.trim(),
      body: body.trim(),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label htmlFor="vacancy-note-when">{t('admin.vacancyDetail.notes.when')}</Label>
        <Input
          id="vacancy-note-when"
          data-testid="vacancy-note-when"
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="vacancy-note-category">{t('admin.vacancyDetail.notes.category')}</Label>
        <Select
          id="vacancy-note-category"
          data-testid="vacancy-note-category"
          options={categoryOptions}
          value={category}
          onValueChange={(value) => setCategory(value as VacancyNoteCategory)}
        />
      </div>
      <div>
        <Label htmlFor="vacancy-note-contact">{t('admin.vacancyDetail.notes.contact')}</Label>
        <Input
          id="vacancy-note-contact"
          data-testid="vacancy-note-contact"
          maxLength={120}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="vacancy-note-body">{t('admin.vacancyDetail.notes.body')}</Label>
        <Textarea
          id="vacancy-note-body"
          data-testid="vacancy-note-body"
          maxLength={2000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <div className="flex gap-3">
        <Button
          data-testid="vacancy-note-save"
          onClick={handleSave}
          disabled={!canSave}
          isLoading={isSaving}
        >
          {t('admin.vacancyDetail.notes.save')}
        </Button>
        <Button
          data-testid="vacancy-note-cancel"
          variant="outline"
          onClick={onCancel}
          disabled={isSaving}
        >
          {t('admin.vacancyDetail.notes.cancel')}
        </Button>
      </div>
    </div>
  );
}
