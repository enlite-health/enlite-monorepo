import { Trash2 } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';

interface Props {
  /** "Servicio N" (+ "— inactivo" quando em baixa). */
  heading: string;
  /** `null` = serviço novo (sem baixa; tem o "fechar"). */
  serviceId: string | null;
  active: boolean;
  busy: boolean;
  closeLabel: string;
  deactivateLabel: string;
  onCancelNew?: () => void;
  onDeactivate: () => void;
}

/** Cabeçalho da linha do serviço: "Servicio N" + (novo) fechar / (existente ativo) "Dar de baja". */
export function ContractedServiceFormHeader({ heading, serviceId, active, busy, closeLabel, deactivateLabel, onCancelNew, onDeactivate }: Props): JSX.Element {
  const isNew = serviceId === null;
  return (
    <div className="flex items-center justify-between">
      <Text size="sm" weight="semibold" color="secondary">{heading}</Text>
      <div className="flex items-center gap-2">
        {isNew && onCancelNew && (
          <button type="button" onClick={onCancelNew} aria-label={closeLabel} data-testid="contracted-service-new-cancel" className="text-slate-400 hover:text-slate-700 p-1 rounded">
            <Trash2 className="w-4 h-4" />
          </button>
        )}
        {!isNew && active && (
          <Button type="button" variant="outline" size="sm" onClick={onDeactivate} isLoading={busy} data-testid={`contracted-service-deactivate-${serviceId}`}>
            {deactivateLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
