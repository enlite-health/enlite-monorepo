/**
 * F2/C3 — `GET /api/admin/vacancies/:id/funnel-table` sob as células.
 *
 * Esta rota tem uma armadilha própria: além do nome cifrado, ela tem o
 * `worker_raw_name` do import legado, em TEXTO CLARO. Um fallback fora da
 * projeção devolveria esse nome sem tocar o KMS — e o espião, sozinho, ficaria
 * verde. Por isso aqui a fronteira é asserida junto com o espião.
 */

const mockFetchRawRows = jest.fn();
const mockKmsDecrypt = jest.fn();

jest.mock('../../infrastructure/FunnelTableRepository', () => ({
  FunnelTableRepository: jest.fn().mockImplementation(() => ({ fetchRawRows: mockFetchRawRows })),
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockKmsDecrypt })),
}));

import { GetFunnelTableUseCase } from '../GetFunnelTableUseCase';
import { NOME_REDIGIDO, CELL_WORKER_CONTACT_READ, CELL_WORKER_PII_READ } from '@modules/identity/permissions';

const TELEFONE = '+5491133445566';
const EMAIL = 'maria@exemplo.test';

function linhaCifrada() {
  return {
    id: 'wja-1', worker_id: 'w-1',
    first_name_encrypted: 'encrypted:María',
    last_name_encrypted: 'encrypted:González',
    worker_raw_name: null,
    email: EMAIL, phone: TELEFONE,
    profile_photo_url_encrypted: 'encrypted:https://foto/maria.jpg',
    invited_at: '2026-08-01T10:00:00Z',
    funnel_stage: 'CONFIRMED', interview_response: null,
    wbdl_dispatched_at: null, wbdl_delivery_status: null, wbdl_status: null,
    worker_status: 'REGISTERED', contact_notes_count: 0, self_applied_at: null,
  };
}

/** Card legado: o nome só existe em texto claro, vindo do `encuadres`. */
function linhaLegado() {
  return { ...linhaCifrada(), first_name_encrypted: null, last_name_encrypted: null,
           worker_raw_name: 'Carlos Legado' };
}

describe('funnel-table — a célula decide ANTES do KMS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKmsDecrypt.mockImplementation((v: string | null) =>
      typeof v === 'string' && v.startsWith('encrypted:')
        ? Promise.resolve(v.slice('encrypted:'.length))
        : Promise.resolve(''));
  });

  it('sem worker_contact:read: ZERO chamadas ao KMS', async () => {
    mockFetchRawRows.mockResolvedValue([linhaCifrada()]);
    const out = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', ['funnel:read']);

    expect(mockKmsDecrypt).toHaveBeenCalledTimes(0);
    expect(out.rows[0]).toMatchObject({
      workerName: NOME_REDIGIDO, workerEmail: null, workerPhone: null, workerAvatarUrl: null,
    });
  });

  it('o nome LEGADO em texto claro é redigido igual — não escapa por não custar KMS', async () => {
    mockFetchRawRows.mockResolvedValue([linhaLegado()]);
    const out = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', ['funnel:read']);

    expect(mockKmsDecrypt).toHaveBeenCalledTimes(0);
    expect(out.rows[0].workerName).toBe(NOME_REDIGIDO);
    expect(JSON.stringify(out)).not.toContain('Carlos Legado');
  });

  it('com a célula de contato, o legado volta a aparecer', async () => {
    mockFetchRawRows.mockResolvedValue([linhaLegado()]);
    const out = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', [CELL_WORKER_CONTACT_READ]);

    expect(out.rows[0].workerName).toBe('Carlos Legado');
  });

  it('a FOTO é dossiê (D168): sai com worker_pii:read, não com contato', async () => {
    mockFetchRawRows.mockResolvedValue([linhaCifrada()]);

    const soContato = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', [CELL_WORKER_CONTACT_READ]);
    expect(soContato.rows[0].workerName).toBe('María González');
    expect(soContato.rows[0].workerAvatarUrl).toBeNull();

    jest.clearAllMocks();
    mockKmsDecrypt.mockImplementation((v: string | null) =>
      typeof v === 'string' && v.startsWith('encrypted:')
        ? Promise.resolve(v.slice('encrypted:'.length))
        : Promise.resolve(''));
    mockFetchRawRows.mockResolvedValue([linhaCifrada()]);

    const comDossie = await new GetFunnelTableUseCase()
      .execute('jp-1', 'ALL', [CELL_WORKER_CONTACT_READ, CELL_WORKER_PII_READ]);
    expect(comDossie.rows[0].workerAvatarUrl).toBe('https://foto/maria.jpg');
  });

  it('engine que não decidiu (`null`, e é o DEFAULT do parâmetro) não muda nada — D113', async () => {
    mockFetchRawRows.mockResolvedValue([linhaCifrada()]);
    // Sem o 3º argumento: é assim que qualquer chamador antigo entra aqui.
    const out = await new GetFunnelTableUseCase().execute('jp-1', 'ALL');

    expect(out.rows[0]).toMatchObject({
      workerName: 'María González', workerEmail: EMAIL, workerPhone: TELEFONE,
      workerAvatarUrl: 'https://foto/maria.jpg',
    });
  });

  it('os contadores do funil não mudam com a redação — o número é do funil, não da PII', async () => {
    mockFetchRawRows.mockResolvedValue([linhaCifrada(), linhaLegado()]);
    const redigido = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', []);
    const aberto = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', null);

    expect(redigido.counts).toEqual(aberto.counts);
    expect(redigido.rows).toHaveLength(aberto.rows.length);
  });
});
