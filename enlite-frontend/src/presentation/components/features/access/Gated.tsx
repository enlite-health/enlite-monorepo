import type { ReactNode } from 'react';
import { useCellAccess } from '@presentation/hooks/useCellAccess';
import type { AccessLevel } from '@domain/entities/Authz';

interface GatedProps {
  /** O recurso da célula (`recurso:read` / `recurso:write`). */
  resource: string;
  /** Nível mínimo para existir. Default `read`; `write` para ações de conclusão. */
  atLeast?: Exclude<AccessLevel, 'hidden'>;
  children: ReactNode | ((access: { level: AccessLevel; canWrite: boolean }) => ReactNode);
}

/**
 * O componente só EXISTE se o ator tem a célula. Não é `display:none`, não é
 * `disabled`: abaixo do nível pedido, devolve `null` e nada entra na árvore.
 * Quem precisa saber o nível dentro recebe `children` como função.
 */
export function Gated({ resource, atLeast = 'read', children }: GatedProps): JSX.Element | null {
  const access = useCellAccess(resource);
  if (access.level === 'hidden') return null;
  if (atLeast === 'write' && !access.canWrite) return null;
  const content = typeof children === 'function' ? children({ level: access.level, canWrite: access.canWrite }) : children;
  return <>{content}</>;
}
