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

import { AnaCareMirrorProvider, AnaCareLinkBlockedError } from '../AnaCareMirrorProvider';
import type { AnaCareMirrorProviderDeps } from '../AnaCareMirrorProvider';
import { AnaCareApiError } from '../AnaCareClient';
import { logger } from '@shared/logging';
import type { IAnaCareApiClient, AnaCareNurse, AnaCarePagedResponse } from '../../../domain/IAnaCareApiClient';
import type { WorkerMirrorRecord } from '../../../domain/WorkerMirrorRecord';

// Os logs de bloqueio são a superfície que o operador lê — asseridos, não ignorados.
let loggerErrorSpy: jest.SpyInstance;
let loggerWarnSpy: jest.SpyInstance;

beforeEach(() => {
  loggerErrorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  loggerWarnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

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

/**
 * Stub EXPLÍCITO do guard: "nenhum ana_care_id está reivindicado".
 * A dep é obrigatória de propósito (guard fail-closed) — todo teste declara
 * qual mundo está simulando, em vez de herdar um default permissivo.
 */
function makeFreeDeps(): AnaCareMirrorProviderDeps {
  return { isExternalIdClaimed: jest.fn().mockResolvedValue(false) };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('AnaCareMirrorProvider.upsert', () => {
  describe('quando externalId === null (criação)', () => {
    it('chama createNurse (POST)', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await provider.upsert(makeRecord(), null);
      expect(client.createNurse).toHaveBeenCalledTimes(1);
      expect(client.updateNurse).not.toHaveBeenCalled();
    });

    it('retorna externalId como string do ID retornado', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      const result = await provider.upsert(makeRecord(), null);
      expect(result.externalId).toBe('42');
    });

    it('payload inclui campos obrigatórios', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
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
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await provider.upsert(makeRecord(), '42');
      expect(client.updateNurse).toHaveBeenCalledWith(42, expect.any(Object));
      expect(client.createNurse).not.toHaveBeenCalled();
    });

    it('retorna externalId do objeto retornado pelo PATCH', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      const result = await provider.upsert(makeRecord(), '42');
      expect(result.externalId).toBe('42');
    });

    it('throws quando externalId não é número válido', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord(), 'not-a-number')).rejects.toThrow(
        'invalid externalId',
      );
    });
  });

  describe('propagação de erro da API', () => {
    it('propaga erro do createNurse', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(new Error('HTTP 400: email duplicate'));
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord(), null)).rejects.toThrow('HTTP 400: email duplicate');
    });

    it('propaga erro do updateNurse', async () => {
      const client = makeClient();
      (client.updateNurse as jest.Mock).mockRejectedValue(new Error('HTTP 404'));
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord(), '99')).rejects.toThrow('HTTP 404');
    });
  });

  describe('provider.name', () => {
    it('é "anacare"', () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
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

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
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
      // inclui uma nurse SEM telefone — a base do AnaCare tem registros assim
      (client.listNurses as jest.Mock).mockResolvedValue(
        pagedResponse([{ id: 1, nombre: 'Sem', apellidos: 'Telefone', genero: 'M', email: 's@t.com' }]),
      );

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
      expect(client.updateNurse).not.toHaveBeenCalled();
    });

    it('propaga o erro original quando o telefone bate mas o nome diverge (não confia)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(
        pagedResponse([{ ...existingMatch, nombre: 'Outra', apellidos: 'Pessoa' }]),
      );

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
      expect(client.updateNurse).not.toHaveBeenCalled();
    });

    it('propaga o erro original quando há MAIS DE UM candidato por telefone (ambíguo)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(
        pagedResponse([existingMatch, { ...existingMatch, id: 1000 }]),
      );

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
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

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      const result = await provider.upsert(makeRecord(), null);

      expect(result.externalId).toBe('999');
      expect(client.listNurses).toHaveBeenCalledTimes(2);
    });

    it('propaga o erro original quando o corpo do 400 não é o conflito esperado', async () => {
      const client = makeClient();
      const outroErro = new AnaCareApiError('POST', '/api/v2/agencies/nurses/', 400, JSON.stringify({ nombre: ['obrigatório'] }));
      (client.createNurse as jest.Mock).mockRejectedValue(outroErro);

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(outroErro);
      expect(client.listNurses).not.toHaveBeenCalled();
    });

    it('propaga o erro original quando a busca de match falha (ex: listNurses derruba)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockRejectedValue(new Error('timeout'));

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
    });

    it('propaga o erro original quando o corpo do 400 não é JSON (nem tenta matching)', async () => {
      const client = makeClient();
      const htmlError = new AnaCareApiError('POST', '/api/v2/agencies/nurses/', 400, '<html>Bad Request</html>');
      (client.createNurse as jest.Mock).mockRejectedValue(htmlError);

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(htmlError);
      expect(client.listNurses).not.toHaveBeenCalled();
    });

    it('propaga o erro original quando a busca de match rejeita com valor não-Error', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockRejectedValue('socket hang up');

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord(), null)).rejects.toBe(conflictError);
    });

    it('não tenta matching quando o payload não tem telefone (nada para casar)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);

      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());
      await expect(provider.upsert(makeRecord({ phone: null }), null)).rejects.toBe(conflictError);
      expect(client.listNurses).not.toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    it('chama updateNurse com o id numérico', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());

      await provider.deactivate('55');

      expect(client.updateNurse).toHaveBeenCalledWith(55, expect.any(Object));
    });

    it('throws quando externalId não é número válido', async () => {
      const client = makeClient();
      const provider = new AnaCareMirrorProvider(client, makeFreeDeps());

      await expect(provider.deactivate('not-a-number')).rejects.toThrow('invalid externalId');
      expect(client.updateNurse).not.toHaveBeenCalled();
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

    it('NÃO linka (não chama updateNurse) quando isExternalIdClaimed retorna true', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([existingMatch]));
      const isExternalIdClaimed = jest.fn().mockResolvedValue(true);

      const provider = new AnaCareMirrorProvider(client, { isExternalIdClaimed });

      await expect(provider.upsert(makeRecord(), null)).rejects.toBeInstanceOf(AnaCareLinkBlockedError);
      expect(isExternalIdClaimed).toHaveBeenCalledWith('999');
      expect(client.updateNurse).not.toHaveBeenCalled();
    });

    it('o motivo REAL chega na mensagem do erro (é ela que vira ana_care_sync_error), preservando o conflito original em cause', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([existingMatch]));

      const provider = new AnaCareMirrorProvider(client, {
        isExternalIdClaimed: jest.fn().mockResolvedValue(true),
      });

      const err = await provider.upsert(makeRecord(), null).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AnaCareLinkBlockedError);
      const blocked = err as AnaCareLinkBlockedError;
      expect(blocked.reason).toBe('claimed');
      expect(blocked.anaCareId).toBe('999');
      expect(blocked.message).toContain('já pertence a OUTRO worker nosso');
      // o erro original NÃO é engolido: fica em cause E embutido na mensagem
      expect(blocked.cause).toBe(conflictError);
      expect(blocked.message).toContain('No es posible usar este número de teléfono');
      // bloqueio por reivindicação é WARN e afirma a duplicata — o outro caso não pode
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ anaCareId: 999, msg: expect.stringContaining('já pertence a OUTRO worker nosso') }),
      );
      expect(loggerErrorSpy).not.toHaveBeenCalled();
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

    it('falha do próprio checker → não linka (fail-closed), mas NÃO afirma duplicata', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([existingMatch]));
      const isExternalIdClaimed = jest.fn().mockRejectedValue(new Error('db down'));

      const provider = new AnaCareMirrorProvider(client, { isExternalIdClaimed });

      const err = await provider.upsert(makeRecord(), null).catch((e: unknown) => e);

      expect(client.updateNurse).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(AnaCareLinkBlockedError);
      const blocked = err as AnaCareLinkBlockedError;
      expect(blocked.reason).toBe('checker_unavailable');
      // D100 desta casa: alerta que MENTE custa caro. Checker fora ≠ duplicata.
      expect(blocked.message).toContain('checker indisponível');
      expect(blocked.message).toContain('NÃO é duplicata confirmada');
      expect(blocked.message).not.toContain('já pertence a OUTRO worker nosso');
      expect(blocked.cause).toBe(conflictError);
    });

    it('loga o erro engolido do checker (não descarta a causa da indisponibilidade)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([existingMatch]));

      const provider = new AnaCareMirrorProvider(client, {
        isExternalIdClaimed: jest.fn().mockRejectedValue(new Error('connection terminated unexpectedly')),
      });

      await expect(provider.upsert(makeRecord(), null)).rejects.toBeInstanceOf(AnaCareLinkBlockedError);

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          anaCareId: 999,
          error: 'connection terminated unexpectedly',
          msg: expect.stringContaining('INDISPONÍVEL'),
        }),
      );
    });

    it('checker rejeitando com valor não-Error também é logado (sem quebrar o fail-closed)', async () => {
      const client = makeClient();
      (client.createNurse as jest.Mock).mockRejectedValue(conflictError);
      (client.listNurses as jest.Mock).mockResolvedValue(pagedResponse([existingMatch]));

      const provider = new AnaCareMirrorProvider(client, {
        // pg pode rejeitar com valor não-Error em caminhos de baixo nível
        isExternalIdClaimed: jest.fn().mockRejectedValue('ECONNREFUSED'),
      });

      await expect(provider.upsert(makeRecord(), null)).rejects.toBeInstanceOf(AnaCareLinkBlockedError);

      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'ECONNREFUSED' }),
      );
      expect(client.updateNurse).not.toHaveBeenCalled();
    });
  });
});

// ─── Conflito de unicidade no PATCH (worker JÁ linkado) ──────────────────────
//
// Regressão introduzida pelo #196 e medida em produção em 11/08/2026: mandar o
// telefone em formato NACIONAL colocou o valor no mesmo espaço dos 692 registros
// já nacionais do AnaCare, e a unicidade deles passou a disparar em PATCH —
// 9 falhas em 24h. Como o evento não tem retry, o worker parava de sincronizar
// de vez. O #201 protegeu só o POST.

describe('conflito de unicidade no PATCH (worker já linkado)', () => {
  function conflictOn(fields: Record<string, string[]>) {
    return new AnaCareApiError(
      'PATCH', '/api/v2/agencies/nurses/42/', 400, JSON.stringify(fields),
    );
  }

  it('telefone em conflito → reenvia SEM telefone e o resto do cadastro sincroniza', async () => {
    const client = makeClient();
    (client.updateNurse as jest.Mock)
      .mockRejectedValueOnce(conflictOn({ telefono: ['No es posible usar este número de teléfono'] }))
      .mockResolvedValueOnce(nurseResponse);

    const out = await new AnaCareMirrorProvider(client, makeFreeDeps()).upsert(makeRecord(), '42');

    expect(out).toEqual({ externalId: '42' });
    expect(client.updateNurse).toHaveBeenCalledTimes(2);
    const [, retryPayload] = (client.updateNurse as jest.Mock).mock.calls[1];
    expect(retryPayload).not.toHaveProperty('telefono');
    // o resto continua indo — é o ponto do conserto
    expect(retryPayload).toHaveProperty('nombre');
    expect(retryPayload).toHaveProperty('email');
  });

  it('telefone E email em conflito → tira os dois', async () => {
    const client = makeClient();
    (client.updateNurse as jest.Mock)
      .mockRejectedValueOnce(conflictOn({ telefono: ['x'], email: ['y'] }))
      .mockResolvedValueOnce(nurseResponse);

    await new AnaCareMirrorProvider(client, makeFreeDeps()).upsert(makeRecord(), '42');

    const [, retryPayload] = (client.updateNurse as jest.Mock).mock.calls[1];
    expect(retryPayload).not.toHaveProperty('telefono');
    expect(retryPayload).not.toHaveProperty('email');
    expect(retryPayload).toHaveProperty('nombre');
  });

  it('400 que NÃO é de unicidade continua propagando — não engolir erro de payload', async () => {
    const client = makeClient();
    (client.updateNurse as jest.Mock).mockRejectedValue(
      conflictOn({ nombre: ['obrigatório'] } as unknown as Record<string, string[]>),
    );

    await expect(new AnaCareMirrorProvider(client, makeFreeDeps()).upsert(makeRecord(), '42')).rejects.toThrow();
    expect(client.updateNurse).toHaveBeenCalledTimes(1);
  });

  it('400 com corpo NÃO-JSON (HTML de proxy) → não retenta, propaga', async () => {
    const client = makeClient();
    (client.updateNurse as jest.Mock).mockRejectedValue(
      new AnaCareApiError(
        'PATCH', '/api/v2/agencies/nurses/42/', 400,
        '<html><head><title>400 Bad Request</title></head><body><h1>400 Bad Request</h1></body></html>',
      ),
    );

    await expect(new AnaCareMirrorProvider(client, makeFreeDeps()).upsert(makeRecord(), '42')).rejects.toThrow(/HTTP 400/);
    expect(client.updateNurse).toHaveBeenCalledTimes(1);
  });

  it('se o retry TAMBÉM falhar, o erro propaga (não mascara falha real)', async () => {
    const client = makeClient();
    (client.updateNurse as jest.Mock)
      .mockRejectedValueOnce(conflictOn({ telefono: ['x'] }))
      .mockRejectedValueOnce(new Error('HTTP 500'));

    await expect(new AnaCareMirrorProvider(client, makeFreeDeps()).upsert(makeRecord(), '42')).rejects.toThrow('HTTP 500');
  });
});
