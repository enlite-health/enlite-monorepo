import { RejectionReasonSelect } from '@presentation/components/features/admin/Kanban/RejectionReasonSelect';
import { useServiceExitReasonOptions } from '@hooks/admin/useServiceExitReasonOptions';

type CatalogRejectionSelectProps = Omit<React.ComponentProps<typeof RejectionReasonSelect>, 'labeledOptions' | 'options' | 'optionKeyPrefix'>;

/**
 * Diálogo de motivo de REJEITAR do Encuadre (D2): as opções são o catálogo de motivos de saída ATIVOS
 * (rótulo já pronto, `labeledOptions`), não mais a lista fixa de 4. Montado só quando o diálogo abre,
 * então o GET só sai quando alguém vai rejeitar. Enquanto carrega (ou se falhar) a lista vem vazia e
 * "Confirmar" fica desabilitado.
 */
export function CatalogRejectionSelect(props: CatalogRejectionSelectProps): JSX.Element {
  const { options } = useServiceExitReasonOptions();
  return <RejectionReasonSelect {...props} labeledOptions={(options ?? []).map((o) => ({ value: o.code, label: o.label }))} />;
}
