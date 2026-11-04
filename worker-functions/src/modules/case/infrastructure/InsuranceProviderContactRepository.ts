/**
 * InsuranceProviderContactRepository — a pessoa de CONTATO da obra social (E2, migration 534; spec 058 §3.2, cartão Empregados).
 *
 * DADO PESSOAL: `phone`, `email` e `document_number` são cifrados com o `EncryptionService` antes de gravar (molde
 * `PatientResponsibleRepository.ts:103`) e só são DECIFRADOS quando o chamador pede (`decrypt: true`) — o controller só pede para o ator com
 * `insurance_provider_contacts:read`. Quem escreve sem ler recebe a linha redigida, sem nenhuma chamada ao KMS. Nenhum valor cifrado ou
 * decifrado vai para log/erro. Sem DELETE: aposentar = `retired_at` (a trigger `fn_058_a_contacts_retired_at` carimba o relógio do banco
 * quando recebe `'infinity'`).
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

export interface EncryptionPort {
  encrypt(plaintext: string | null | undefined): Promise<string | null>;
  decrypt(ciphertext: string | null | undefined): Promise<string>;
}

/** Contato como a API devolve. `redacted: true` = o ator não lê a célula: `phone`, `email` e `document.number` vêm `null`. */
export interface InsuranceContact {
  id: string;
  fullName: string;
  roleTitle: string;
  phone: string | null;
  email: string | null;
  document: { type: string; number: string | null } | null;
  retired: boolean;
  redacted: boolean;
}

export interface CreateContactInput {
  fullName: string;
  roleTitle: string;
  phone: string;
  email?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
}

export interface PatchContactInput {
  fullName?: string;
  roleTitle?: string;
  phone?: string;
  email?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
}

export type ContactWriteOutcome =
  | { outcome: 'ok'; contact: InsuranceContact }
  | { outcome: 'not_found' }
  | { outcome: 'retired' };

interface Row {
  id: string;
  full_name: string;
  role_title: string;
  phone_encrypted: string;
  email_encrypted: string | null;
  document_type: string | null;
  document_number_encrypted: string | null;
  retired_at: Date | string | null;
}

const COLUMNS = `id, full_name, role_title, phone_encrypted, email_encrypted, document_type, document_number_encrypted, retired_at`;

export class InsuranceProviderContactRepository {
  private poolMemo?: Pool;
  private encMemo?: EncryptionPort;

  constructor(enc?: EncryptionPort, private readonly poolProvider?: () => Pool) {
    this.encMemo = enc;
  }

  private get pool(): Pool {
    this.poolMemo ??= this.poolProvider ? this.poolProvider() : DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  private get enc(): EncryptionPort {
    this.encMemo ??= new KMSEncryptionService();
    return this.encMemo;
  }

  private async toContact(r: Row, decrypt: boolean): Promise<InsuranceContact> {
    const base = {
      id: r.id,
      fullName: r.full_name,
      roleTitle: r.role_title,
      retired: r.retired_at !== null,
    };
    if (!decrypt) {
      return {
        ...base,
        phone: null,
        email: null,
        document: r.document_type === null ? null : { type: r.document_type, number: null },
        redacted: true,
      };
    }
    const [phone, email, number] = await Promise.all([
      this.enc.decrypt(r.phone_encrypted),
      r.email_encrypted === null ? Promise.resolve(null) : this.enc.decrypt(r.email_encrypted),
      r.document_number_encrypted === null ? Promise.resolve(null) : this.enc.decrypt(r.document_number_encrypted),
    ]);
    return {
      ...base,
      phone,
      email,
      document: r.document_type === null ? null : { type: r.document_type, number },
      redacted: false,
    };
  }

  /** Contatos da obra social (os aposentados só com `includeRetired`). */
  async list(providerCode: string, opts: { decrypt: boolean; includeRetired?: boolean }): Promise<InsuranceContact[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM insurance_provider_contacts
        WHERE provider_code = $1 ${opts.includeRetired ? '' : 'AND retired_at IS NULL'}
        ORDER BY lower(full_name), id`,
      [providerCode],
    );
    return Promise.all(r.rows.map((x) => this.toContact(x, opts.decrypt)));
  }

  async create(providerCode: string, input: CreateContactInput, actorUid: string, decrypt: boolean): Promise<InsuranceContact> {
    const [phoneEnc, emailEnc, docEnc] = await Promise.all([
      this.enc.encrypt(input.phone),
      this.enc.encrypt(input.email ?? null),
      this.enc.encrypt(input.documentNumber ?? null),
    ]);
    const r = await this.pool.query<Row>(
      `INSERT INTO insurance_provider_contacts
         (provider_code, full_name, role_title, phone_encrypted, email_encrypted, document_type, document_number_encrypted, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       RETURNING ${COLUMNS}`,
      [providerCode, input.fullName, input.roleTitle, phoneEnc, emailEnc, input.documentType ?? null, docEnc, actorUid],
    );
    return this.toContact(r.rows[0], decrypt);
  }

  /** Ausente = não toca; `null` = limpa (e-mail, ou o par do documento). Contato aposentado não se edita. */
  async patch(providerCode: string, contactId: string, input: PatchContactInput, actorUid: string, decrypt: boolean): Promise<ContactWriteOutcome> {
    const sets: string[] = [];
    const params: unknown[] = [contactId, providerCode, actorUid];
    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.fullName !== undefined) push('full_name', input.fullName);
    if (input.roleTitle !== undefined) push('role_title', input.roleTitle);
    if (input.phone !== undefined) push('phone_encrypted', await this.enc.encrypt(input.phone));
    if (input.email !== undefined) push('email_encrypted', await this.enc.encrypt(input.email));
    if (input.documentType !== undefined) push('document_type', input.documentType);
    if (input.documentNumber !== undefined) push('document_number_encrypted', await this.enc.encrypt(input.documentNumber));
    sets.push('updated_by = $3', 'updated_at = CURRENT_TIMESTAMP');
    const r = await this.pool.query<Row>(
      `UPDATE insurance_provider_contacts SET ${sets.join(', ')}
        WHERE id = $1 AND provider_code = $2 AND retired_at IS NULL
        RETURNING ${COLUMNS}`,
      params,
    );
    if (r.rows[0]) return { outcome: 'ok', contact: await this.toContact(r.rows[0], decrypt) };
    return this.whyNotWritten(providerCode, contactId);
  }

  /** Aposenta (nunca DELETE). */
  async retire(providerCode: string, contactId: string, actorUid: string, decrypt: boolean): Promise<ContactWriteOutcome> {
    const r = await this.pool.query<Row>(
      `UPDATE insurance_provider_contacts SET retired_at = 'infinity', updated_by = $3, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND provider_code = $2 AND retired_at IS NULL
        RETURNING ${COLUMNS}`,
      [contactId, providerCode, actorUid],
    );
    if (r.rows[0]) return { outcome: 'ok', contact: await this.toContact(r.rows[0], decrypt) };
    return this.whyNotWritten(providerCode, contactId);
  }

  private async whyNotWritten(providerCode: string, contactId: string): Promise<ContactWriteOutcome> {
    const r = await this.pool.query<{ retired_at: unknown }>(
      `SELECT retired_at FROM insurance_provider_contacts WHERE id = $1 AND provider_code = $2`,
      [contactId, providerCode],
    );
    return r.rows[0] ? { outcome: 'retired' } : { outcome: 'not_found' };
  }
}
