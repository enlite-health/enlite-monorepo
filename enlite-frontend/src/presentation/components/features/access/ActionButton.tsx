import { Button, type ButtonProps } from '@presentation/components/atoms/Button';
import { useCellAccess } from '@presentation/hooks/useCellAccess';

interface ActionButtonProps extends ButtonProps {
  /** O recurso cuja célula `:write` autoriza esta ação. */
  resource: string;
}

/**
 * Um botão que CONCLUI edição (salvar, criar, arquivar, adicionar, remover,
 * ligar/desligar). Sem `recurso:write` ele não existe — não fica cinza, não
 * fica com tooltip: some. Botão desabilitado ainda é promessa de que a ação
 * existe para quem tiver sorte; aqui a promessa só aparece quando é verdade.
 */
export function ActionButton({ resource, ...props }: ActionButtonProps): JSX.Element | null {
  const { canWrite } = useCellAccess(resource);
  if (!canWrite) return null;
  return <Button {...props} />;
}
