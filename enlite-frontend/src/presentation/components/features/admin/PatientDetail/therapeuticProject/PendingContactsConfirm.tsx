/**
 * PendingContactsConfirm — passo de confirmação DENTRO do drawer do PT (spec 048; não é `window.confirm`) quando a
 * versão vai ser criada com algum campo de contato "Todavía no hay registro". Lista os campos pendentes com o vencimento
 * REAL de cada um, as datas REAIS dos lembretes que ainda faltam (no sino) e o aviso do dia 12 aos gestores.
 * Renderiza SOBRE o drawer (`z-[60]`), mesmo molde do `DiscardChangesConfirm`.
 */
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { dayMonth } from './contactStatusDates';

export interface PendingContactLine {
  /** Rótulo do campo (as mesmas chaves do formulário). */
  label: string;
  /** `YYYY-MM-DD`. */
  deadline: string;
}

interface Props {
  fields: PendingContactLine[];
  /** `YYYY-MM-DD` dos lembretes que ainda faltam; vazio = nenhum lembrete novo. */
  reminderDates: string[];
  saving: boolean;
  onBack: () => void;
  onConfirm: () => void;
}

export function PendingContactsConfirm({ fields, reminderDates, saving, onBack, onConfirm }: Props): JSX.Element {
  const { t } = useTranslation();
  const tp = (k: string, o?: Record<string, unknown>) => t(`admin.patients.detail.therapeuticProjectForm.pendingConfirm.${k}`, o ?? {});

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" data-testid="pending-contacts-confirm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 flex flex-col gap-4" role="alertdialog" aria-label={tp('title')}>
        <Heading level={4} weight="semibold" color="primary">{tp('title')}</Heading>
        <Text size="sm" color="secondary">{tp('body')}</Text>
        <ul className="list-disc pl-5 flex flex-col gap-1" data-testid="pending-contacts-list">
          {fields.map((f) => (
            <li key={f.label}>
              <Text as="span" size="sm" color="primary">{tp('item', { field: f.label, date: dayMonth(f.deadline) })}</Text>
            </li>
          ))}
        </ul>
        {reminderDates.length > 0 && (
          <Text size="sm" color="secondary" data-testid="pending-contacts-reminders">
            {tp('reminders', { dates: reminderDates.map(dayMonth).join(', ') })}
          </Text>
        )}
        <div className="flex justify-end gap-3 mt-2">
          <Button type="button" variant="outline" size="sm" onClick={onBack} disabled={saving} data-testid="pending-contacts-back">{tp('back')}</Button>
          <Button type="button" variant="primary" size="sm" onClick={onConfirm} disabled={saving} data-testid="pending-contacts-confirm-btn">{tp('confirm')}</Button>
        </div>
      </div>
    </div>
  );
}
