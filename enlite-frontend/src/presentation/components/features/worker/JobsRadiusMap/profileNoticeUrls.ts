import type { MissingProfileItem } from '@domain/entities/WorkerJobByRadius';
import { buildProfileUrl, destinationFor } from '@presentation/utils/incompleteFieldDestinations';

/** Para onde cada item leva: as MESMAS rotas que o "Completar" da home já usa (`/worker/profile?tab=…&focus=…`). */
const TOKEN_BY_ITEM: Record<MissingProfileItem, string> = {
  address: 'worker_service_areas',
  profession: 'profession',
  sex: 'sex',
  availability: 'worker_availability',
};

export const profileUrlFor = (item: MissingProfileItem): string => buildProfileUrl(destinationFor(TOKEN_BY_ITEM[item]));
