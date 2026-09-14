import {
  resolveDocumentRelativePath,
  assertDocumentPathBelongsToWorker,
  matchesOwnedDocumentPathShape,
  matchesOwnedDocumentPrefix,
  buildOwnedDocumentPathPattern,
  buildOwnedDocumentPrefixPattern,
} from '../documentPathGuard';

const BUCKET = 'enlite-worker-documents';
const WORKER_A = '11111111-1111-4111-8111-111111111111';
const WORKER_B = '22222222-2222-4222-8222-222222222222';
const DOC_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const OWNED_BY_A = `workers/${WORKER_A}/identity_document/${DOC_UUID}.pdf`;
const OWNED_BY_B = `workers/${WORKER_B}/identity_document/${DOC_UUID}.pdf`;

describe('resolveDocumentRelativePath', () => {
  it('rejeita valores não-string', () => {
    expect(resolveDocumentRelativePath(undefined, BUCKET)).toBeNull();
    expect(resolveDocumentRelativePath(null, BUCKET)).toBeNull();
    expect(resolveDocumentRelativePath(123, BUCKET)).toBeNull();
    expect(resolveDocumentRelativePath({}, BUCKET)).toBeNull();
  });

  it('rejeita string vazia', () => {
    expect(resolveDocumentRelativePath('', BUCKET)).toBeNull();
  });

  it('aceita um path relativo simples', () => {
    expect(resolveDocumentRelativePath(OWNED_BY_A, BUCKET)).toBe(OWNED_BY_A);
  });

  it('extrai o path relativo de uma URL assinada do MESMO bucket, descartando query string', () => {
    const url = `https://storage.googleapis.com/${BUCKET}/${OWNED_BY_A}?X-Goog-Signature=abc`;
    expect(resolveDocumentRelativePath(url, BUCKET)).toBe(OWNED_BY_A);
  });

  it('rejeita URL de OUTRO bucket no mesmo host GCS', () => {
    const url = `https://storage.googleapis.com/outro-bucket/${OWNED_BY_A}`;
    expect(resolveDocumentRelativePath(url, BUCKET)).toBeNull();
  });

  it('rejeita URL absoluta de host diferente (ex.: tentativa de SSRF/exfiltração)', () => {
    expect(resolveDocumentRelativePath('https://evil.example.com/x.pdf', BUCKET)).toBeNull();
    expect(resolveDocumentRelativePath('http://evil.example.com/x.pdf', BUCKET)).toBeNull();
  });

  it('rejeita path absoluto de filesystem', () => {
    expect(resolveDocumentRelativePath('/etc/passwd', BUCKET)).toBeNull();
    expect(resolveDocumentRelativePath('\\windows\\system32', BUCKET)).toBeNull();
  });

  it('rejeita path traversal literal', () => {
    expect(resolveDocumentRelativePath('workers/../other/x.pdf', BUCKET)).toBeNull();
    expect(resolveDocumentRelativePath('../../etc/passwd', BUCKET)).toBeNull();
  });

  it('rejeita path traversal PERCENT-ENCODED ("%2e%2e")', () => {
    expect(resolveDocumentRelativePath(`workers/${WORKER_A}/%2e%2e/${WORKER_B}/x.pdf`, BUCKET)).toBeNull();
    expect(resolveDocumentRelativePath('%2e%2e/%2e%2e/etc/passwd', BUCKET)).toBeNull();
  });

  it('rejeita percent-encoding malformado (decodeURIComponent lança)', () => {
    expect(resolveDocumentRelativePath('workers/x/%E0%A4%A', BUCKET)).toBeNull();
  });

  it('rejeita barra invertida no meio do path', () => {
    expect(resolveDocumentRelativePath('workers\\w1\\x.pdf', BUCKET)).toBeNull();
  });

  it('rejeita barra dupla no meio do path', () => {
    expect(resolveDocumentRelativePath('workers//w1/x.pdf', BUCKET)).toBeNull();
  });

  it('rejeita "?" e "#" soltos no path (fora do prefixo de URL do bucket)', () => {
    expect(resolveDocumentRelativePath('workers/w1/x.pdf?evil=1', BUCKET)).toBeNull();
    expect(resolveDocumentRelativePath('workers/w1/x.pdf#fragment', BUCKET)).toBeNull();
  });

  it('rejeita quando o prefixo do bucket some da string após o slice (string vazia resultante)', () => {
    const url = `https://storage.googleapis.com/${BUCKET}/`;
    expect(resolveDocumentRelativePath(url, BUCKET)).toBeNull();
  });
});

describe('buildOwnedDocumentPathPattern / matchesOwnedDocumentPathShape', () => {
  it('aceita workers/<workerId>/<docType>/<uuid>.<ext> para os 3 tipos de extensão aceitos', () => {
    for (const ext of ['pdf', 'jpg', 'png']) {
      expect(matchesOwnedDocumentPathShape(`workers/${WORKER_A}/identity_document/${DOC_UUID}.${ext}`, BUCKET, WORKER_A)).toBe(true);
    }
  });

  it('aceita o segmento "additional" (documentos adicionais)', () => {
    expect(matchesOwnedDocumentPathShape(`workers/${WORKER_A}/additional/${DOC_UUID}.pdf`, BUCKET, WORKER_A)).toBe(true);
  });

  it('aceita todos os 11 tipos fixos de documento', () => {
    const types = [
      'resume_cv', 'identity_document', 'identity_document_back', 'criminal_record',
      'professional_registration', 'liability_insurance', 'monotributo_certificate',
      'at_certificate', 'apto_psicofisico', 'analitico_universitario', 'carta_recomendacion',
    ];
    for (const t of types) {
      expect(matchesOwnedDocumentPathShape(`workers/${WORKER_A}/${t}/${DOC_UUID}.pdf`, BUCKET, WORKER_A)).toBe(true);
    }
  });

  it('rejeita workerId de OUTRO worker no prefixo', () => {
    expect(matchesOwnedDocumentPathShape(`workers/${WORKER_B}/identity_document/${DOC_UUID}.pdf`, BUCKET, WORKER_A)).toBe(false);
  });

  it('rejeita docType fora da lista fixa', () => {
    expect(matchesOwnedDocumentPathShape(`workers/${WORKER_A}/nao-existe/${DOC_UUID}.pdf`, BUCKET, WORKER_A)).toBe(false);
  });

  it('rejeita basename que não é UUID', () => {
    expect(matchesOwnedDocumentPathShape(`workers/${WORKER_A}/identity_document/nao-e-uuid.pdf`, BUCKET, WORKER_A)).toBe(false);
    expect(matchesOwnedDocumentPathShape(`workers/${WORKER_A}/identity_document/../${DOC_UUID}.pdf`, BUCKET, WORKER_A)).toBe(false);
  });

  it('rejeita extensão fora de pdf/jpg/png', () => {
    expect(matchesOwnedDocumentPathShape(`workers/${WORKER_A}/identity_document/${DOC_UUID}.exe`, BUCKET, WORKER_A)).toBe(false);
    expect(matchesOwnedDocumentPathShape(`workers/${WORKER_A}/identity_document/${DOC_UUID}.svg`, BUCKET, WORKER_A)).toBe(false);
  });

  it('rejeita caminho sem prefixo workers/<workerId>/ nenhum', () => {
    expect(matchesOwnedDocumentPathShape(`other/${WORKER_A}/identity_document/${DOC_UUID}.pdf`, BUCKET, WORKER_A)).toBe(false);
  });

  it('rejeita quando o path bruto é inválido (traversal, host diferente etc.)', () => {
    expect(matchesOwnedDocumentPathShape('../../etc/passwd', BUCKET, WORKER_A)).toBe(false);
    expect(matchesOwnedDocumentPathShape('https://evil.example.com/x.pdf', BUCKET, WORKER_A)).toBe(false);
  });

  it('a URL completa do objeto de OUTRO worker também é rejeitada (mesmo bucket, workerId errado)', () => {
    const fullUrlOfB = `https://storage.googleapis.com/${BUCKET}/${OWNED_BY_B}`;
    expect(matchesOwnedDocumentPathShape(fullUrlOfB, BUCKET, WORKER_A)).toBe(false);
  });

  it('buildOwnedDocumentPathPattern escapa caracteres especiais de regex no workerId', () => {
    const weirdId = 'a.b*c';
    const pattern = buildOwnedDocumentPathPattern(weirdId);
    expect(pattern.test(`workers/aXbYc/identity_document/${DOC_UUID}.pdf`)).toBe(false);
    expect(pattern.test(`workers/${weirdId}/identity_document/${DOC_UUID}.pdf`)).toBe(true);
  });
});

describe('assertDocumentPathBelongsToWorker', () => {
  it('true quando o path normalizado tem a forma do PRÓPRIO worker e bate com um dos paths gravados', () => {
    expect(assertDocumentPathBelongsToWorker(OWNED_BY_A, BUCKET, WORKER_A, [OWNED_BY_A, null, undefined])).toBe(true);
  });

  it('true quando o path gravado está salvo como URL completa mas o pedido vem relativo (ou vice-versa)', () => {
    const ownedAsUrl = `https://storage.googleapis.com/${BUCKET}/${OWNED_BY_A}`;
    expect(assertDocumentPathBelongsToWorker(OWNED_BY_A, BUCKET, WORKER_A, [ownedAsUrl])).toBe(true);
  });

  it('false quando o path não está na lista de paths gravados do worker (mesmo tendo a forma certa)', () => {
    const outroDocDoMesmoWorker = `workers/${WORKER_A}/identity_document/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.pdf`;
    expect(assertDocumentPathBelongsToWorker(outroDocDoMesmoWorker, BUCKET, WORKER_A, [OWNED_BY_A])).toBe(false);
  });

  it('false quando o path é de OUTRO worker, mesmo que apareça (por erro) na lista de paths gravados', () => {
    expect(assertDocumentPathBelongsToWorker(OWNED_BY_B, BUCKET, WORKER_A, [OWNED_BY_B])).toBe(false);
  });

  it('false quando o path do pedido é inválido (traversal)', () => {
    expect(assertDocumentPathBelongsToWorker('../../etc/passwd', BUCKET, WORKER_A, [OWNED_BY_A])).toBe(false);
  });

  it('false quando a lista de paths do worker está vazia', () => {
    expect(assertDocumentPathBelongsToWorker(OWNED_BY_A, BUCKET, WORKER_A, [])).toBe(false);
  });

  it('ignora entradas null/undefined/vazias na lista de paths do worker', () => {
    expect(assertDocumentPathBelongsToWorker(OWNED_BY_A, BUCKET, WORKER_A, [null, undefined, '', OWNED_BY_A])).toBe(true);
  });

  it('false quando uma entrada armazenada é ela mesma inválida e não bate', () => {
    expect(assertDocumentPathBelongsToWorker(OWNED_BY_A, BUCKET, WORKER_A, ['../traversal-invalido'])).toBe(false);
  });
});

describe('buildOwnedDocumentPrefixPattern / matchesOwnedDocumentPrefix (checagem de SAVE — só prefixo, sem exigir uuid/ext)', () => {
  it('aceita qualquer caminho dentro de workers/<workerId>/, mesmo sem a forma uuid.ext', () => {
    expect(matchesOwnedDocumentPrefix(`workers/${WORKER_A}/resume_cv/qualquer-nome.pdf`, BUCKET, WORKER_A)).toBe(true);
    expect(matchesOwnedDocumentPrefix(`workers/${WORKER_A}/tipo-nao-listado/x`, BUCKET, WORKER_A)).toBe(true);
    expect(matchesOwnedDocumentPrefix(OWNED_BY_A, BUCKET, WORKER_A)).toBe(true);
  });

  it('rejeita caminho de OUTRO worker, mesmo com forma válida', () => {
    expect(matchesOwnedDocumentPrefix(OWNED_BY_B, BUCKET, WORKER_A)).toBe(false);
  });

  it('rejeita caminho sem o prefixo workers/<workerId>/ nenhum', () => {
    expect(matchesOwnedDocumentPrefix(`other/${WORKER_A}/x.pdf`, BUCKET, WORKER_A)).toBe(false);
    expect(matchesOwnedDocumentPrefix(`workers/${WORKER_A}extra/x.pdf`, BUCKET, WORKER_A)).toBe(false);
  });

  it('rejeita path traversal e percent-encoded traversal mesmo tentando simular o prefixo certo', () => {
    expect(matchesOwnedDocumentPrefix(`workers/${WORKER_A}/../${WORKER_B}/x.pdf`, BUCKET, WORKER_A)).toBe(false);
    expect(matchesOwnedDocumentPrefix(`workers/${WORKER_A}/%2e%2e/${WORKER_B}/x.pdf`, BUCKET, WORKER_A)).toBe(false);
  });

  it('rejeita URL absoluta de outro host/bucket', () => {
    expect(matchesOwnedDocumentPrefix('https://evil.example.com/x.pdf', BUCKET, WORKER_A)).toBe(false);
  });

  it('buildOwnedDocumentPrefixPattern escapa caracteres especiais de regex no workerId', () => {
    const weirdId = 'a.b*c';
    const pattern = buildOwnedDocumentPrefixPattern(weirdId);
    expect(pattern.test('workers/aXbYc/x.pdf')).toBe(false);
    expect(pattern.test(`workers/${weirdId}/x.pdf`)).toBe(true);
  });
});
