/**
 * patientDocuments.e2e.test.ts — spec 031, F1 (aba "Documentos" da ficha do paciente). HTTP real (app em
 * processo), Postgres real, GCS real (fake-gcs-server), SEM mock de banco ou storage. Cada cenário roda com o
 * engine ABAC LIGADO (célula decide) e DESLIGADO (papel admin decide, `untilEnforced`), em dois apps do mesmo
 * processo — ver `documentsE2eHelpers.ts`. Texto 100% sintético (nenhum nome/clínico real).
 *
 * Como rodar (stack própria, ver `docs/diario/2026-10/2026-10-02.md`):
 *   docker compose -p e031 -f docker-compose.yml -f docker-compose.test.yml -f <override: pg 5631, fake-gcs 54463> \
 *     up -d postgres fake-gcs
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5631/enlite_e2e node scripts/run-migrations-docker.js
 *   (o `tests/e2e/setup.ts` espera GET /health em API_URL: aponte para qualquer 200)
 *   DATABASE_URL=... GCS_EMULATOR_HOST=http://localhost:54463 API_URL=http://localhost:<porta-health> \
 *     npx jest --config jest.config.e2e.js --runInBand tests/e2e/patient-documents
 */
import { buildStoredZip } from '../../../src/modules/conversation/infrastructure/__tests__/__fixtures__/buildZip';
import type { AppDeFamilia } from '../helpers/permissionFamilyHarness';
import {
  setupDocumentsFixture,
  teardownDocumentsFixture,
  call,
  postForm,
  postChatMessageWithFile,
  docsPath,
  convPath,
  sha256Hex,
  fromPassthrough,
  gcsObjectBytes,
  gcsObjectCount,
  PDF_BYTES,
  DOCUMENTS_BUCKET,
  type DocumentsFixture,
} from './documentsE2eHelpers';

let fx: DocumentsFixture;

beforeAll(async () => {
  fx = await setupDocumentsFixture();
}, 60000);

afterAll(async () => {
  await teardownDocumentsFixture(fx);
});

const pdf = (name: string, extra = ''): { buffer: Buffer; filename: string; mimetype: string } => ({
  buffer: Buffer.concat([PDF_BYTES, Buffer.from(`\n% ${extra || name}`)]),
  filename: name,
  mimetype: 'application/pdf',
});

/** `resource_access_log` é gravado depois do `finish` (fire-and-forget): espera a linha aparecer. */
async function accessLogActions(uid: string, like: string, esperada: string): Promise<string[]> {
  let acoes: string[] = [];
  for (let i = 0; i < 50; i++) {
    const { rows } = await fx.pool.query<{ action: string }>(
      `SELECT action FROM resource_access_log WHERE operator_uid = $1 AND action LIKE $2 ORDER BY action`,
      [uid, like],
    );
    acoes = rows.map((r) => r.action);
    if (acoes.includes(esperada)) return acoes;
    await new Promise((r) => setTimeout(r, 100));
  }
  return acoes;
}

const MODOS = [['ligado'], ['desligado']] as const;

describe.each(MODOS)('aba Documentos — engine ABAC %s', (modo) => {
  const app = (): AppDeFamilia => (modo === 'ligado' ? fx.appLigado : fx.appDesligado);
  const p1 = (): string => fx.patients[modo].p1;
  const p2 = (): string => fx.patients[modo].p2;
  const full = (): string => fx.actors.full;

  it('1. subir → listar → ver (sha256 igual, caminho/nome cifrados) → renomear → excluir (objeto some, link 404)', async () => {
    const sent = pdf('scan0012.pdf', 'um');
    const up = await postForm(app(), docsPath(p1()), full(), sent, { label: '  DNI frente ' });
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ origin: 'tab', label: 'DNI frente', contentType: 'application/pdf', createdByUid: full(), labelUpdatedAt: null });
    expect(up.body.data.createdByDisplayName).toBe('Full Sintetica');
    expect(up.body.data.sizeBytes).toBe(sent.buffer.byteLength);
    const docId: string = up.body.data.id;

    // banco: tudo que identifica está cifrado (aqui: base64 do passthrough, ≠ claro), sha256 confere
    const { rows } = await fx.pool.query(
      `SELECT label_encrypted, file_path_encrypted, original_name_encrypted, encode(sha256, 'hex') AS sha, origin, country, created_by_uid
         FROM patient_documents WHERE id = $1`,
      [docId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].label_encrypted).not.toBe('DNI frente');
    expect(fromPassthrough(rows[0].label_encrypted)).toBe('DNI frente');
    expect(fromPassthrough(rows[0].original_name_encrypted)).toBe('scan0012.pdf');
    expect(rows[0].original_name_encrypted).not.toBe('scan0012.pdf');
    const objectPath = fromPassthrough(rows[0].file_path_encrypted);
    expect(objectPath).toMatch(/^patient-documents\/[0-9a-f-]{36}\.pdf$/);
    expect(rows[0]).toMatchObject({ sha: sha256Hex(sent.buffer), origin: 'tab', country: 'AR', created_by_uid: full() });

    // segundo documento, para provar a ordem (mais novo primeiro)
    const up2 = await postForm(app(), docsPath(p1()), full(), pdf('outro.pdf', 'dois'), { label: 'Resumen HC' });
    expect(up2.status).toBe(201);

    const list = await call(app(), 'GET', docsPath(p1()), full());
    expect(list.status).toBe(200);
    expect(list.body.data.map((d: { id: string }) => d.id)).toEqual([up2.body.data.id, docId]);

    // ver: URL de 300 s apontando para o objeto, e o objeto TEM os mesmos bytes (sha256 igual)
    const url = await call(app(), 'GET', `${docsPath(p1())}/${docId}/url`, full());
    expect(url.status).toBe(200);
    expect(url.body.data.expiresInSeconds).toBe(300);
    expect(decodeURIComponent(url.body.data.url)).toContain(`/${DOCUMENTS_BUCKET}/${objectPath}`);
    expect(decodeURIComponent(url.body.data.url)).toContain('scan0012.pdf'); // Content-Disposition leva o nome ORIGINAL
    const bytes = await gcsObjectBytes(objectPath);
    expect(bytes).not.toBeNull();
    expect(sha256Hex(bytes as Buffer)).toBe(sha256Hex(sent.buffer));

    // trilha de acesso: só UUID (nunca nome/rótulo)
    const actions = await accessLogActions(full(), '%patient_document%', `read_patient_document:${docId}`);
    expect(actions).toContain(`read_patient_document:${docId}`);
    const listActions = await accessLogActions(full(), 'list_patient_documents', 'list_patient_documents');
    expect(listActions).toContain('list_patient_documents');
    expect(JSON.stringify([...actions, ...listActions])).not.toMatch(/DNI|scan0012|Resumen/);

    // renomear: nome novo (trim) + trilha de quem/quando; nome vazio recusado e o antigo fica
    const ren = await call(app(), 'PATCH', `${docsPath(p1())}/${docId}`, full(), { json: { label: '  Documento nacional  ' } });
    expect(ren.status).toBe(200);
    expect(ren.body.data.label).toBe('Documento nacional');
    expect(ren.body.data.labelUpdatedAt).not.toBeNull();
    const trail = await fx.pool.query(`SELECT label_updated_by_uid FROM patient_documents WHERE id = $1`, [docId]);
    expect(trail.rows[0].label_updated_by_uid).toBe(full());
    const vazio = await call(app(), 'PATCH', `${docsPath(p1())}/${docId}`, full(), { json: { label: '   ' } });
    expect(vazio.status).toBe(400);
    const depois = await call(app(), 'GET', docsPath(p1()), full());
    expect(depois.body.data.find((d: { id: string }) => d.id === docId).label).toBe('Documento nacional');

    // excluir: definitivo — some a linha, o objeto, e o link
    const del = await call(app(), 'DELETE', `${docsPath(p1())}/${docId}`, full());
    expect(del.status).toBe(204);
    const gone = await fx.pool.query(`SELECT 1 FROM patient_documents WHERE id = $1`, [docId]);
    expect(gone.rowCount).toBe(0);
    expect(await gcsObjectBytes(objectPath)).toBeNull();
    expect((await call(app(), 'GET', `${docsPath(p1())}/${docId}/url`, full())).status).toBe(404);
    const after = await call(app(), 'GET', docsPath(p1()), full());
    expect(after.body.data.map((d: { id: string }) => d.id)).toEqual([up2.body.data.id]);
    expect((await call(app(), 'DELETE', `${docsPath(p1())}/${docId}`, full())).status).toBe(404);
  });

  it('2. validação no SERVIDOR: 11 MB = 413, .xlsx = 415, sem nome = 400 — nada gravado, nada no bucket', async () => {
    const antesLinhas = (await fx.pool.query(`SELECT count(*)::int AS n FROM patient_documents WHERE patient_id = $1`, [p1()])).rows[0].n;
    const antesObjetos = await gcsObjectCount('patient-documents/');

    const grande = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(11 * 1024 * 1024)]);
    const r413 = await postForm(app(), docsPath(p1()), full(), { buffer: grande, filename: 'grande.pdf', mimetype: 'application/pdf' }, { label: 'Grande' });
    expect(r413.status).toBe(413);
    expect(r413.body.code).toBe('FILE_TOO_LARGE');

    const xlsx = buildStoredZip([
      { name: '[Content_Types].xml', content: Buffer.from('<?xml version="1.0"?><Types xmlns="ct"/>', 'utf8') },
      { name: '_rels/.rels', content: Buffer.from('<?xml version="1.0"?><Relationships xmlns="r"/>', 'utf8') },
      { name: 'xl/workbook.xml', content: Buffer.from('<?xml version="1.0"?><workbook/>', 'utf8') },
    ]);
    const r415 = await postForm(
      app(), docsPath(p1()), full(),
      { buffer: xlsx, filename: 'planilha.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { label: 'Planilha' },
    );
    expect(r415.status).toBe(415);

    const semNome = await postForm(app(), docsPath(p1()), full(), pdf('sem-nome.pdf'));
    expect(semNome.status).toBe(400);
    const nomeEnorme = await postForm(app(), docsPath(p1()), full(), pdf('longo.pdf'), { label: 'a'.repeat(256) });
    expect(nomeEnorme.status).toBe(400);

    const depoisLinhas = (await fx.pool.query(`SELECT count(*)::int AS n FROM patient_documents WHERE patient_id = $1`, [p1()])).rows[0].n;
    expect(depoisLinhas).toBe(antesLinhas);
    expect(await gcsObjectCount('patient-documents/')).toBe(antesObjetos);
  });

  it('3. docId de OUTRO paciente = 404 (ver, renomear, excluir) e o documento segue intacto sob o paciente certo', async () => {
    const up = await postForm(app(), docsPath(p1()), full(), pdf('do-p1.pdf'), { label: 'Do paciente 1' });
    const docId: string = up.body.data.id;

    expect((await call(app(), 'GET', `${docsPath(p2())}/${docId}/url`, full())).status).toBe(404);
    expect((await call(app(), 'PATCH', `${docsPath(p2())}/${docId}`, full(), { json: { label: 'Invasor' } })).status).toBe(404);
    expect((await call(app(), 'DELETE', `${docsPath(p2())}/${docId}`, full())).status).toBe(404);
    expect((await call(app(), 'GET', docsPath('00000000-0000-4000-8000-000000000000'), full())).status).toBe(404); // paciente inexistente
    expect((await call(app(), 'GET', docsPath(p2()), full())).body.data).toEqual([]); // e a lista do outro paciente não o traz

    const ok = await call(app(), 'GET', `${docsPath(p1())}/${docId}/url`, full());
    expect(ok.status).toBe(200); // controle positivo: o MESMO docId funciona sob o paciente certo
    const row = await fx.pool.query(`SELECT label_encrypted FROM patient_documents WHERE id = $1`, [docId]);
    expect(fromPassthrough(row.rows[0].label_encrypted)).toBe('Do paciente 1');
  });

  it('4. anexar no chat CRIA o documento na MESMA transação (mesmo xmin), com autor/data do envio e o MESMO arquivo (sha256 igual)', async () => {
    const sent = pdf('resumen-hc.pdf', 'chat');
    const { fileId, message } = await postChatMessageWithFile(app(), p1(), full(), sent);
    expect(message.status).toBe(201);
    const messageId: string = message.body.data.id;

    const list = await call(app(), 'GET', docsPath(p1()), full());
    const item = list.body.data.find((d: { origin: string; label: string }) => d.origin === 'chat' && d.label === 'resumen-hc.pdf');
    expect(item).toBeDefined();
    expect(item).toMatchObject({ contentType: 'application/pdf', createdByUid: full(), createdByDisplayName: 'Full Sintetica', sizeBytes: sent.buffer.byteLength });

    const { rows } = await fx.pool.query(
      `SELECT d.xmin::text AS doc_tx, m.xmin::text AS msg_tx, d.created_at = m.created_at AS mesma_data,
              d.source_message_id, d.stored_file_id, d.file_path_encrypted, encode(sf.sha256, 'hex') AS sha, sf.object_path_encrypted
         FROM patient_documents d
         JOIN conversation_messages m ON m.id = d.source_message_id
         JOIN stored_files sf ON sf.id = d.stored_file_id
        WHERE d.id = $1`,
      [item.id],
    );
    expect(rows[0].doc_tx).toBe(rows[0].msg_tx); // mesma transação: txid idêntico
    expect(rows[0]).toMatchObject({ mesma_data: true, source_message_id: messageId, stored_file_id: fileId, file_path_encrypted: null });
    expect(rows[0].sha).toBe(sha256Hex(sent.buffer));

    // "Ver" pela rota de documentos abre o MESMO objeto do chat
    const docUrl = await call(app(), 'GET', `${docsPath(p1())}/${item.id}/url`, full());
    const chatUrl = await call(app(), 'GET', `${convPath(p1())}/files/${fileId}/url`, full());
    expect(docUrl.status).toBe(200);
    const objectPath = fromPassthrough(rows[0].object_path_encrypted);
    expect(decodeURIComponent(docUrl.body.data.url)).toContain(`/${DOCUMENTS_BUCKET}/${objectPath}`);
    expect(decodeURIComponent(chatUrl.body.data.url)).toContain(`/${DOCUMENTS_BUCKET}/${objectPath}`);
    expect(sha256Hex((await gcsObjectBytes(objectPath)) as Buffer)).toBe(sha256Hex(sent.buffer));
  });

  it('5. falha FORÇADA do INSERT do documento desfaz a mensagem inteira (e o anexo); sem a falha, o mesmo arquivo posta normalmente', async () => {
    const up = await postForm(app(), `${convPath(p1())}/files`, full(), pdf('vai-falhar.pdf', 'falha'));
    expect(up.status).toBe(201);
    const fileId: string = up.body.data.fileId;
    const corpo = `msg-falha-${modo}`;

    await fx.pool.query(
      `CREATE OR REPLACE FUNCTION e031_forca_falha() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'e031 falha forcada'; END $$ LANGUAGE plpgsql`,
    );
    await fx.pool.query(`CREATE TRIGGER e031_forca_falha BEFORE INSERT ON patient_documents FOR EACH ROW EXECUTE FUNCTION e031_forca_falha()`);
    try {
      const falhou = await call(app(), 'POST', `${convPath(p1())}/messages`, full(), { json: { body: corpo, fileIds: [fileId] } });
      expect(falhou.status).toBe(500);

      const msgs = await fx.pool.query(
        `SELECT count(*)::int AS n FROM conversation_messages cm JOIN conversations c ON c.id = cm.conversation_id
          WHERE c.patient_id = $1 AND cm.author_uid = $2 AND cm.created_at > now() - interval '1 minute'
            AND cm.id IN (SELECT message_id FROM conversation_message_attachments WHERE file_id = $3)`,
        [p1(), full(), fileId],
      );
      expect(msgs.rows[0].n).toBe(0); // nenhuma mensagem ficou ligada ao arquivo
      const vinculos = await fx.pool.query(`SELECT count(*)::int AS n FROM conversation_message_attachments WHERE file_id = $1`, [fileId]);
      expect(vinculos.rows[0].n).toBe(0); // nem o vínculo
      const docs = await fx.pool.query(`SELECT count(*)::int AS n FROM patient_documents WHERE stored_file_id = $1`, [fileId]);
      expect(docs.rows[0].n).toBe(0);
    } finally {
      await fx.pool.query(`DROP TRIGGER IF EXISTS e031_forca_falha ON patient_documents`);
      await fx.pool.query(`DROP FUNCTION IF EXISTS e031_forca_falha()`);
    }

    // controle positivo: tirada a falha, o MESMO arquivo (que o rollback deixou livre) posta e vira documento
    const ok = await call(app(), 'POST', `${convPath(p1())}/messages`, full(), { json: { body: corpo, fileIds: [fileId] } });
    expect(ok.status).toBe(201);
    const docs = await fx.pool.query(`SELECT count(*)::int AS n FROM patient_documents WHERE stored_file_id = $1`, [fileId]);
    expect(docs.rows[0].n).toBe(1);
  });

  it('6. mensagem APAGADA pelo autor → o documento FICA na lista e continua abrindo (Q3)', async () => {
    const { fileId, message } = await postChatMessageWithFile(app(), p1(), full(), pdf('fica-na-lista.pdf', 'fica'));
    const messageId: string = message.body.data.id;
    const before = await call(app(), 'GET', docsPath(p1()), full());
    const item = before.body.data.find((d: { label: string }) => d.label === 'fica-na-lista.pdf');
    expect(item).toBeDefined();

    expect((await call(app(), 'DELETE', `${convPath(p1())}/messages/${messageId}`, full())).status).toBe(200);
    expect((await call(app(), 'GET', `${convPath(p1())}/files/${fileId}/url`, full())).status).toBe(404); // o chat segue escondendo (comportamento de hoje)

    const after = await call(app(), 'GET', docsPath(p1()), full());
    expect(after.body.data.some((d: { id: string }) => d.id === item.id)).toBe(true); // documento FICA
    expect((await call(app(), 'GET', `${docsPath(p1())}/${item.id}/url`, full())).status).toBe(200);
  });

  it('7. documento do chat EXCLUÍDO → a mensagem traz o anexo com `deleted: true` e sem nome; link do anexo = 404; arquivo marcado e objeto some', async () => {
    const sent = pdf('sera-eliminado.pdf', 'elim');
    const { fileId, message } = await postChatMessageWithFile(app(), p1(), full(), sent, `msg-eliminado-${modo}`);
    const messageId: string = message.body.data.id;
    const item = (await call(app(), 'GET', docsPath(p1()), full())).body.data.find((d: { label: string }) => d.label === 'sera-eliminado.pdf');
    const objectPath = fromPassthrough((await fx.pool.query(`SELECT object_path_encrypted AS p FROM stored_files WHERE id = $1`, [fileId])).rows[0].p);

    // antes: o anexo vem com nome e `deleted: false` (controle positivo)
    const anexoAntes = async (): Promise<any> => {
      const conv = await call(app(), 'GET', convPath(p1()), full());
      return conv.body.data.messages.find((m: { id: string }) => m.id === messageId)?.attachments[0];
    };
    expect(await anexoAntes()).toMatchObject({ fileId, originalName: 'sera-eliminado.pdf', deleted: false });
    expect(await gcsObjectBytes(objectPath)).not.toBeNull();

    expect((await call(app(), 'DELETE', `${docsPath(p1())}/${item.id}`, full())).status).toBe(204);

    const depois = await anexoAntes();
    expect(depois).toEqual({ fileId, contentType: 'application/pdf', sizeBytes: sent.buffer.byteLength, originalName: null, deleted: true });
    expect(JSON.stringify(depois)).not.toContain('sera-eliminado');
    const msgPresente = (await call(app(), 'GET', convPath(p1()), full())).body.data.messages.some((m: { id: string; deletedAt: string | null }) => m.id === messageId && m.deletedAt === null);
    expect(msgPresente).toBe(true); // a mensagem continua na conversa
    expect((await call(app(), 'GET', `${convPath(p1())}/files/${fileId}/url`, full())).status).toBe(404);
    const sf = await fx.pool.query(`SELECT deleted_at FROM stored_files WHERE id = $1`, [fileId]);
    expect(sf.rows[0].deleted_at).not.toBeNull();
    expect(await gcsObjectBytes(objectPath)).toBeNull(); // objeto apagado do bucket
    expect((await call(app(), 'GET', docsPath(p1()), full())).body.data.some((d: { id: string }) => d.id === item.id)).toBe(false);
  });
});

describe('engine LIGADO — autorização por célula (patient_document:*)', () => {
  const app = (): AppDeFamilia => fx.appLigado;
  const p = (): string => fx.patients.ligado.p1;

  it('Q11: conta com patient_document:read e SEM patient_conversation:read vê os documentos do chat e abre o arquivo, mas não a conversa', async () => {
    const { fileId } = await postChatMessageWithFile(app(), p(), fx.actors.full, pdf('so-via-aba.pdf', 'q11'));
    expect(fileId).toBeTruthy();

    const list = await call(app(), 'GET', docsPath(p()), fx.actors.docRead);
    expect(list.status).toBe(200);
    const item = list.body.data.find((d: { label: string }) => d.label === 'so-via-aba.pdf');
    expect(item).toMatchObject({ origin: 'chat' });
    expect((await call(app(), 'GET', `${docsPath(p())}/${item.id}/url`, fx.actors.docRead)).status).toBe(200);
    expect((await call(app(), 'GET', convPath(p()), fx.actors.docRead)).status).toBe(403); // não vê a conversa
    expect((await call(app(), 'GET', `${convPath(p())}/files/${fileId}/url`, fx.actors.docRead)).status).toBe(403);
  });

  it('só `read`: não sobe, não renomeia, não exclui (403) — e nada muda no banco', async () => {
    const up = await postForm(app(), docsPath(p()), fx.actors.full, pdf('intacto.pdf'), { label: 'Intacto' });
    const docId: string = up.body.data.id;
    const total = async (): Promise<number> => (await fx.pool.query(`SELECT count(*)::int AS n FROM patient_documents WHERE patient_id = $1`, [p()])).rows[0].n;
    const antes = await total();

    expect((await postForm(app(), docsPath(p()), fx.actors.docRead, pdf('x.pdf'), { label: 'X' })).status).toBe(403);
    expect((await call(app(), 'PATCH', `${docsPath(p())}/${docId}`, fx.actors.docRead, { json: { label: 'Trocado' } })).status).toBe(403);
    expect((await call(app(), 'DELETE', `${docsPath(p())}/${docId}`, fx.actors.docRead)).status).toBe(403);

    expect(await total()).toBe(antes);
    const row = await fx.pool.query(`SELECT label_encrypted FROM patient_documents WHERE id = $1`, [docId]);
    expect(fromPassthrough(row.rows[0].label_encrypted)).toBe('Intacto');
  });

  it('sem a célula (nenhum grupo) = 403 nas 5 rotas — a aba some igual', async () => {
    const some = '00000000-0000-4000-8000-0000000000aa';
    const u = fx.actors.none;
    expect((await call(app(), 'GET', docsPath(p()), u)).status).toBe(403);
    expect((await postForm(app(), docsPath(p()), u, pdf('x.pdf'), { label: 'X' })).status).toBe(403);
    expect((await call(app(), 'PATCH', `${docsPath(p())}/${some}`, u, { json: { label: 'X' } })).status).toBe(403);
    expect((await call(app(), 'DELETE', `${docsPath(p())}/${some}`, u)).status).toBe(403);
    expect((await call(app(), 'GET', `${docsPath(p())}/${some}/url`, u)).status).toBe(403);
  });

  it('FR-008: anexar no chat NÃO exige patient_document:create — conta só com as células do chat anexa, o documento nasce, e ela não vê a lista', async () => {
    const { message } = await postChatMessageWithFile(app(), p(), fx.actors.chatOnly, pdf('so-chat.pdf', 'chatonly'));
    expect(message.status).toBe(201);
    const row = await fx.pool.query(
      `SELECT d.created_by_uid FROM patient_documents d JOIN conversation_messages m ON m.id = d.source_message_id WHERE m.id = $1`,
      [message.body.data.id],
    );
    expect(row.rows[0].created_by_uid).toBe(fx.actors.chatOnly);
    expect((await call(app(), 'GET', docsPath(p()), fx.actors.chatOnly)).status).toBe(403);
  });
});

describe('engine DESLIGADO — só o papel decide (untilEnforced: admin, D268)', () => {
  const app = (): AppDeFamilia => fx.appDesligado;
  const p = (): string => fx.patients.desligado.p1;

  it('admin SEM nenhum grupo/célula passa (como o resto da ficha); papel não-admin (recruiter) recebe 403 nas 5 rotas', async () => {
    const up = await postForm(app(), docsPath(p()), fx.actors.none, pdf('sem-celula.pdf'), { label: 'Sem célula' });
    expect(up.status).toBe(201);
    const docId: string = up.body.data.id;
    expect((await call(app(), 'GET', docsPath(p()), fx.actors.none)).status).toBe(200);

    const r = fx.actors.recruiter;
    expect((await call(app(), 'GET', docsPath(p()), r)).status).toBe(403);
    expect((await postForm(app(), docsPath(p()), r, pdf('x.pdf'), { label: 'X' })).status).toBe(403);
    expect((await call(app(), 'PATCH', `${docsPath(p())}/${docId}`, r, { json: { label: 'X' } })).status).toBe(403);
    expect((await call(app(), 'DELETE', `${docsPath(p())}/${docId}`, r)).status).toBe(403);
    expect((await call(app(), 'GET', `${docsPath(p())}/${docId}/url`, r)).status).toBe(403);

    const row = await fx.pool.query(`SELECT 1 FROM patient_documents WHERE id = $1`, [docId]);
    expect(row.rowCount).toBe(1); // o recruiter não apagou nada
  });
});
