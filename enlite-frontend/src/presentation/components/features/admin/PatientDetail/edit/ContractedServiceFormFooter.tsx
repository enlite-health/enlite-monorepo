import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';

interface Props {
  /** `null` = serviço novo. */
  serviceId: string | null;
  index: number;
  busy: boolean;
  saveDisabled: boolean;
  saveLabel: string;
  onSave: () => void;
  /** Recusa do endereço (422): fica NA LINHA do Guardar — o select está lá em cima e o drawer rola. */
  addressLockedText: string | null;
  error: string | null;
}

/** Rodapé da linha do serviço: "Guardar" + a recusa do endereço + o erro do salvar. */
export function ContractedServiceFormFooter({ serviceId, index, busy, saveDisabled, saveLabel, onSave, addressLockedText, error }: Props): JSX.Element {
  const isNew = serviceId === null;
  return (
    <div className="flex items-center justify-between">
      <Button type="button" variant="primary" size="sm" onClick={onSave} isLoading={busy} disabled={saveDisabled} className="w-32" data-testid={isNew ? 'contracted-service-new-save' : `contracted-service-save-${serviceId}`}>
        {saveLabel}
      </Button>
      {addressLockedText && (
        <Text size="sm" className="text-red-600" data-testid={`svc-address-locked-${index}`}>{addressLockedText}</Text>
      )}
      {error && <Text size="sm" className="text-red-600" data-testid={isNew ? 'contracted-service-new-error' : `contracted-service-error-${serviceId}`}>{error}</Text>}
    </div>
  );
}
