import { resolveDocumentRelativePath, assertDocumentPathBelongsToWorker } from '../documentPathGuard';

const BUCKET = 'enlite-worker-documents';

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
    expect(resolveDocumentRelativePath('workers/w1/identity_document/x.pdf', BUCKET))
      .toBe('workers/w1/identity_document/x.pdf');
  });

  it('extrai o path relativo de uma URL assinada do MESMO bucket, descartando query string', () => {
    const url = `https://storage.googleapis.com/${BUCKET}/workers/w1/identity_document/x.pdf?X-Goog-Signature=abc`;
    expect(resolveDocumentRelativePath(url, BUCKET)).toBe('workers/w1/identity_document/x.pdf');
  });

  it('rejeita URL de OUTRO bucket no mesmo host GCS', () => {
    const url = 'https://storage.googleapis.com/outro-bucket/workers/w1/identity_document/x.pdf';
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

  it('rejeita path traversal', () => {
    expect(resolveDocumentRelativePath('workers/../other/x.pdf', BUCKET)).toBeNull();
    expect(resolveDocumentRelativePath('../../etc/passwd', BUCKET)).toBeNull();
  });

  it('rejeita barra invertida no meio do path', () => {
    expect(resolveDocumentRelativePath('workers\\w1\\x.pdf', BUCKET)).toBeNull();
  });

  it('rejeita barra dupla no meio do path', () => {
    expect(resolveDocumentRelativePath('workers//w1/x.pdf', BUCKET)).toBeNull();
  });

  it('rejeita quando o prefixo do bucket some da string após o slice (string vazia resultante)', () => {
    const url = `https://storage.googleapis.com/${BUCKET}/`;
    expect(resolveDocumentRelativePath(url, BUCKET)).toBeNull();
  });
});

describe('assertDocumentPathBelongsToWorker', () => {
  const OWNED = 'workers/w1/identity_document/real.pdf';
  const OTHER = 'workers/w2/identity_document/other.pdf';

  it('true quando o path normalizado bate com um dos paths do worker', () => {
    expect(assertDocumentPathBelongsToWorker(OWNED, BUCKET, [OWNED, null, undefined])).toBe(true);
  });

  it('true quando o path do worker está salvo como URL completa mas o pedido vem relativo (ou vice-versa)', () => {
    const ownedAsUrl = `https://storage.googleapis.com/${BUCKET}/${OWNED}`;
    expect(assertDocumentPathBelongsToWorker(OWNED, BUCKET, [ownedAsUrl])).toBe(true);
  });

  it('false quando o path não está na lista de paths do worker', () => {
    expect(assertDocumentPathBelongsToWorker(OTHER, BUCKET, [OWNED])).toBe(false);
  });

  it('false quando o path do pedido é inválido (traversal)', () => {
    expect(assertDocumentPathBelongsToWorker('../../etc/passwd', BUCKET, [OWNED])).toBe(false);
  });

  it('false quando a lista de paths do worker está vazia', () => {
    expect(assertDocumentPathBelongsToWorker(OWNED, BUCKET, [])).toBe(false);
  });

  it('ignora entradas null/undefined/vazias na lista de paths do worker', () => {
    expect(assertDocumentPathBelongsToWorker(OWNED, BUCKET, [null, undefined, '', OWNED])).toBe(true);
  });

  it('false quando uma entrada armazenada é ela mesma inválida e não bate', () => {
    expect(assertDocumentPathBelongsToWorker(OWNED, BUCKET, ['../traversal-invalido'])).toBe(false);
  });
});
