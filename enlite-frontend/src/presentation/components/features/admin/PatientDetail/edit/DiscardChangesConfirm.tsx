import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface Props {
  onKeepEditing: () => void;
  onDiscard: () => void;
}

/**
 * Spec 014 (US-D4, lex D4 AUTORIZADO sem condição): confirmação de "perder trabalho" ao fechar
 * um drawer de edição da ficha por Esc/backdrop/X com o formulário `dirty`. Componente
 * compartilhado (extraído UMA vez, usado pelos 8 drawers de `PatientDetail/edit/`) em vez de
 * copiar o markup em cada um — junto com `useConfirmDiscardClose` (a lógica de quando mostrar).
 * Renderiza SOBRE o drawer (o próprio drawer fica visível atrás, `z-[60]` > o drawer `z-50`).
 */
export function DiscardChangesConfirm({ onKeepEditing, onDiscard }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" data-testid="discard-changes-confirm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 flex flex-col gap-4">
        <Heading level={4} weight="semibold" color="primary">{te('discardChangesTitle')}</Heading>
        <Text size="sm" color="secondary">{te('discardChangesBody')}</Text>
        <div className="flex justify-end gap-3 mt-2">
          <Button type="button" variant="outline" size="sm" onClick={onKeepEditing} data-testid="discard-changes-keep-editing">
            {te('discardChangesKeepEditing')}
          </Button>
          <Button type="button" variant="primary" size="sm" onClick={onDiscard} data-testid="discard-changes-discard">
            {te('discardChangesDiscard')}
          </Button>
        </div>
      </div>
    </div>
  );
}
