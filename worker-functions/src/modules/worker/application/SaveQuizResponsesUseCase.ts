import { IWorkerRepository } from '../ports/IWorkerRepository';
import { IQuizResponseRepository } from '../ports/IQuizResponseRepository';
import { SaveQuizResponseDTO } from '../domain/Worker';
import { Result } from '@shared/utils/Result';

export class SaveQuizResponsesUseCase {
  constructor(
    private workerRepository: IWorkerRepository,
    private quizResponseRepository: IQuizResponseRepository
  ) {}

  async execute(data: SaveQuizResponseDTO): Promise<Result<void>> {
    const workerResult = await this.workerRepository.findById(data.workerId);
    
    if (workerResult.isFailure) {
      return Result.fail<void>(workerResult.error!);
    }

    const worker = workerResult.getValue();
    if (!worker) {
      return Result.fail<void>('Worker not found');
    }

    for (const response of data.responses) {
      const saveResult = await this.quizResponseRepository.create({
        workerId: data.workerId,
        sectionId: response.sectionId,
        questionId: response.questionId,
        answerId: response.answerId,
      });

      if (saveResult.isFailure) {
        return Result.fail<void>(saveResult.error!);
      }
    }

    // const updateResult = await this.workerRepository.updateStep({
    //   workerId: data.workerId,
    //   step: 2,
    //   status: 'in_progress',
    // }); // current_step column no longer exists

    // if (updateResult.isFailure) {
    //   return Result.fail<void>(updateResult.error!);
    // }

    return Result.ok<void>();
  }
}
