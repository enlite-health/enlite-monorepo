/**
 * PatientDocumentRepository — SQL de `patient_documents` (spec 031, migration 497).
 *
 * Leitura aceita `Pool | PoolClient` (a sessão da request já carrega país — `rlsAwarePool`);
 * ESCRITA sempre recebe o `client` da transação aberta por `withActorContext` no use case
 * (nunca `pool.connect()` cru — `connect-cru-sem-actor-context-da-500`).
 *
 * Tudo que é nome/caminho entra e sai CIFRADO daqui; quem decifra é o use case. Nenhum valor de
 * nome/caminho vai para log.
 */
import type { Pool, PoolClient } from 'pg';
import type { PatientDocumentOrigin } from '../domain/PatientDocument';

type Executor = Pool | PoolClient;

export interface PatientDocumentRow {
  id: string;
  origin: PatientDocumentOrigin;
  labelEncrypted: string;
  contentType: string;
  sizeBytes: number;
  createdByUid: string;
  createdByDisplayName: string | null;
  createdAt: Date;
  labelUpdatedAt: Date | null;
}

export interface InsertTabDocumentParams {
  patientId: string;
  labelEncrypted: string;
  filePathEncrypted: string;
  originalNameEncrypted: string;
  contentType: string;
  sizeBytes: number;
  sha256: Buffer;
  createdByUid: string;
}

export interface InsertChatDocumentsParams {
  conversationId: string;
  messageId: string;
  fileIds: string[];
  authorUid: string;
}

/** Onde está o arquivo de um documento (as duas origens), ainda cifrado. */
export interface PatientDocumentFileLocation {
  pathEncrypted: string;
  originalNameEncrypted: string;
}

export interface DeletedPatientDocument {
  origin: PatientDocumentOrigin;
  storedFileId: string | null;
  /** Caminho cifrado do objeto no bucket (aba: da própria linha; chat: de `stored_files`). */
  pathEncrypted: string | null;
}

export class PatientDocumentRepository {
  /** Paciente visível à sessão (RLS filtra país: de outro país = inexistente) e não apagado. */
  async patientExists(patientId: string, executor: Executor): Promise<boolean> {
    const { rows } = await executor.query(`SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL`, [patientId]);
    return rows.length > 0;
  }

  /** Lista (mais novo primeiro) ou UM documento (`docId`) do paciente. O nome do arquivo NÃO sai daqui. */
  async findByPatient(patientId: string, executor: Executor, docId?: string): Promise<PatientDocumentRow[]> {
    const params: unknown[] = [patientId];
    let docFilter = '';
    if (docId) {
      params.push(docId);
      docFilter = 'AND d.id = $2';
    }
    const { rows } = await executor.query<PatientDocumentRow>(
      `SELECT d.id,
              d.origin,
              d.label_encrypted AS "labelEncrypted",
              COALESCE(d.content_type, sf.content_type) AS "contentType",
              COALESCE(d.size_bytes, sf.size_bytes) AS "sizeBytes",
              d.created_by_uid AS "createdByUid",
              u.display_name AS "createdByDisplayName",
              d.created_at AS "createdAt",
              d.label_updated_at AS "labelUpdatedAt"
         FROM patient_documents d
         LEFT JOIN stored_files sf ON sf.id = d.stored_file_id
         LEFT JOIN users u ON u.firebase_uid = d.created_by_uid
        WHERE d.patient_id = $1 ${docFilter}
        ORDER BY d.created_at DESC, d.id DESC`,
      params,
    );
    return rows;
  }

  async insertTabDocument(params: InsertTabDocumentParams, client: PoolClient): Promise<{ id: string }> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO patient_documents
         (patient_id, origin, label_encrypted, file_path_encrypted, original_name_encrypted,
          content_type, size_bytes, sha256, created_by_uid)
       VALUES ($1, 'tab', $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        params.patientId,
        params.labelEncrypted,
        params.filePathEncrypted,
        params.originalNameEncrypted,
        params.contentType,
        params.sizeBytes,
        params.sha256,
        params.createdByUid,
      ],
    );
    return rows[0];
  }

  /**
   * Anexar no chat É criar documento (D456/D463, Q12): um documento por arquivo anexado, na MESMA
   * transação da mensagem (o `client` é o do `PostMessageUseCase`). Rótulo = nome original do
   * arquivo (ciphertext copiado, nunca decifrado aqui); autor = o do envio e data = `created_at` da
   * MENSAGEM lido da própria linha (um `Date` de JS truncaria os microssegundos). O arquivo NÃO é
   * copiado — a linha só aponta para `stored_files`. Devolve quantas linhas nasceram; quem chama
   * confere que é uma por arquivo.
   */
  async insertFromChatAttachments(params: InsertChatDocumentsParams, client: PoolClient): Promise<number> {
    const result = await client.query(
      `INSERT INTO patient_documents
         (patient_id, origin, label_encrypted, stored_file_id, source_message_id, created_by_uid, created_at)
       SELECT c.patient_id, 'chat', sf.original_name_encrypted, sf.id, m.id, $3, m.created_at
         FROM stored_files sf
         JOIN conversations c ON c.id = $1
         JOIN conversation_messages m ON m.id = $2 AND m.conversation_id = c.id
        WHERE sf.id = ANY($4::uuid[]) AND sf.conversation_id = c.id`,
      [params.conversationId, params.messageId, params.authorUid, params.fileIds],
    );
    return result.rowCount ?? 0;
  }

  /** Renomeia (única coluna editável + trilha). `false` = não existe neste paciente. */
  async renameLabel(
    params: { patientId: string; docId: string; labelEncrypted: string; actorUid: string },
    client: PoolClient,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE patient_documents
          SET label_encrypted = $3, label_updated_by_uid = $4, label_updated_at = now()
        WHERE id = $2 AND patient_id = $1`,
      [params.patientId, params.docId, params.labelEncrypted, params.actorUid],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Exclusão definitiva da LINHA (D463). Origem chat: marca `stored_files.deleted_at` (o chat passa a
   * mostrar "documento eliminado") e devolve o caminho do objeto, que quem chama apaga do bucket
   * DEPOIS do commit. `null` = não existe neste paciente.
   */
  async deleteDocument(patientId: string, docId: string, client: PoolClient): Promise<DeletedPatientDocument | null> {
    const { rows } = await client.query<{
      origin: PatientDocumentOrigin;
      storedFileId: string | null;
      filePathEncrypted: string | null;
    }>(
      `DELETE FROM patient_documents
        WHERE id = $2 AND patient_id = $1
        RETURNING origin, stored_file_id AS "storedFileId", file_path_encrypted AS "filePathEncrypted"`,
      [patientId, docId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.origin === 'tab') {
      return { origin: 'tab', storedFileId: null, pathEncrypted: row.filePathEncrypted };
    }

    const marked = await client.query<{ pathEncrypted: string }>(
      `UPDATE stored_files SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING object_path_encrypted AS "pathEncrypted"`,
      [row.storedFileId],
    );
    return { origin: 'chat', storedFileId: row.storedFileId, pathEncrypted: marked.rows[0]?.pathEncrypted ?? null };
  }

  /** Caminho + nome original (cifrados) do arquivo, para o "Ver". `null` = documento inexistente neste paciente. */
  async findFileLocation(
    patientId: string,
    docId: string,
    executor: Executor,
  ): Promise<PatientDocumentFileLocation | null> {
    const { rows } = await executor.query<PatientDocumentFileLocation>(
      `SELECT COALESCE(d.file_path_encrypted, sf.object_path_encrypted) AS "pathEncrypted",
              COALESCE(d.original_name_encrypted, sf.original_name_encrypted) AS "originalNameEncrypted"
         FROM patient_documents d
         LEFT JOIN stored_files sf ON sf.id = d.stored_file_id AND sf.deleted_at IS NULL
        WHERE d.id = $2 AND d.patient_id = $1`,
      [patientId, docId],
    );
    const row = rows[0];
    if (!row || !row.pathEncrypted) return null;
    return row;
  }
}
