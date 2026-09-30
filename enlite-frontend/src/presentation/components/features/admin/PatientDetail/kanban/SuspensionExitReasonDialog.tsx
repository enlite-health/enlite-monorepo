import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { SuspensionExitReasonSelect } from '../SuspensionExitReasonSelect';

export interface SuspensionExitReasonDialogProps {
  /** Nome do paciente, para o corpo da pergunta ("Fulano vai passar de Suspendido a X"). */
  patientName: string;
  /** Rótulo JÁ TRADUZIDO da coluna de destino (mesma chave que o cabeçalho da coluna usa). */
  targetStatusLabel: string;
  onConfirm: (suspensionExitReason: string) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
}

/**
 * Gabriel, 2ª rodada (decisão sobre o item Kanban): arrastar um card de "Suspendido" para outra
 * coluna PEDE O MOTIVO — não move otimisticamente, não move nada até confirmar. Molde de diálogo:
 * `ConfirmValidationModal` (WorkerDetail) — overlay fixo + `role="dialog"`/`aria-modal` +
 * Escape fecha + clique fora cancela (clique DENTRO não propaga) — é o único par do projeto que
 * já tinha as DUAS travas de acessibilidade (teclado E clique fora); os outros diálogos
 * (`ResendConfirmDialog` etc.) só têm o botão de fechar.
 *
 * O select é `SuspensionExitReasonSelect` — o MESMO que a ficha usa (zero duplicação, pedido do
 * Gabriel): as 5 opções e a tradução vêm de um lugar só.
 */
export function SuspensionExitReasonDialog({
  patientName,
  targetStatusLabel,
  onConfirm,
  onCancel,
  isSubmitting = false,
}: SuspensionExitReasonDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      data-testid="kanban-suspension-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kanban-suspension-dialog-title"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-card shadow-xl w-full max-w-md p-6 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <Heading level={3} id="kanban-suspension-dialog-title" weight="semibold" color="secondary">
          {t('admin.patients.kanban.suspensionExitDialog.title')}
        </Heading>
        <Text size="sm" color="secondary">
          {t('admin.patients.kanban.suspensionExitDialog.body', { name: patientName, target: targetStatusLabel })}
        </Text>

        <SuspensionExitReasonSelect
          id="kanban-suspension-exit-reason"
          value={reason}
          onChange={setReason}
          data-testid="kanban-suspension-exit-reason"
        />

        <div className="flex justify-end gap-3 mt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={isSubmitting}
            data-testid="kanban-suspension-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => onConfirm(reason)}
            disabled={!reason || isSubmitting}
            isLoading={isSubmitting}
            data-testid="kanban-suspension-confirm"
          >
            {t('admin.patients.kanban.suspensionExitDialog.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
