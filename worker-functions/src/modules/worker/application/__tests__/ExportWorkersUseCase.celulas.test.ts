/**
 * C5 — `GET /api/admin/workers/export` sob as células.
 *
 * ⚠️ A prova NÃO é "a coluna não está no CSV": é o KMS não rodar para ela.
 * Antes desta condição, `decryptRow` abria os 14 campos SEMPRE — exportar só
 * `status` descriptografava DNI, raça, religião e orientação sexual, e jogava
 * fora. O texto claro existiu em memória e pôde cair num log de erro do KMS
 * para quem nunca pediu aquele dado.
 *
 * ⚠️ Este use case não tinha NENHUM teste antes desta condição.
 */

const mockQuery = jest.fn();
const mockKmsDecrypt = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockKmsDecrypt })),
}));

import { ExportWorkersUseCase, ExportSemColunaPermitidaError } from '../ExportWorkersUseCase';
import { CELL_WORKER_PII_READ } from '../export/workerExportCells';
import { PRESTADOR_CANARIO, esperaSemDossieDePrestador } from '../../../matching/__tests__/guardaVazamentoPrestador';
import type { WorkerExportColumnKey } from '../export/workerExportColumns';

/** A linha CIFRADA, com o canário em cada campo de dossiê. */
function linhaCifrada() {
  return {
    id: 'w-1',
    email: 'operacional@exemplo.test',
    phone: '+5491100000000',
    status: 'ACTIVE',
    occupation: 'ENFERMERA',
    city: 'CABA',
    created_at: new Date('2026-01-15T10:00:00Z'),
    first_name_encrypted: `enc:${PRESTADOR_CANARIO.primeiroNome}`,
    last_name_encrypted: `enc:${PRESTADOR_CANARIO.sobrenome}`,
    gender_encrypted: 'enc:F',
    sex_encrypted: 'enc:F',
    // ── dossiê: tudo canário ────────────────────────────────────────────────
    birth_date_encrypted: `enc:${PRESTADOR_CANARIO.nascimento}`,
    document_number_encrypted: `enc:${PRESTADOR_CANARIO.documento}`,
    sexual_orientation_encrypted: `enc:${PRESTADOR_CANARIO.orientacaoSexual}`,
    race_encrypted: `enc:${PRESTADOR_CANARIO.raca}`,
    religion_encrypted: `enc:${PRESTADOR_CANARIO.religiao}`,
    address_line: PRESTADOR_CANARIO.endereco,
    // ── resto ───────────────────────────────────────────────────────────────
    languages_encrypted: 'enc:es',
    weight_kg_encrypted: 'enc:60',
    height_cm_encrypted: 'enc:165',
    whatsapp_phone_encrypted: `enc:${PRESTADOR_CANARIO.whatsapp}`,
    linkedin_url_encrypted: 'enc:https://li',
  };
}

const DOSSIE: WorkerExportColumnKey[] = [
  'document_number', 'birth_date', 'address_line', 'race', 'religion', 'sexual_orientation',
];

async function csvDe(result: { csvLines?: AsyncGenerator<string> }): Promise<string> {
  let out = '';
  for await (const l of result.csvLines!) out += l;
  return out;
}

function rodar(cells: string[] | null, columns: WorkerExportColumnKey[]) {
  return new ExportWorkersUseCase().execute({
    format: 'csv', columns, filters: {}, cells,
  });
}

describe('export — a célula decide a COLUNA, e decide antes do KMS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [linhaCifrada()] });
    mockKmsDecrypt.mockImplementation((v: string | null) =>
      Promise.resolve(typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : ''));
  });

  it('sem worker_pii:read: o dossiê é negado e o KMS NÃO roda para ele', async () => {
    const r = await rodar(['worker:export'], ['status', 'occupation', ...DOSSIE]);
    const csv = await csvDe(r);

    expect(r.negadas.sort()).toEqual([...DOSSIE].sort());
    // Nenhuma coluna cifrada sobrou no pedido → zero chamadas.
    expect(mockKmsDecrypt).toHaveBeenCalledTimes(0);
    // E a fronteira: nenhum canário de dossiê no arquivo inteiro.
    esperaSemDossieDePrestador(csv);
  });

  it('exportar SÓ `status` não abre 14 campos — o defeito que existia aqui', async () => {
    await csvDe(await rodar(['worker:export', CELL_WORKER_PII_READ], ['status']));
    // Antes da C5 isto era 14. Nenhum campo cifrado foi pedido.
    expect(mockKmsDecrypt).toHaveBeenCalledTimes(0);
  });

  it('com as duas células, o dossiê sai e o KMS roda SÓ nas 5 colunas cifradas dele', async () => {
    const r = await rodar(['worker:export', CELL_WORKER_PII_READ], DOSSIE);
    const csv = await csvDe(r);

    expect(r.negadas).toEqual([]);
    // 5, não 6: `address_line` é texto claro no banco, não custa KMS.
    expect(mockKmsDecrypt).toHaveBeenCalledTimes(5);
    expect(csv).toContain(PRESTADOR_CANARIO.documento);
    expect(csv).toContain(PRESTADOR_CANARIO.raca);
    expect(csv).toContain(PRESTADOR_CANARIO.endereco);
  });

  it('`cells === null` devolve o export inteiro — D113, nada muda antes do flip', async () => {
    const r = await rodar(null, ['status', ...DOSSIE]);
    const csv = await csvDe(r);

    expect(r.negadas).toEqual([]);
    expect(mockKmsDecrypt).toHaveBeenCalledTimes(5);
    expect(csv).toContain(PRESTADOR_CANARIO.documento);
  });

  it('TODA coluna negada vira erro nomeado — não planilha vazia', async () => {
    // Vazio parece base vazia, e quem exportou vai caçar o defeito no cadastro.
    await expect(rodar(['worker:export'], DOSSIE)).rejects.toBeInstanceOf(ExportSemColunaPermitidaError);
    expect(mockKmsDecrypt).toHaveBeenCalledTimes(0);
    // E nem a query chega a rodar: negar antes é não ler.
    expect(mockQuery).toHaveBeenCalledTimes(0);
  });

  it('o operacional continua saindo inteiro — o gate não esvazia a planilha', async () => {
    const csv = await csvDe(await rodar(['worker:export'], ['status', 'occupation', 'city', 'created_at']));
    expect(csv).toContain('ACTIVE');
    expect(csv).toContain('ENFERMERA');
    expect(csv).toContain('CABA');
  });

  it('contato NÃO é dossiê — nome e whatsapp saem só com worker:export (C5 não os cobre)', async () => {
    // Declarado: gatear contato no export muda o que a planilha serve para
    // fazer, e a C5 não pede. Está na lista, não no diff.
    const csv = await csvDe(await rodar(['worker:export'], ['first_name', 'whatsapp_phone']));
    expect(csv).toContain(PRESTADOR_CANARIO.primeiroNome);
    expect(mockKmsDecrypt).toHaveBeenCalledTimes(2);
  });
});
