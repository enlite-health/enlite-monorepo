import type { ReactNode } from 'react';
import { useContainerAccess } from '@presentation/hooks/useCellAccess';

interface ContainerGateProps {
  /** Recurso do container (`patient_family`). */
  resource: string;
  children: ReactNode | ((access: { canWrite: boolean }) => ReactNode);
}

/**
 * D286 — some (do DOM, não desabilitado) o card/bloco de um container para quem não tem a célula
 * de leitura dele. A resposta da API já chegou projetada (o dado nem viajou); este gate só evita
 * mostrar um card vazio com marcador "redigido" onde a pessoa não tem nada a fazer.
 *
 * `children` como função recebe `canWrite` para o card decidir se oferece o botão de editar
 * (o próprio `ActionButton resource=… action="write"` também some sozinho — os dois valem).
 */
export function ContainerGate({ resource, children }: ContainerGateProps): JSX.Element | null {
  const access = useContainerAccess(resource);
  if (!access.visible) return null;
  return <>{typeof children === 'function' ? children({ canWrite: access.canWrite }) : children}</>;
}
