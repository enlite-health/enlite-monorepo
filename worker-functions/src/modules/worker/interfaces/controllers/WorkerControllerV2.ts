import { Request, Response } from 'express';
import { InitWorkerUseCase } from '../../application/InitWorkerUseCase';
import { SaveQuizResponsesUseCase } from '../../application/SaveQuizResponsesUseCase';
import { SavePersonalInfoUseCase } from '../../application/SavePersonalInfoUseCase';
import { SaveServiceAreaUseCase } from '../../application/SaveServiceAreaUseCase';
import { SaveAvailabilityUseCase } from '../../application/SaveAvailabilityUseCase';
import { GetWorkerAvailabilityUseCase } from '../../application/GetWorkerAvailabilityUseCase';
import { GetWorkerProgressUseCase } from '../../application/GetWorkerProgressUseCase';
import { LookupWorkerByEmailUseCase } from '../../application/LookupWorkerByEmailUseCase';
import { WorkerRepository } from '../../infrastructure/WorkerRepository';
import { QuizResponseRepository } from '../../infrastructure/QuizResponseRepository';
import { ServiceAreaRepository } from '../../infrastructure/ServiceAreaRepository';
import { AvailabilityRepository } from '../../infrastructure/AvailabilityRepository';
import { EventDispatcher } from '@shared/services/EventDispatcher';
import { TwilioVerifyService } from '@modules/auth/infrastructure/TwilioVerifyService';
import { WORKER_ERROR_CODES } from '../../domain/workerErrors';
import { PubSubClient } from '@shared/events/PubSubClient';

/**
 * Mensagem amigável (pt-BR fallback do backend) para PHONE_NOT_AVAILABLE.
 * Por privacidade NÃO revela que o número pertence a outra conta. O frontend
 * localiza a partir do `code`; esta string é a rede de segurança caso não o faça.
 */
const PHONE_NOT_AVAILABLE_MESSAGE = 'El teléfono ingresado no puede ser utilizado.';

export class WorkerControllerV2 {
  private initWorkerUseCase: InitWorkerUseCase;
  private saveQuizUseCase: SaveQuizResponsesUseCase;
  private savePersonalInfoUseCase: SavePersonalInfoUseCase;
  private saveServiceAreaUseCase: SaveServiceAreaUseCase;
  private saveAvailabilityUseCase: SaveAvailabilityUseCase;
  private getAvailabilityUseCase: GetWorkerAvailabilityUseCase;
  private getProgressUseCase: GetWorkerProgressUseCase;
  private lookupWorkerByEmailUseCase: LookupWorkerByEmailUseCase;

  constructor() {
    const pubsub = new PubSubClient();
    const workerRepository = new WorkerRepository(pubsub);
    const quizRepository = new QuizResponseRepository();
    const serviceAreaRepository = new ServiceAreaRepository();
    const availabilityRepository = new AvailabilityRepository();
    const eventDispatcher = new EventDispatcher();

    const twilioVerifyService = new TwilioVerifyService();
    this.initWorkerUseCase = new InitWorkerUseCase(workerRepository, eventDispatcher, twilioVerifyService);
    this.saveQuizUseCase = new SaveQuizResponsesUseCase(workerRepository, quizRepository, eventDispatcher);
    this.savePersonalInfoUseCase = new SavePersonalInfoUseCase(workerRepository, undefined, pubsub);
    this.saveServiceAreaUseCase = new SaveServiceAreaUseCase(workerRepository, serviceAreaRepository);
    this.saveAvailabilityUseCase = new SaveAvailabilityUseCase(workerRepository, availabilityRepository);
    this.getAvailabilityUseCase = new GetWorkerAvailabilityUseCase(workerRepository, availabilityRepository);
    this.getProgressUseCase = new GetWorkerProgressUseCase(workerRepository);
    this.lookupWorkerByEmailUseCase = new LookupWorkerByEmailUseCase(workerRepository);
  }

  async initWorker(req: Request, res: Response): Promise<void> {
    try {
      const { authUid, email, phone, whatsappPhone, lgpdOptIn, country } = req.body;

      if (!authUid || !email) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: authUid, email',
        });
        return;
      }

      // Check if worker already exists — if so, return existing record
      const existingResult = await this.getProgressUseCase.execute(authUid);
      if (!existingResult.isFailure) {
        res.status(200).json({
          success: true,
          data: {
            status: 'ok',
            worker: existingResult.getValue(),
          },
        });
        return;
      }

      const result = await this.initWorkerUseCase.execute({
        authUid,
        email,
        phone: phone || undefined,
        whatsappPhone: whatsappPhone || undefined,
        lgpdOptIn: lgpdOptIn === true,
        country: country || 'AR',
      });

      if (result.isFailure) {
        res.status(400).json({
          success: false,
          error: result.error,
        });
        return;
      }

      const output = result.getValue();

      // claim_pending: OTP foi disparado via Twilio Verify;
      // o frontend deve mostrar o ecrã de confirmação OTP antes de prosseguir.
      if (output.status === 'claim_pending') {
        res.status(200).json({
          success: true,
          data: {
            status: 'claim_pending',
            candidateWorkerId: output.candidateWorkerId,
            phoneMasked: output.phoneMasked,
            verificationSid: output.verificationSid,
          },
        });
        return;
      }

      res.status(201).json({
        success: true,
        data: {
          status: 'ok',
          worker: output.worker,
        },
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

      if (!workerId || !step) {
        res.status(400).json({
          success: false,
          error: 'Missing required fields: workerId, step',
        });
        return;
      }

      let result;

      switch (step) {
        case 1:
          result = await this.saveQuizUseCase.execute({
            workerId,
            responses: data.responses || [],
          });
          break;

        case 2:
          result = await this.savePersonalInfoUseCase.execute({
            workerId,
            ...data,
          });
          break;

        case 3:
          result = await this.saveServiceAreaUseCase.execute({
            workerId,
            ...data,
          });
          break;

        case 4:
          result = await this.saveAvailabilityUseCase.execute({
            workerId,
            availability: data.availability || [],
          });
          break;

        default:
          res.status(400).json({
            success: false,
            error: `Invalid step: ${step}. Must be 1-4`,
          });
          return;
      }

      if (result.isFailure) {
        // step 2 (info pessoal) pode retornar PHONE_NOT_AVAILABLE — mapeia para
        // 409 + code; demais erros caem no 400 genérico.
        this.sendPersonalInfoFailure(res, result.error);
        return;
      }

      res.status(200).json({
        success: true,
        data: step === 1 ? { message: 'Quiz responses saved' } : result.getValue(),
      });
    } catch (error: any) {
      console.error('SaveStep error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Internal server error',
      });
    }
  }

  async getProgress(req: Request, res: Response): Promise<void> {
    try {
      // Support both header-based (legacy) and body-injected auth UID from middleware
      const authUid = (req as any).user?.uid || req.headers['x-auth-uid'] as string;

      if (!authUid) {
        res.status(401).json({
          success: false,
          error: 'Unauthorized: missing auth UID',
        });
        return;
      }

      const result = await this.getProgressUseCase.execute(authUid);

      if (result.isFailure) {
        res.status(404).json({
          success: false,
          error: result.error,
        });
        return;
      }

      const worker = result.getValue();
      res.status(200).json({
        success: true,
        data: worker,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }

  private async resolveWorkerIdFromAuth(authUid: string): Promise<string | null> {
    const result = await this.getProgressUseCase.execute(authUid);
    if (result.isFailure || !result.getValue()) return null;
    return result.getValue()!.id;
  }

  /**
   * Traduz a falha de salvamento de info pessoal para a resposta HTTP.
   * Códigos de domínio conhecidos (ex.: PHONE_NOT_AVAILABLE) viram status +
   * `code` + mensagem amigável; qualquer outro erro mantém o 400 genérico.
   */
  private sendPersonalInfoFailure(res: Response, error: string | undefined): void {
    if (error === WORKER_ERROR_CODES.PHONE_NOT_AVAILABLE) {
      res.status(409).json({
        success: false,
        code: WORKER_ERROR_CODES.PHONE_NOT_AVAILABLE,
        error: PHONE_NOT_AVAILABLE_MESSAGE,
      });
      return;
    }
    res.status(400).json({ success: false, error });
  }

  async saveGeneralInfo(req: Request, res: Response): Promise<void> {
    try {
      const authUid = (req as any).user?.uid || req.headers['x-auth-uid'] as string;
      if (!authUid) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const workerId = await this.resolveWorkerIdFromAuth(authUid);
      if (!workerId) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }

      const result = await this.savePersonalInfoUseCase.execute({ workerId, ...req.body });

      if (result.isFailure) {
        this.sendPersonalInfoFailure(res, result.error);
        return;
      }

      res.status(200).json({ success: true, data: { message: 'General info saved' } });
    } catch (error: any) {
      console.error('SaveGeneralInfo error:', error);
      res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
  }

  async saveServiceArea(req: Request, res: Response): Promise<void> {
    try {
      const authUid = (req as any).user?.uid || req.headers['x-auth-uid'] as string;
      if (!authUid) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const workerId = await this.resolveWorkerIdFromAuth(authUid);
      if (!workerId) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }

      const result = await this.saveServiceAreaUseCase.execute({ workerId, ...req.body });

      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({ success: true, data: { message: 'Service area saved' } });
    } catch (error: any) {
      console.error('SaveServiceArea error:', error);
      res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
  }

  async getAvailability(req: Request, res: Response): Promise<void> {
    try {
      const authUid = (req as any).user?.uid || req.headers['x-auth-uid'] as string;
      if (!authUid) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const workerId = await this.resolveWorkerIdFromAuth(authUid);
      if (!workerId) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }

      const result = await this.getAvailabilityUseCase.execute(workerId);

      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({ success: true, data: result.getValue() });
    } catch (error: any) {
      console.error('GetAvailability error:', error);
      res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
  }

  async saveAvailability(req: Request, res: Response): Promise<void> {
    try {
      const authUid = (req as any).user?.uid || req.headers['x-auth-uid'] as string;
      if (!authUid) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return;
      }

      const workerId = await this.resolveWorkerIdFromAuth(authUid);
      if (!workerId) {
        res.status(404).json({ success: false, error: 'Worker not found' });
        return;
      }

      const result = await this.saveAvailabilityUseCase.execute({
        workerId,
        availability: req.body.availability || [],
      });

      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({ success: true, data: { message: 'Availability saved' } });
    } catch (error: any) {
      console.error('SaveAvailability error:', error);
      res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
  }

  async lookupByEmail(req: Request, res: Response): Promise<void> {
    try {
      const rawEmail = req.query.email;

      if (!rawEmail || typeof rawEmail !== 'string') {
        res.status(400).json({ success: false, error: 'Missing required query parameter: email' });
        return;
      }

      const email = rawEmail.trim().toLowerCase();

      if (!email.includes('@') || !email.includes('.')) {
        res.status(400).json({ success: false, error: 'Invalid email format' });
        return;
      }

      const result = await this.lookupWorkerByEmailUseCase.execute(email);
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
