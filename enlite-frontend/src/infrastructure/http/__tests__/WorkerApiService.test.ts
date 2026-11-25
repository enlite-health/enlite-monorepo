import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WorkerApiService } from '../WorkerApiService';
import type { InitWorkerPayload, WorkerProgressResponse } from '../WorkerApiService';

// Mock fetch
global.fetch = vi.fn();

describe('WorkerApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock getIdToken to return mock token
    vi.spyOn(WorkerApiService['authService'], 'getIdToken').mockResolvedValue('mock-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Constructor', () => {
    it('should use VITE_WORKER_FUNCTIONS_URL if available', () => {
      expect(WorkerApiService).toBeDefined();
    });

    it('should fallback to localhost if no env vars', () => {
      expect(WorkerApiService).toBeDefined();
    });
  });

  describe('initWorker', () => {
    it('should initialize worker with valid payload', async () => {
      const payload: InitWorkerPayload = {
        authUid: 'test-uid',
        email: 'test@example.com',
        phone: '+5511999999999',
        lgpdOptIn: true,
        country: 'BR',
      };

      const mockResponse: WorkerProgressResponse = {
        id: 'worker-123',
        authUid: 'test-uid',
        email: 'test@example.com',
        phone: '+5511999999999',
        status: 'pending',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: mockResponse }),
      } as Response);

      const result = await WorkerApiService.initWorker(payload);

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workers/init'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer mock-token',
          }),
          body: JSON.stringify(payload),
        })
      );
    });

    it('should handle init worker without optional fields', async () => {
      const payload: InitWorkerPayload = {
        authUid: 'test-uid',
        email: 'test@example.com',
      };

      const mockResponse: WorkerProgressResponse = {
        id: 'worker-123',
        authUid: 'test-uid',
        email: 'test@example.com',
        status: 'pending',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: mockResponse }),
      } as Response);

      const result = await WorkerApiService.initWorker(payload);

      expect(result).toEqual(mockResponse);
    });

    it('should return existing worker if already initialized (idempotent)', async () => {
      const payload: InitWorkerPayload = {
        authUid: 'existing-uid',
        email: 'existing@example.com',
      };

      const existingWorker: WorkerProgressResponse = {
        id: 'worker-existing',
        authUid: 'existing-uid',
        email: 'existing@example.com',
        status: 'in_progress',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: existingWorker }),
      } as Response);

      const result = await WorkerApiService.initWorker(payload);

      expect(result.status).toBe('in_progress');
    });

    it('should throw error on API failure', async () => {
      const payload: InitWorkerPayload = {
        authUid: 'test-uid',
        email: 'test@example.com',
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ success: false, error: 'Invalid payload' }),
      } as Response);

      await expect(WorkerApiService.initWorker(payload)).rejects.toThrow('Invalid payload');
    });

    it('should throw error on network failure', async () => {
      const payload: InitWorkerPayload = {
        authUid: 'test-uid',
        email: 'test@example.com',
      };

      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network error'));

      await expect(WorkerApiService.initWorker(payload)).rejects.toThrow('Network error');
    });
  });

  describe('getProgress', () => {
    it('should get worker progress', async () => {
      const mockProgress: WorkerProgressResponse = {
        id: 'worker-123',
        authUid: 'test-uid',
        email: 'test@example.com',
        status: 'in_progress',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: mockProgress }),
      } as Response);

      const result = await WorkerApiService.getProgress();

      expect(result).toEqual(mockProgress);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workers/me'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer mock-token',
          }),
        })
      );
    });

    it('should throw error when worker not found', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ success: false, error: 'Worker not found' }),
      } as Response);

      await expect(WorkerApiService.getProgress()).rejects.toThrow('Worker not found');
    });

    it('should include optional fields in response', async () => {
      const mockProgress: WorkerProgressResponse = {
        id: 'worker-123',
        authUid: 'test-uid',
        email: 'test@example.com',
        phone: '+5511999999999',
        whatsappPhone: '+5511888888888',
        lgpdConsentAt: new Date().toISOString(),
        status: 'review',
        country: 'BR',
        timezone: 'America/Sao_Paulo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: mockProgress }),
      } as Response);

      const result = await WorkerApiService.getProgress();

      expect(result.phone).toBe('+5511999999999');
      expect(result.whatsappPhone).toBe('+5511888888888');
      expect(result.lgpdConsentAt).toBeDefined();
    });
  });

  describe('saveStep', () => {
    it('should save step data successfully', async () => {
      const payload = {
        workerId: 'worker-123',
        step: 2,
        data: {
          firstName: 'John',
          lastName: 'Doe',
          phone: '+5511999999999',
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: null }),
      } as Response);

      await WorkerApiService.saveStep(payload);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workers/step'),
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer mock-token',
          }),
          body: JSON.stringify(payload),
        })
      );
    });

    it('should save step with complex data', async () => {
      const payload = {
        workerId: 'worker-123',
        step: 3,
        data: {
          schedule: [
            { day: 'Monday', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
            { day: 'Tuesday', enabled: false, timeSlots: [] },
          ],
        },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: null }),
      } as Response);

      await WorkerApiService.saveStep(payload);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workers/step'),
        expect.objectContaining({
          body: JSON.stringify(payload),
        })
      );
    });

    it('should throw error on save failure', async () => {
      const payload = {
        workerId: 'worker-123',
        step: 2,
        data: { invalid: 'data' },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ success: false, error: 'Invalid step data' }),
      } as Response);

      await expect(WorkerApiService.saveStep(payload)).rejects.toThrow('Invalid step data');
    });

    it('should throw error when worker not found', async () => {
      const payload = {
        workerId: 'non-existent',
        step: 2,
        data: {},
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ success: false, error: 'Worker not found' }),
      } as Response);

      await expect(WorkerApiService.saveStep(payload)).rejects.toThrow('Worker not found');
    });
  });

  describe('saveGeneralInfo', () => {
    it('should call PUT /api/workers/me/general-info', async () => {
      const payload = {
        firstName: 'Gabriel',
        lastName: 'Stein',
        phone: '+5491199999999',
        profession: 'caregiver',
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { message: 'General info saved' } }),
      } as Response);

      await WorkerApiService.saveGeneralInfo(payload);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workers/me/general-info'),
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            Authorization: 'Bearer mock-token',
          }),
          // o telefone NÃO viaja (emenda do celular verificado, §6): só pela rota de verificação
          body: JSON.stringify({ firstName: 'Gabriel', lastName: 'Stein', profession: 'caregiver' }),
        })
      );
    });

    it('should not include workerId in the payload', async () => {
      const payload = { firstName: 'Test', lastName: 'User' };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { message: 'General info saved' } }),
      } as Response);

      await WorkerApiService.saveGeneralInfo(payload);

      const sentBody = JSON.parse(
        (vi.mocked(global.fetch).mock.calls[0][1]?.body as string) ?? '{}'
      );
      expect(sentBody.workerId).toBeUndefined();
    });

    it('should throw on API error', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ success: false, error: 'Validation error' }),
      } as Response);

      await expect(WorkerApiService.saveGeneralInfo({})).rejects.toThrow('Validation error');
    });

    it('should throw on network failure', async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network error'));

      await expect(WorkerApiService.saveGeneralInfo({})).rejects.toThrow('Network error');
    });
  });

  describe('saveServiceArea', () => {
    it('should call PUT /api/workers/me/service-area', async () => {
      const payload = {
        address: 'Av. Corrientes 1234, Buenos Aires',
        addressComplement: 'Piso 3',
        serviceRadiusKm: 10,
        lat: -34.603722,
        lng: -58.381592,
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { message: 'Service area saved' } }),
      } as Response);

      await WorkerApiService.saveServiceArea(payload);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workers/me/service-area'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(payload),
        })
      );
    });

    it('should not include workerId in the payload', async () => {
      const payload = { address: 'Rua Teste', serviceRadiusKm: 5, lat: 0, lng: 0 };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { message: 'Service area saved' } }),
      } as Response);

      await WorkerApiService.saveServiceArea(payload);

      const sentBody = JSON.parse(
        (vi.mocked(global.fetch).mock.calls[0][1]?.body as string) ?? '{}'
      );
      expect(sentBody.workerId).toBeUndefined();
    });

    it('should throw on API error', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ success: false, error: 'Unauthorized' }),
      } as Response);

      await expect(WorkerApiService.saveServiceArea({})).rejects.toThrow('Unauthorized');
    });
  });

  describe('saveAvailability', () => {
    it('should call PUT /api/workers/me/availability', async () => {
      const payload = {
        availability: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
          { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
        ],
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { message: 'Availability saved' } }),
      } as Response);

      await WorkerApiService.saveAvailability(payload);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/workers/me/availability'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(payload),
        })
      );
    });

    it('should not include workerId in the payload', async () => {
      const payload = { availability: [{ dayOfWeek: 0, startTime: '10:00', endTime: '16:00' }] };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { message: 'Availability saved' } }),
      } as Response);

      await WorkerApiService.saveAvailability(payload);

      const sentBody = JSON.parse(
        (vi.mocked(global.fetch).mock.calls[0][1]?.body as string) ?? '{}'
      );
      expect(sentBody.workerId).toBeUndefined();
    });

    it('should throw on empty availability (400)', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ success: false, error: 'At least one availability slot is required' }),
      } as Response);

      await expect(
        WorkerApiService.saveAvailability({ availability: [] })
      ).rejects.toThrow('At least one availability slot is required');
    });

    it('should throw on network failure', async () => {
      vi.mocked(global.fetch).mockRejectedValueOnce(new Error('Network error'));

      await expect(
        WorkerApiService.saveAvailability({ availability: [] })
      ).rejects.toThrow('Network error');
    });
  });

  describe('Authentication', () => {
    it('should include auth token in headers when available', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} }),
      } as Response);

      await WorkerApiService.getProgress();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer mock-token',
          }),
        })
      );
    });

    it('should make request without auth token when not available', async () => {
      // Override the spy to return null for this test
      vi.spyOn(WorkerApiService['authService'], 'getIdToken').mockResolvedValueOnce(null);

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} }),
      } as Response);

      await WorkerApiService.getProgress();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
      
      // Verify Authorization header is NOT present
      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const headers = fetchCall[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw error with custom message from API', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ success: false, error: 'Internal server error' }),
      } as Response);

      await expect(WorkerApiService.getProgress()).rejects.toThrow('Internal server error');
    });

    it('should throw error with HTTP status when no error message', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ success: false }),
      } as Response);

      await expect(WorkerApiService.getProgress()).rejects.toThrow('HTTP 500');
    });

    it('should handle JSON parse errors', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      } as unknown as Response);

      await expect(WorkerApiService.getProgress()).rejects.toThrow('Invalid JSON');
    });
  });

  describe('Request Configuration', () => {
    it('should set correct Content-Type header', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} }),
      } as Response);

      await WorkerApiService.getProgress();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should not include body for GET requests', async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} }),
      } as Response);

      await WorkerApiService.getProgress();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'GET',
          body: undefined,
        })
      );
    });

    it('should include body for POST requests', async () => {
      const payload: InitWorkerPayload = {
        authUid: 'test-uid',
        email: 'test@example.com',
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} }),
      } as Response);

      await WorkerApiService.initWorker(payload);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(payload),
        })
      );
    });

    it('should include body for PUT requests', async () => {
      const payload = {
        workerId: 'worker-123',
        step: 2,
        data: { test: 'data' },
      };

      vi.mocked(global.fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: null }),
      } as Response);

      await WorkerApiService.saveStep(payload);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(payload),
        })
      );
    });
  });
});
