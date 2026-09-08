/**
 * usePresentationInviteLast — último convite à reunión de presentación por worker (REQ-09).
 * O MESMO fetch para a tarjeta do Kanban e para a lista de prestadores: a lista mostrava
 * "Sin invitación" para quem foi convidada ontem porque só o Kanban consultava o /last.
 *
 * Devolve o mapa e o setter — quem enfileira um convite marca "agora" localmente sem refetch.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { AdminPresentationInviteApiService, type PresentationInviteLast } from '@infrastructure/http/AdminPresentationInviteApiService';

export function usePresentationInviteLast(
  workerIds: ReadonlyArray<string | null | undefined>,
  enabled = true,
): [PresentationInviteLast, Dispatch<SetStateAction<PresentationInviteLast>>] {
  const [last, setLast] = useState<PresentationInviteLast>({});
  // Chave estável: a lista de ids muda de identidade a cada render, o conteúdo não.
  const key = workerIds.filter((id): id is string => !!id).sort().join(',');
  useEffect(() => {
    if (!enabled || !key) return;
    let alive = true;
    AdminPresentationInviteApiService.last(key.split(','))
      // `?? {}` não é paranoia: o tipo promete um mapa, mas quem responde é a rede.
      // Um `data: null` no corpo (backend fora do ar, resposta vazia, mock de teste)
      // virava `null` aqui, e o Kanban inteiro caía na fronteira de erro no primeiro
      // `lastPresentationByWorker[workerId]` — tela em branco, "No pudimos cargar
      // esta página", para TODAS as tarjetas. O `.catch` já deixava a tela seguir
      // sem o "último convite"; o sucesso com corpo nulo é que não estava coberto.
      .then((m) => { if (alive) setLast(m ?? {}); })
      .catch(() => { /* sem "último convite" a tela segue; o botão continua funcionando */ });
    return () => { alive = false; };
  }, [enabled, key]);
  return [last, setLast];
}
