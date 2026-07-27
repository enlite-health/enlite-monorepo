/**
 * AnaCareMirrorProvider.test.ts — unit tests do provider.
 *
 * Cobre:
 *   - POST createNurse quando externalId === null
 *   - PATCH updateNurse quando externalId !== null
 *   - Retorna { externalId: string } em ambos os casos
 *   - Throws em externalId não-numérico (PATCH)
 *   - Propagação de erro da API
 */

import { AnaCareMirrorProvider, toAnaCareNurseId } from '../AnaCareMirrorProvider';
import type { IAnaCareApiClient, AnaCareNurse } from '../../../domain/IAnaCareApiClient';
import type { WorkerMirrorRecord } from '../../../domain/WorkerMirrorRecord';

// ─── Fixtures ─────────────────────────────────────────────────────

function makeRecord(overrides: Partial<WorkerMirrorRecord> = {}): WorkerMirrorRecord {
  return {
    workerId: 'worker-uuid-1',
    firstName: 'María',
    lastName: 'González',
    sex: 'FEMALE',
    email: 'maria@example.com',
    phone: '+5491123456789',
    birthDate: '1990-05-15',
    documentNumber: 'GOPM900515MDFNRR02',
    address: {
      line: 'Av. Insurgentes 100',
      city: 'Ciudad de México',
      state: 'CDMX',
      neighborhood: 'Roma Norte',
      postalCode: '06700',
    },
    profession: 'AT',
    occupation: null,
    employmentType: null,
    ...overrides,
  };
}

const nurseResponse: AnaCareNurse = {
  id: 42,
  nombre: 'María',
  apellidos: 'González',
  genero: 'M',
  email: 'maria@example.com',
};

function makeClient(): IAnaCareApiClient {
  return {
    listNurseTypes: jest.fn().mockResolvedValue({ count: 0, next: null, previous: null, results: [] }),
    listHiringTypes: jest.fn().mockResolvedValue({ count: 0, next: null, previous: null, results: [] }),
    listNurses: jest.fn(),
    createNurse: jest.fn().mockResolvedValue(nurseResponse),
    getNurse: jest.fn(),
    updateNurse: jest.fn().mockResolvedValue(nurseResponse),
    bulkUpdateNurses: jest.fn(),
  } as IAnaCareApiClient;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('AnaCareMirrorProvider.upsert', () => {
  describe('quando externalId === null (criação)', () => {
    it('chama createNurse (POST)', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client);
      await provider.upsert(makeRecord(), null);
      expect(client.createNurse).toHaveBeenCalledTimes(1);
      expect(client.updateNurse).not.toHaveBeenCalled();
    });

    it('retorna externalId como string do ID retornado', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client);
      const result = await provider.upsert(makeRecord(), null);
      expect(result.externalId).toBe('42');
    });

    it('payload inclui campos obrigatórios', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client);
      await provider.upsert(makeRecord(), null);
      const callArg = (client.createNurse as jest.Mock).mock.calls[0][0];
      expect(callArg.nombre).toBe('María');
      expect(callArg.apellidos).toBe('González');
      expect(callArg.genero).toBe('M'); // FEMALE → "M"
      expect(callArg.email).toBe('maria@example.com');
    });
  });

  describe('quando externalId !== null (atualização)', () => {
    it('chama updateNurse (PATCH) com o ID numérico', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client);
      await provider.upsert(makeRecord(), '42');
      expect(client.updateNurse).toHaveBeenCalledWith(42, expect.any(Object));
      expect(client.createNurse).not.toHaveBeenCalled();
    });

    it('retorna externalId do objeto retornado pelo PATCH', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client);
      const result = await provider.upsert(makeRecord(), '42');
      expect(result.externalId).toBe('42');
    });

    it('throws quando externalId não é número válido', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client);
      await expect(provider.upsert(makeRecord(), 'not-a-number')).rejects.toThrow(
        'invalid externalId',
      );
    });

    it('externalId com prefixo do import ("A86109") → PATCH no id numérico 86109', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client);
      await provider.upsert(makeRecord(), 'A86109');
      expect(client.updateNurse).toHaveBeenCalledWith(86109, expect.any(Object));
      expect(client.createNurse).not.toHaveBeenCalled();
    });
  });

  describe('toAnaCareNurseId', () => {
    it('numérico puro → mesmo número', () => {
      expect(toAnaCareNurseId('86109')).toBe(86109);
    });
    it('prefixo alfabético do import → só os dígitos', () => {
      expect(toAnaCareNurseId('A86109')).toBe(86109);
    });
    it('sem dígito nenhum → null', () => {
      expect(toAnaCareNurseId('ABC')).toBeNull();
      expect(toAnaCareNurseId('')).toBeNull();
    });
  });

  describe('propagação de erro da API', () => {
    it('propaga erro do createNurse', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(new Error('HTTP 400: email duplicate'));
      const provider = new AnaCareMirrorProvider(client);
      await expect(provider.upsert(makeRecord(), null)).rejects.toThrow('HTTP 400: email duplicate');
    });

    it('propaga erro do updateNurse', async () => {
      const client = makeClient();
      (client.updateNurse as jest.Mock).mockRejectedValue(new Error('HTTP 404'));
      const provider = new AnaCareMirrorProvider(client);
      await expect(provider.upsert(makeRecord(), '99')).rejects.toThrow('HTTP 404');
    });
  });

  describe('provider.name', () => {
    it('é "anacare"', () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client);
      expect(provider.name).toBe('anacare');
    });
  });
});
