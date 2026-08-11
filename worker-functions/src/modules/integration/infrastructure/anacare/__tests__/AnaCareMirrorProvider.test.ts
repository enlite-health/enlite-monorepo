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

import { AnaCareMirrorProvider } from '../AnaCareMirrorProvider';
import { AnaCareApiError } from '../AnaCareClient';
import type { IAnaCareApiClient, AnaCareNurse, AnaCarePagedResponse } from '../../../domain/IAnaCareApiClient';
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

  describe('conflito de unicidade no POST (telefono/email já existem em outro registro)', () => {
    const conflictError = new AnaCareApiError(
      'POST',
      '/api/v2/agencies/nurses/',
      400,
      JSON.stringify({
        telefono: ['No es posible usar este número de teléfono para el registro.'],
        email: ['No es posible usar este correo electrónico para el registro.'],
      }),
    );

    function pagedResponse(results: AnaCareNurse[], next: string | null = null): AnaCarePagedResponse<AnaCareNurse> {
      return { count: results.length, next, previous: null, results };
    }

    // record de fixture tem phone '+5491123456789' → toNationalAR = '91123456789'... na
    // prática o mapper gera o telefone nacional a partir desse valor; usamos o mesmo
    // valor no fixture do AnaCare para garantir o match.
    const existingMatch: AnaCareNurse = {
      id: 999,
      nombre: 'María',
      apellidos: 'González',
      genero: 'M',
      email: 'gerado-pelo-anacare@ana.care',
      telefono: '1123456789',
    };

    it('linka (PATCH) quando encontra exatamente 1 candidato com telefone E nome batendo', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([existingMatch]));
      (client.updateNurse as jest.Mock).mockResolvedValue({ ...existingMatch, id: 999 });

      const provider = new AnaCareMirrorProvider(client);
      const result = await provider.upsert(makeRecord(), null);

      expect(result.externalId).toBe('999');
      expect(client.updateNurse).toHaveBeenCalledWith(999, expect.any(Object));
      // não reenvia email — o registro encontrado tem email próprio (gerado pelo AnaCare)
      const patchPayload = (client.updateNurse as jest.Mock).mock.calls[0][1];
      expect(patchPayload.email).toBeUndefined();
    });

    it('propaga o erro original quando não encontra nenhum candidato por telefone', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([]));

      const provider = new AnaCareMirrorProvider(client);
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
      expect(client.updateNurse).not.toHaveBeenCalled();
    });

    it('propaga o erro original quando o telefone bate mas o nome diverge (não confia)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(
        pagedResponse([{ ...existingMatch, nombre: 'Outra', apellidos: 'Pessoa' }]),
      );

      const provider = new AnaCareMirrorProvider(client);
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
      expect(client.updateNurse).not.toHaveBeenCalled();
    });

    it('propaga o erro original quando há MAIS DE UM candidato por telefone (ambíguo)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(
        pagedResponse([existingMatch, { ...existingMatch, id: 1000 }]),
      );

      const provider = new AnaCareMirrorProvider(client);
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
      expect(client.updateNurse).not.toHaveBeenCalled();
    });

    it('percorre todas as páginas antes de decidir (procura em toda a base)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock)
        .mockResolvedValueOnce(pagedResponse([{ ...existingMatch, id: 1, telefono: '000' }], 'page2'))
        .mockResolvedValueOnce(pagedResponse([existingMatch], null));
      (client.updateNurse as jest.Mock).mockResolvedValue({ ...existingMatch, id: 999 });

      const provider = new AnaCareMirrorProvider(client);
      const result = await provider.upsert(makeRecord(), null);

      expect(result.externalId).toBe('999');
      expect(client.listNurses).toHaveBeenCalledTimes(2);
    });

    it('propaga o erro original quando o corpo do 400 não é o conflito esperado', async () => {
      const client = makeClient();
      const outroErro = new AnaCareApiError('POST', '/api/v2/agencies/nurses/', 400, JSON.stringify({ nombre: ['obrigatório'] }));
      (client.createNurse as jest.Mock).mockRejectedValue(outroErro);

      const provider = new AnaCareMirrorProvider(client);
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(outroErro);
      expect(client.listNurses).not.toHaveBeenCalled();
    });

    it('propaga o erro original quando a busca de match falha (ex: listNurses derruba)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockRejectedValue(new Error('timeout'));

      const provider = new AnaCareMirrorProvider(client);
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
    });
  });

  describe('match encontrado, mas ana_care_id já pertence a outro worker nosso (duplicata de cadastro)', () => {
    const conflictError = new AnaCareApiError(
      'POST',
      '/api/v2/agencies/nurses/',
      400,
      JSON.stringify({
        telefono: ['No es posible usar este número de teléfono para el registro.'],
        email: ['No es posible usar este correo electrónico para el registro.'],
      }),
    );

    function pagedResponse(results: AnaCareNurse[], next: string | null = null): AnaCarePagedResponse<AnaCareNurse> {
      return { count: results.length, next, previous: null, results };
    }

    const existingMatch: AnaCareNurse = {
      id: 999,
      nombre: 'María',
      apellidos: 'González',
      genero: 'M',
      email: 'gerado-pelo-anacare@ana.care',
      telefono: '1123456789',
    };

    it('NÃO linka (não chama updateNurse) quando isExternalIdClaimed retorna true — propaga o erro original', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([existingMatch]));
      const isExternalIdClaimed = jest.fn().mockResolvedValue(true);

      const provider = new AnaCareMirrorProvider(client, { isExternalIdClaimed });

      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
      expect(isExternalIdClaimed).toHaveBeenCalledWith('999');
      expect(client.updateNurse).not.toHaveBeenCalled();
    });

    it('linka normalmente quando isExternalIdClaimed retorna false', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([existingMatch]));
      (client.updateNurse as jest.Mock).mockResolvedValue({ ...existingMatch, id: 999 });
      const isExternalIdClaimed = jest.fn().mockResolvedValue(false);

      const provider = new AnaCareMirrorProvider(client, { isExternalIdClaimed });
      const result = await provider.upsert(makeRecord(), null);

      expect(result.externalId).toBe('999');
      expect(client.updateNurse).toHaveBeenCalledWith(999, expect.any(Object));
    });

    it('trata falha do próprio checker como "reivindicado" (conservador) — não linka', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([existingMatch]));
      const isExternalIdClaimed = jest.fn().mockRejectedValue(new Error('db down'));

      const provider = new AnaCareMirrorProvider(client, { isExternalIdClaimed });

      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
      expect(client.updateNurse).not.toHaveBeenCalled();
    });
  });
});
