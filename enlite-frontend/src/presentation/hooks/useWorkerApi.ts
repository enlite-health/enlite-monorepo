import { useCallback } from 'react';
import { useAuth } from '@presentation/hooks/useAuth';
import {
  WorkerApiService,
  InitWorkerPayload,
  InitWorkerResponse,
  SaveStepPayload,
  WorkerProgressResponse,
  AvailabilitySlotResponse,
} from '@infrastructure/http/WorkerApiService';

/**
 * Hook that exposes worker-functions API calls with the current authenticated user context.
 * All methods automatically use the Firebase ID token from the current session.
 */
export function useWorkerApi() {
  const { user } = useAuth();

  const initWorker = useCallback(
    async (extras: Omit<InitWorkerPayload, 'authUid' | 'email'>): Promise<InitWorkerResponse> => {
      if (!user) throw new Error('User must be authenticated to init worker');
      return WorkerApiService.initWorker({
        authUid: user.id,
        email: user.email,
        ...extras,
      });
    },
    [user],
  );

  const getProgress = useCallback(async (): Promise<WorkerProgressResponse> => {
    if (!user) throw new Error('User must be authenticated to get progress');
    return WorkerApiService.getProgress();
  }, [user]);

  const saveStep = useCallback(
    async (workerId: string, step: number, data: SaveStepPayload['data']): Promise<void> => {
      if (!user) throw new Error('User must be authenticated to save step');
      return WorkerApiService.saveStep({ workerId, step, data });
    },
    [user],
  );

  const saveGeneralInfo = useCallback(
    async (data: Record<string, any>): Promise<void> => {
      if (!user) throw new Error('User must be authenticated');
      return WorkerApiService.saveGeneralInfo(data);
    },
    [user],
  );

  const saveServiceArea = useCallback(
    async (data: Record<string, any>): Promise<void> => {
      if (!user) throw new Error('User must be authenticated');
      return WorkerApiService.saveServiceArea(data);
    },
    [user],
  );

  const getAvailability = useCallback(
    async (): Promise<AvailabilitySlotResponse[]> => {
      if (!user) throw new Error('User must be authenticated');
      return WorkerApiService.getAvailability();
    },
    [user],
  );

  const saveAvailability = useCallback(
    async (data: { availability: Record<string, any>[] }): Promise<void> => {
      if (!user) throw new Error('User must be authenticated');
      return WorkerApiService.saveAvailability(data);
    },
    [user],
  );

  return { initWorker, getProgress, saveStep, saveGeneralInfo, saveServiceArea, getAvailability, saveAvailability };
}
