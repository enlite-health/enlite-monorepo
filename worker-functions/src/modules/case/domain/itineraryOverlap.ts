/**
 * itineraryOverlap — o 409 do itinerário (DX-11.7): decodifica o `DETAIL` que a trava do banco
 * (`fn_patient_itinerary_assignment_no_overlap`, DX-11.3) grava no `23P01` e monta a mensagem de
 * erro. Só ids de serviço, dia e horário cruzam essa borda — a trava já garante isso no SQL
 * (DX-11.3: "só ids de serviço, dia e horário; nenhum nome, nenhum endereço, nada clínico"); este
 * arquivo não adiciona nada, só lê de volta o que o `DETAIL` trouxe.
 *
 * A folga mora num lugar só, a função SQL (DX-11.4): `minGapMinutes` vem do `DETAIL`, nunca de
 * constante — nenhum número de minutos hardcoded em lugar nenhum deste arquivo.
 */

export interface ItineraryOverlapSide {
  serviceId: string;
  weekday: number;
  startTime: string;
  endTime: string;
}

export class ItineraryOverlapError extends Error {
  constructor(
    readonly existing: ItineraryOverlapSide,
    readonly requested: ItineraryOverlapSide,
    readonly sameAddress: boolean,
    readonly minGapMinutes: number | null,
  ) {
    super('itinerary_overlap');
    this.name = 'ItineraryOverlapError';
  }
}

interface OverlapDetail {
  existingServiceId: string;
  existingWeekday: number;
  existingStart: string;
  existingEnd: string;
  requestedServiceId: string;
  requestedWeekday: number;
  requestedStart: string;
  requestedEnd: string;
  sameAddress: boolean;
  minGapMinutes: number | null;
}

/** Só os campos do erro do driver `pg` que interessam aqui — nunca o objeto inteiro do driver. */
export interface PgOverlapLikeError {
  code?: string;
  message?: string;
  detail?: string;
}

/**
 * `23P01` com mensagem `itinerary_overlap` e `DETAIL` legível → o erro decodificado. Qualquer
 * outra coisa (outro código, outra mensagem, `DETAIL` que não é JSON) → `null`, e o erro original
 * do Postgres segue seu caminho (quem chama decide o que fazer com ele).
 */
export function fromPgError(err: PgOverlapLikeError): ItineraryOverlapError | null {
  if (err.code !== '23P01' || err.message !== 'itinerary_overlap') return null;

  let detail: OverlapDetail;
  try {
    detail = JSON.parse(err.detail ?? '') as OverlapDetail;
  } catch {
    return null;
  }

  return new ItineraryOverlapError(
    {
      serviceId: detail.existingServiceId,
      weekday: detail.existingWeekday,
      startTime: detail.existingStart,
      endTime: detail.existingEnd,
    },
    {
      serviceId: detail.requestedServiceId,
      weekday: detail.requestedWeekday,
      startTime: detail.requestedStart,
      endTime: detail.requestedEnd,
    },
    detail.sameAddress,
    detail.minGapMinutes,
  );
}

function ladoParaTexto(side: ItineraryOverlapSide): string {
  return `dia ${side.weekday} ${side.startTime}-${side.endTime} (serviço ${side.serviceId})`;
}

/** A folga só entra na mensagem quando o conflito é entre endereços diferentes (`minGapMinutes !== null`). */
export function overlapMessage(err: ItineraryOverlapError): string {
  const base = `conflito de horário: ${ladoParaTexto(err.existing)} × ${ladoParaTexto(err.requested)}`;
  if (err.minGapMinutes === null) return base;
  return `${base}; folga mínima de ${err.minGapMinutes} min entre endereços`;
}
