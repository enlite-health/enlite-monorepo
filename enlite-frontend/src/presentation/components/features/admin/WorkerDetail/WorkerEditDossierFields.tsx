import type { UseFormRegister } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useHasCell } from '@presentation/hooks/useCellAccess';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import type { WorkerEditFormValues } from './WorkerEditModal';

interface Props {
  register: UseFormRegister<WorkerEditFormValues>;
}

/**
 * Dossiê do prestador dentro do drawer de edição — spec 025 (Fase 6, D402 item 4). Hoje só
 * `birthDate`. Gated por `worker_pii:write`, célula CUMULATIVA a `worker:update` (o gate do
 * botão "Guardar" continua sendo `worker:update` — este campo pede a célula A MAIS, checada
 * também no backend em `AdminWorkerProfileController.updateProfile`).
 *
 * Sem a célula, o campo NÃO RENDERIZA — não fica desabilitado, some da árvore — mesma régua
 * de `WorkerPersonalInfoCard.showDossier` (quem não tem a célula não sabe que o campo existe).
 *
 * `<input type="date">` dá validação de calendário REAL do navegador (não deixa digitar
 * 31/02 nem mês 13) e o valor do form já sai como `yyyy-MM-dd`, o formato ISO que o backend
 * exige (`isValidIsoBirthDate`).
 */
export function WorkerEditDossierFields({ register }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const canWriteDossier = useHasCell('worker_pii', 'write');

  if (!canWriteDossier) return null;

  return (
    <div className="flex flex-col gap-4 pt-2 border-t border-slate-100">
      <Text size="sm" weight="semibold" color="secondary">
        {t('admin.workerDetail.editModal.dossierSection', { defaultValue: 'Dossier' })}
      </Text>
      <FormField label={t('admin.workerDetail.birthDate')} htmlFor="we-birthDate">
        <InputWithIcon id="we-birthDate" type="date" inputSize="compact" data-testid="we-birthDate" {...register('birthDate')} />
      </FormField>
    </div>
  );
}
