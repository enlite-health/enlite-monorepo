import { z } from 'zod';
import { MANUAL_CHANGE_SOURCES } from '../../domain/enums/PatientChangeSource';

/**
 * Query de `GET /patients/:id/status-options` (spec 051). A lista só vale para QUEM vai chamar o
 * PUT: o `PUT /status` aceita duas origens manuais (D469 libera funil→SEARCHING para `kanban` e
 * não para `admin_panel`), então a lista recebe a origem. Só `MANUAL_CHANGE_SOURCES` (fonte única);
 * ausente = `admin_panel` (o select da ficha); qualquer outro valor (inclusive `system` e
 * `*_override`) é 400.
 */
export const statusOptionsQuerySchema = z.object({
  changeSource: z.enum(MANUAL_CHANGE_SOURCES).default('admin_panel'),
});
