import { useEffect, useState } from 'react';
import { AreasApiService } from '@infrastructure/http/AreasApiService';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import type { AreaEntry } from '@domain/entities/MyAreas';
import { AreaSwitcher } from './AreaSwitcher';

/**
 * Encaixe do seletor no `AdminLayout`: carrega `GET /v1/me/areas` uma vez e entrega ao `AreaSwitcher`.
 * O seletor é conveniência, não porta: se a chamada falha, a tira simplesmente não aparece (o painel
 * não pode cair nem mostrar erro por causa dela), e a falha NÃO vira "lista vazia" para ninguém decidir nada.
 * O `AdminLayout` só existe dentro de `/admin`, então a área atual é sempre `backoffice`.
 */
export function AreaSwitcherSlot(): JSX.Element | null {
  const { user } = useAdminAuth();
  const [areas, setAreas] = useState<AreaEntry[]>([]);

  useEffect(() => {
    let vivo = true;
    AreasApiService.getMyAreas()
      .then((r) => {
        if (vivo) setAreas(r.areas);
      })
      .catch(() => {
        // silencioso de propósito (ver comentário do componente).
      });
    return () => {
      vivo = false;
    };
  }, []);

  return <AreaSwitcher areas={areas} currentArea="backoffice" uid={user?.id ?? null} />;
}
