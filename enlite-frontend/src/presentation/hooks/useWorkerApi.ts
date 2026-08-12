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
  // Depend on primitives (id/email), NOT the `user` object. Firebase's
  // onAuthStateChanged emits a brand-new user object on every token
  // restore/refresh; depending on `user` would recreate these callbacks each
  // time, re-triggering effects that consume them (e.g. the profile form's
  // fetch+reset, which was wiping already-loaded fields). See useAuth/Firebase.
  const userId = user?.id;
  const userEmail = user?.email;

  const initWorker = useCallback(
    async (extras: Omit<InitWorkerPayload, 'authUid' | 'email'>): Promise<InitWorkerResponse> => {
      if (!userId || !userEmail) throw new Error('User must be authenticated to init worker');
      return WorkerApiService.initWorker({
        authUid: userId,
        email: userEmail,
        ...extras,
      });
    },
    [userId, userEmail],
  );

  const getProgress = useCallback(async (): Promise<WorkerProgressResponse> => {
    if (!userId) throw new Error('User must be authenticated to get progress');
    return WorkerApiService.getProgress();
  }, [userId]);

  const saveStep = useCallback(
    async (workerId: string, step: number, data: SaveStepPayload['data']): Promise<void> => {
      if (!userId) throw new Error('User must be authenticated to save step');
      return WorkerApiService.saveStep({ workerId, step, data });
    },
    [userId],
  );

  const saveGeneralInfo = useCallback(
    async (data: Record<string, any>): Promise<void> => {
      if (!userId) throw new Error('User must be authenticated');
      return WorkerApiService.saveGeneralInfo(data);
    },
    [userId],
  );

  const saveServiceArea = useCallback(
    async (data: Record<string, any>): Promise<void> => {
      if (!userId) throw new Error('User must be authenticated');
      return WorkerApiService.saveServiceArea(data);
    },
    [userId],
  );

  const getAvailability = useCallback(
    async (): Promise<AvailabilitySlotResponse[]> => {
      if (!userId) throw new Error('User must be authenticated');
      return WorkerApiService.getAvailability();
    },
    [userId],
  );

  const saveAvailability = useCallback(
    async (data: { availability: Record<string, any>[] }): Promise<void> => {
      if (!userId) throw new Error('User must be authenticated');
      return WorkerApiService.saveAvailability(data);
    },
    [userId],
  );

  return { initWorker, getProgress, saveStep, saveGeneralInfo, saveServiceArea, getAvailability, saveAvailability };
}
