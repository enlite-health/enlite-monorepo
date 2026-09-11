/**
 * WorkerCompletenessRepository.test.ts
 *
 * Fase 1 de openspec/changes/postulacao-documento-pendente (DD1): o
 * `GET /api/workers/me` (e o PUT de info geral, que relê pelo mesmo caminho —
 * `WorkerControllerV2Helpers.readFreshProgress`) passam a devolver os tokens
 * `doc_*` em vez do agregado `worker_documents`, pelo MESMO ponto de expansão
 * que o 403 do track-channel usa (`BlockedApplicationRepository`).
 *
 * Os testes de `readWorkerMissingFields` SEM `worker_documents` no array
 * (caminho feliz, null, erro de banco) já vivem em
 * `WorkerControllerV2Helpers.test.ts` (import direto do mesmo módulo) — não
 * duplicados aqui. Este arquivo cobre: (a) `fetchWorkerDocumentRow`, função
 * nova; (b) o ramo de expansão de `readWorkerMissingFields`, também novo.
 */

const mockReportError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerChild = jest.fn().mockReturnValue({ warn: mockLoggerWarn, info: jest.fn(), debug: jest.fn() });

jest.mock('@shared/logging', () => ({
  logger: { child: (...args: unknown[]) => mockLoggerChild(...args) },
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

import {
  readWorkerMissingFields,
  fetchWorkerDocumentRow,
} from '../WorkerCompletenessRepository';

const poolWith = (impl: jest.Mock) => ({ query: impl }) as never;

beforeEach(() => jest.clearAllMocks());

describe('fetchWorkerDocumentRow', () => {
  it('devolve a linha (profissão + URLs de documentos) quando o worker existe', async () => {
    const row = {
      profession: 'AT',
      resume_cv_url: null,
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: 'url',
    };
    const q = jest.fn().mockResolvedValue({ rows: [row] });

    await expect(fetchWorkerDocumentRow(poolWith(q), 'w1')).resolves.toEqual(row);

    const [sql, params] = q.mock.calls[0];
    expect(sql).toMatch(/FROM workers w/);
    expect(sql).toMatch(/LEFT JOIN worker_documents wd/);
    expect(sql).toMatch(/merged_into_id IS NULL/);
    expect(params).toEqual(['w1']);
  });

  it('worker não encontrado (ou merge órfão) → null', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [] });
    await expect(fetchWorkerDocumentRow(poolWith(q), 'w1')).resolves.toBeNull();
  });
});

describe('readWorkerMissingFields — expansão de worker_documents (F13/DD1)', () => {
  it('worker_documents no array → expande pra doc_* usando fetchWorkerDocumentRow', async () => {
    const q = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ missing: ['title_certificate', 'worker_documents'] }] }) // fn_worker_missing_fields
      .mockResolvedValueOnce({
        rows: [{
          profession: 'AT',
          resume_cv_url: null,
          identity_document_url: 'url',
          criminal_record_url: 'url',
          at_certificate_url: 'url',
        }],
      }); // fetchWorkerDocumentRow

    const result = await readWorkerMissingFields(poolWith(q), 'w1');

    expect(result).toEqual(['title_certificate', 'doc_resume_cv']);
    expect(q).toHaveBeenCalledTimes(2);
  });

  it('sem worker_documents no array → NÃO faz a segunda query (só fn_worker_missing_fields)', async () => {
    const q = jest.fn().mockResolvedValueOnce({ rows: [{ missing: ['phone'] }] });
    const result = await readWorkerMissingFields(poolWith(q), 'w1');
    expect(result).toEqual(['phone']);
    expect(q).toHaveBeenCalledTimes(1);
  });

  it('fetchWorkerDocumentRow falha → não-fatal, devolve o array CRU (com worker_documents), avisa alguém', async () => {
    const q = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ missing: ['worker_documents'] }] })
      .mockRejectedValueOnce(new Error('db down no meio da expansão'));

    const result = await readWorkerMissingFields(poolWith(q), 'w1');

    // Fallback gracioso: a completude GERAL (as outras abas) não se perde por
    // causa de uma falha ao detalhar QUAL documento falta.
    expect(result).toEqual(['worker_documents']);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('fetchWorkerDocumentRow rejeita com NÃO-Error → mesmo fallback (ramo String(err))', async () => {
    const q = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ missing: ['worker_documents'] }] })
      .mockRejectedValueOnce('boom cru, não é Error');

    const result = await readWorkerMissingFields(poolWith(q), 'w1');
    expect(result).toEqual(['worker_documents']);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('worker não encontrado na expansão (fetchWorkerDocumentRow → null) → devolve worker_documents cru', async () => {
    const q = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ missing: ['worker_documents'] }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await readWorkerMissingFields(poolWith(q), 'w1');
    expect(result).toEqual(['worker_documents']);
  });

  it('C7 — o log de falha na expansão NÃO recebe o array de tokens nem a linha de documentos (conta, não lista)', async () => {
    const q = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ missing: ['title_certificate', 'worker_documents'] }] })
      .mockRejectedValueOnce(new Error('boom'));

    await readWorkerMissingFields(poolWith(q), 'w1');

    // A mensagem estática pode CITAR o nome do token ("worker_documents") —
    // isso não é lista, é rótulo fixo. O que C7 proíbe é o ARRAY de tokens (ou
    // a linha com URLs de documento) virar VALOR de algum campo do log.
    for (const call of [...mockLoggerWarn.mock.calls, ...mockLoggerChild.mock.calls]) {
      for (const arg of call) {
        const values = typeof arg === 'object' && arg !== null ? Object.values(arg) : [arg];
        for (const v of values) {
          expect(Array.isArray(v)).toBe(false);
        }
      }
    }
  });
});
