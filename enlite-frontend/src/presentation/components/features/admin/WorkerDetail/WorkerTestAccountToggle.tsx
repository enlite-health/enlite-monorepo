import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { Text } from '@presentation/components/atoms/Text';
import { useActionGate } from '@presentation/hooks/useCellAccess';

interface WorkerTestAccountToggleProps {
  workerId: string;
  initialIsTest: boolean;
}

/**
 * Checkbox para marcar um prestador como conta de teste.
 *
 * A visibilidade é da CÉLULA, não de papel: o toggle chama
 * PATCH /api/admin/workers/:id/test-flag → worker:write. D269 — o checkbox não
 * é `<Button>`, então usa `useActionGate` direto: sem a célula (com enforcement
 * `on`) o componente inteiro deixa de montar; com o engine desligado, aparece.
 */
export function WorkerTestAccountToggle({ workerId, initialIsTest }: WorkerTestAccountToggleProps): JSX.Element | null {
  const { t } = useTranslation();
  const workerWriteGate = useActionGate('worker', 'update');

  const [isTest, setIsTest] = useState(initialIsTest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (workerWriteGate.denied) return null;

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    const previous = isTest;
    setIsTest(next);
    setBusy(true);
    setError(null);
    try {
      const result = await AdminApiService.updateWorkerTestFlag(workerId, next);
      setIsTest(result.isTest);
    } catch {
      setIsTest(previous);
      setError(t('admin.workerDetail.testAccount.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6 bg-white rounded-card border-2 border-gray-600 px-4 py-3 sm:px-6 sm:py-4">
      <label className="flex items-center gap-3 cursor-pointer" htmlFor="worker-test-account">
        <input
          id="worker-test-account"
          type="checkbox"
          checked={isTest}
          onChange={handleChange}
          disabled={busy}
          data-testid="worker-test-account-checkbox"
          className="w-4 h-4 accent-primary cursor-pointer disabled:opacity-50"
        />
        <span className="flex flex-col">
          <Text as="span" size="sm" weight="medium" color="secondary">
            {t('admin.workerDetail.testAccount.label')}
          </Text>
          <Text as="span" size="xs" color="muted">
            {t('admin.workerDetail.testAccount.hint')}
          </Text>
        </span>
      </label>
      {error && (
        <Text size="xs" className="text-red-600 mt-2">{error}</Text>
      )}
    </div>
  );
}
