/**
 * Modal de contestação (1.5b, D344 — revoga em parte D342/D343 do protótipo). Divergências do
 * protótipo (`repos/infra/_worktrees/proto-anacare-horas/.../AnaCareHours/ContestModal.tsx`):
 *  - Motivo passa a ser um `<select>` de lista FECHADA (`ContestReason`/`CONTEST_REASONS`,
 *    `types.ts`) — a confirmação exige motivo escolhido, não mais "qualquer texto".
 *    Fonte do enum: `docs/decisoes.md` D344; `openspec/changes/anacare-conferencia-de-horas/
 *    specs/anacare-shift-hours/spec.md:296-298`.
 *  - A nota em texto livre passa a ser OPCIONAL (antes era obrigatória) e ganha limite de
 *    caracteres (`CONTEST_NOTE_MAX_LENGTH`, `types.ts`) com contador visível.
 *  - Aviso fixo "No incluya información clínica del paciente" (D344).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Label } from '@presentation/components/atoms/Label';
import { Select } from '@presentation/components/atoms/Select';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { CONTEST_NOTE_MAX_LENGTH, CONTEST_REASONS, type ContestReason } from './types';

interface ContestModalProps {
  shiftDate: string;
  onConfirm: (reason: ContestReason, note: string) => void;
  onCancel: () => void;
}

/** Regra travada (1.5b): contestar EXIGE motivo de lista fechada — o botão de confirmar fica desabilitado até um motivo ser escolhido. A nota é opcional. */
export function ContestModal({ shiftDate, onConfirm, onCancel }: ContestModalProps): JSX.Element {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ContestReason | ''>('');
  const [note, setNote] = useState('');
  const overLimit = note.length > CONTEST_NOTE_MAX_LENGTH;
  const canConfirm = reason !== '' && !overLimit;

  const reasonOptions = CONTEST_REASONS.map((value) => ({ value, label: t(`admin.anacareHours.contestModal.reasons.${value}`) }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="anacare-hours-contest-modal">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6 flex flex-col gap-4">
        <Heading level={3}>{t('admin.anacareHours.contestModal.title', { date: shiftDate })}</Heading>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="anacare-hours-contest-reason" required>
            {t('admin.anacareHours.contestModal.reasonLabel')}
          </Label>
          <Select
            id="anacare-hours-contest-reason"
            options={reasonOptions}
            value={reason}
            onValueChange={(v) => setReason(v as ContestReason)}
            placeholder={t('admin.anacareHours.contestModal.reasonPlaceholder')}
            aria-label={t('admin.anacareHours.contestModal.reasonLabel')}
            data-testid="anacare-hours-contest-reason"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="anacare-hours-contest-note">{t('admin.anacareHours.contestModal.noteLabel')}</Label>
          <Textarea
            id="anacare-hours-contest-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('admin.anacareHours.contestModal.notePlaceholder')}
            rows={4}
            maxLength={CONTEST_NOTE_MAX_LENGTH + 1}
            data-testid="anacare-hours-contest-note"
          />
          <Text size="xs" className={overLimit ? '!text-red-600' : undefined} data-testid="anacare-hours-contest-note-count">
            {t('admin.anacareHours.contestModal.noteCount', { count: note.length, max: CONTEST_NOTE_MAX_LENGTH })}
          </Text>
          <Text size="xs" className="!text-amber-700" data-testid="anacare-hours-contest-clinical-warning">
            {t('admin.anacareHours.contestModal.clinicalWarning')}
          </Text>
        </div>

        <div className="flex justify-end gap-3 mt-2">
          <Button variant="outline" onClick={onCancel} data-testid="anacare-hours-contest-cancel">
            {t('admin.anacareHours.contestModal.cancel')}
          </Button>
          <Button
            onClick={() => canConfirm && onConfirm(reason as ContestReason, note.trim())}
            disabled={!canConfirm}
            data-testid="anacare-hours-contest-confirm"
          >
            {t('admin.anacareHours.contestModal.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
