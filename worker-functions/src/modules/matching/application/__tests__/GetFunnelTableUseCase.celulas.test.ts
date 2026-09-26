/**
 * F2/C3 — `GET /api/admin/vacancies/:id/funnel-table` sob as células.
 *
 * Esta rota tem uma armadilha própria: além do nome cifrado, ela tem o
 * `worker_raw_name` do import legado, em TEXTO CLARO. Um fallback fora da
 * projeção devolveria esse nome sem tocar o KMS — e o espião, sozinho, ficaria
 * verde. Por isso aqui a fronteira é asserida junto com o espião.
 */

const mockFetchRawRows = jest.fn();
const mockFetchBlockedRawRows = jest.fn().mockResolvedValue([]);
const mockKmsDecrypt = jest.fn();

jest.mock('../../infrastructure/FunnelTableRepository', () => ({
  FunnelTableRepository: jest.fn().mockImplementation(() => ({
    fetchRawRows: mockFetchRawRows,
    fetchBlockedRawRows: mockFetchBlockedRawRows,
  })),
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

/** Linha crua com `funnel_stage` arbitrário, para exercitar `deriveKanbanColumn`. */
function linhaComStage(stage: string) {
  return { ...linhaCifrada(), funnel_stage: stage, source: null, messaged_at: '2026-08-01T10:00:00Z' };
}

/** Card de tentativa negada (fetchBlockedRawRows) — mesmo shape de linha, `is_blocked: true`. */
function linhaBloqueada() {
  return {
    id: 'blk-1', worker_id: 'w-blk',
    first_name_encrypted: null, last_name_encrypted: null, worker_raw_name: null,
    email: null, phone: null, profile_photo_url_encrypted: null,
    invited_at: '2026-08-01T10:00:00Z',
    funnel_stage: null, interview_response: null,
    wbdl_dispatched_at: null, wbdl_delivery_status: null, wbdl_status: null,
    worker_status: null, contact_notes_count: 0, self_applied_at: null,
    source: null, messaged_at: null, is_blocked: true,
  };
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

describe('funnel-table — filtro `columns` e tentativa negada (DX-2.6, D433)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKmsDecrypt.mockImplementation((v: string | null) =>
      typeof v === 'string' && v.startsWith('encrypted:')
        ? Promise.resolve(v.slice('encrypted:'.length))
        : Promise.resolve(''));
    mockFetchBlockedRawRows.mockResolvedValue([]);
  });

  it('columns=[PRE_SCREENING, IN_PROGRESS] devolve as duas linhas', async () => {
    mockFetchRawRows.mockResolvedValue([linhaComStage('PRE_SCREENING'), linhaComStage('IN_PROGRESS')]);

    const out = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', null, ['PRE_SCREENING', 'IN_PROGRESS']);

    expect(out.rows).toHaveLength(2);
  });

  it('uma tentativa negada aparece com columns=[REJECTED] e NÃO com bucket=ALL', async () => {
    mockFetchRawRows.mockResolvedValue([]);
    mockFetchBlockedRawRows.mockResolvedValue([linhaBloqueada()]);

    const comFiltro = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', null, ['REJECTED']);
    expect(comFiltro.rows).toHaveLength(1);
    expect(comFiltro.rows[0].isBlocked).toBe(true);
    expect(comFiltro.rows[0].kanbanColumn).toBe('REJECTED');

    const semFiltro = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', null);
    expect(semFiltro.rows).toHaveLength(0);
  });

  it('counts.ALL não muda com tentativa negada, e counts.columns.REJECTED sobe 1', async () => {
    mockFetchRawRows.mockResolvedValue([linhaCifrada()]); // funnel_stage=CONFIRMED
    mockFetchBlockedRawRows.mockResolvedValue([linhaBloqueada()]);

    const out = await new GetFunnelTableUseCase().execute('jp-1', 'ALL');

    expect(out.counts.ALL).toBe(1);
    expect(out.counts.columns.REJECTED).toBe(1);
  });

  it('distanceKm (DX-3.10): "12.5" numérico na linha normal, null na tentativa negada', async () => {
    mockFetchRawRows.mockResolvedValue([{ ...linhaComStage('CONFIRMED'), distance_km: '12.5' }]);
    mockFetchBlockedRawRows.mockResolvedValue([linhaBloqueada()]);

    // columns inclui REJECTED (D433) para a bloqueada entrar em `rows` junto com a normal.
    const out = await new GetFunnelTableUseCase().execute('jp-1', 'ALL', null, ['CONFIRMED', 'REJECTED']);

    const normal = out.rows.find((r) => r.id === 'wja-1');
    const bloqueada = out.rows.find((r) => r.id === 'blk-1');
    expect(normal?.distanceKm).toBe(12.5);
    expect(bloqueada?.distanceKm).toBeNull();
  });
});
