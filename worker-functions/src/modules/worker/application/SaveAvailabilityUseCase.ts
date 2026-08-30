import { IWorkerRepository } from '../ports/IWorkerRepository';
import { IAvailabilityRepository } from '../ports/IAvailabilityRepository';
import { SaveAvailabilityDTO, Worker } from '../domain/Worker';
import { Result } from '@shared/utils/Result';
import { DAY_NAMES_ES } from '@shared/utils/dateFormatters';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

const toMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

export class SaveAvailabilityUseCase {
  constructor(
    private workerRepository: IWorkerRepository,
    private availabilityRepository: IAvailabilityRepository,
  ) {}

  async execute(data: SaveAvailabilityDTO): Promise<Result<Worker>> {
    const workerResult = await this.workerRepository.findById(data.workerId);

    if (workerResult.isFailure) {
      return Result.fail<Worker>(workerResult.error!);
    }

    // Mensagens de erro em es-AR: o toast do app mostra este texto direto ao
    // prestador — nada de inglês nem detalhe técnico aqui.
    const worker = workerResult.getValue();
    if (!worker) {
      return Result.fail<Worker>('No encontramos tu registro. Cerrá sesión y volvé a entrar.');
    }

    if (data.availability.length === 0) {
      return Result.fail<Worker>('Dejá al menos un día con horario cargado.');
    }

    // Valida TUDO antes de tocar o banco: um slot inválido não pode custar a
    // disponibilidade já salva (o frontend auto-salva estados intermediários,
    // então payload inválido aqui é rotina, não exceção). Slots idênticos
    // (mesmo dia+início+fim) são deduplicados em silêncio: é o duplo toque no
    // "+" do app, não intenção do prestador. Mensagens em es: o toast do app
    // mostra este texto direto ao prestador.
    const seen = new Set<string>();
    const slots: SaveAvailabilityDTO['availability'] = [];
    for (const slot of data.availability) {
      if (!Number.isInteger(slot.dayOfWeek) || slot.dayOfWeek < 0 || slot.dayOfWeek > 6) {
        return Result.fail<Worker>(`Horario inválido: día de la semana fuera de rango (${slot.dayOfWeek})`);
      }
      const day = DAY_NAMES_ES[slot.dayOfWeek];
      if (!TIME_RE.test(slot.startTime) || !TIME_RE.test(slot.endTime)) {
        return Result.fail<Worker>(`Horario inválido el ${day}: formato de hora no reconocido`);
      }
      if (!slot.crossesMidnight && toMinutes(slot.endTime) <= toMinutes(slot.startTime)) {
        return Result.fail<Worker>(
          `Horario inválido el ${day} (${slot.startTime}–${slot.endTime}): la hora de fin debe ser posterior a la de inicio`,
        );
      }

      const key = `${slot.dayOfWeek}|${slot.startTime}|${slot.endTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(slot);
    }

    const timezone = worker.timezone || 'UTC';

    // Delete + insert numa transação única: se qualquer insert falhar, o delete
    // sofre rollback junto e a disponibilidade anterior fica intacta. (Antes
    // eram duas transações — um save falhado destruía os slots existentes e o
    // worker caía de REGISTERED em silêncio.)
    const replaceResult = await this.availabilityRepository.replaceByWorkerId(
      data.workerId,
      slots.map(slot => ({
        workerId: data.workerId,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        timezone,
        crossesMidnight: slot.crossesMidnight || false,
      }))
    );

    if (replaceResult.isFailure) {
      // O detalhe técnico (erro SQL) vai pro log; o prestador recebe mensagem
      // amigável — erro de banco não é acionável por quem está no app.
      console.warn(
        `[SaveAvailabilityUseCase] replace failed | workerId: ${data.workerId} | error: ${replaceResult.error}`,
      );
      return Result.fail<Worker>(
        'No pudimos guardar tu disponibilidad. Esperá un momento y probá de nuevo.',
      );
    }

    await this.workerRepository.recalculateStatus(data.workerId);

    return Result.ok<Worker>(worker);
  }
}
