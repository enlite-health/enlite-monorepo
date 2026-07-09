import { Request, Response } from 'express';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { InitWorkerUseCase } from '../../application/InitWorkerUseCase';
import { SaveStepUseCase } from '../../application/SaveStepUseCase';
import { GetWorkerProgressUseCase } from '../../application/GetWorkerProgressUseCase';

export class WorkerController {
  private workerRepository: WorkerRepository;

  constructor() {
    this.workerRepository = new WorkerRepository();
  }

  async initWorker(req: Request, res: Response): Promise<void> {
    try {
      const { authUid, email, phone, country } = req.body;

      if (!authUid || !email) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: authUid, email',
        });
        return;
      }

      const useCase = new InitWorkerUseCase(this.workerRepository);
      const result = await useCase.execute({
        authUid,
        email,
        phone,
        country: country || 'AR',
      });

      if (result.isFailure) {
        res.status(400).json({
          success: false,
          error: result.error,
        });
        return;
      }

      res.status(201).json({
        success: true,
        data: result.getValue(),
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }

  async saveStep(req: Request, res: Response): Promise<void> {
    try {
      const { workerId, step, data } = req.body;

      if (!workerId || step === undefined) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: workerId, step',
        });
        return;
      }

      const useCase = new SaveStepUseCase(this.workerRepository);
      const result = await useCase.execute({ workerId, step, data });

      if (result.isFailure) {
        res.status(400).json({
          success: false,
          error: result.error,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: result.getValue(),
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }

  async getProgress(req: Request, res: Response): Promise<void> {
    try {
      const authUid = req.headers['x-auth-uid'] as string;

      if (!authUid) {
        res.status(401).json({
          success: false,
          error: 'Missing authentication header: x-auth-uid',
        });
        return;
      }

      const useCase = new GetWorkerProgressUseCase(this.workerRepository);
      const result = await useCase.execute(authUid);

      if (result.isFailure) {
        res.status(404).json({
          success: false,
          error: result.error,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: result.getValue(),
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }
}
