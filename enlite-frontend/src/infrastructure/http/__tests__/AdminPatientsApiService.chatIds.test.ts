import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AdminPatientsApiService, PatientApiError } from '../AdminPatientsApiService';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FAMILY = '120363090000000001@g.us';
const PROVIDERS = '120363090000000002@g.us';

function mockJson(body: unknown, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    json: async () => body,
    headers: { get: (n: string) => (n === 'content-type' ? 'application/json' : null) },
  });
}

function call(i = 0) {
  const [url, init] = (global.fetch as Mock).mock.calls[i];
  return { url: url as string, init: init as RequestInit };
}

describe('AdminPatientsApiService — chat IDs do Periskope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPatientChatCandidates', () => {
    it('GET no endpoint de candidatos, com Bearer', async () => {
      mockJson({ success: true, data: { candidates: [], totalGroups: 0 } });

      const out = await AdminPatientsApiService.getPatientChatCandidates(PATIENT);

      expect(call().url).toContain(`/api/admin/patients/${PATIENT}/chat-candidates`);
      expect(call().init.method).toBe('GET');
      expect((call().init.headers as Record<string, string>).Authorization).toBe('Bearer mock-token');
      expect(out).toEqual({ candidates: [], totalGroups: 0 });
    });

    it('inclui limit quando pedido', async () => {
      mockJson({ success: true, data: { candidates: [], totalGroups: 0 } });
      await AdminPatientsApiService.getPatientChatCandidates(PATIENT, 5);
      expect(call().url).toContain('?limit=5');
    });

    it('omite limit quando não pedido', async () => {
      mockJson({ success: true, data: { candidates: [], totalGroups: 0 } });
      await AdminPatientsApiService.getPatientChatCandidates(PATIENT);
      expect(call().url).not.toContain('limit');
    });

    it('devolve os candidatos com score e marca de já-vinculado', async () => {
      const candidates = [
        { chatId: FAMILY, chatName: 'Flia Perez', memberCount: 6, score: 1, matchedTerms: ['perez'], linkedToOtherPatient: false },
        { chatId: PROVIDERS, chatName: 'Prestadores Perez', memberCount: 11, score: 0.5, matchedTerms: ['perez'], linkedToOtherPatient: true },
      ];
      mockJson({ success: true, data: { candidates, totalGroups: 774 } });

      const out = await AdminPatientsApiService.getPatientChatCandidates(PATIENT);

      expect(out.totalGroups).toBe(774);
      expect(out.candidates[1].linkedToOtherPatient).toBe(true);
    });

    it('503 (kill-switch desligado) vira PatientApiError com o status', async () => {
      mockJson({ success: false, error: 'Chat lookup disabled' }, 503);

      await expect(AdminPatientsApiService.getPatientChatCandidates(PATIENT))
        .rejects.toMatchObject({ name: 'PatientApiError', status: 503, message: 'Chat lookup disabled' });
    });

    it('resposta não-JSON vira erro de conexão', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        status: 502,
        json: async () => ({}),
        headers: { get: () => 'text/html' },
      });

      await expect(AdminPatientsApiService.getPatientChatCandidates(PATIENT))
        .rejects.toBeInstanceOf(PatientApiError);
    });
  });

  describe('updatePatientChatIds', () => {
    it('PUT com o par no body', async () => {
      mockJson({ success: true, data: { id: PATIENT, familyChatId: FAMILY, providersChatId: PROVIDERS } });

      const out = await AdminPatientsApiService.updatePatientChatIds(PATIENT, {
        familyChatId: FAMILY, providersChatId: PROVIDERS,
      });

      expect(call().url).toContain(`/api/admin/patients/${PATIENT}/chat-ids`);
      expect(call().init.method).toBe('PUT');
      expect(JSON.parse(call().init.body as string)).toEqual({
        familyChatId: FAMILY, providersChatId: PROVIDERS,
      });
      expect(out.familyChatId).toBe(FAMILY);
    });

    it('null desvincula', async () => {
      mockJson({ success: true, data: { id: PATIENT, familyChatId: null, providersChatId: null } });
      await AdminPatientsApiService.updatePatientChatIds(PATIENT, { familyChatId: null, providersChatId: null });
      expect(JSON.parse(call().init.body as string)).toEqual({ familyChatId: null, providersChatId: null });
    });

    it('409 (grupo já vinculado) chega ao caller com o status', async () => {
      mockJson({ success: false, error: 'Chat id already linked to another patient' }, 409);

      await expect(
        AdminPatientsApiService.updatePatientChatIds(PATIENT, { familyChatId: FAMILY, providersChatId: null }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });
});
