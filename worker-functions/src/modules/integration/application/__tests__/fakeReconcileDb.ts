/**
 * Banco FALSO em memória para os testes da reconciliação Talentum v2 (spec 040 / F5): responde às consultas
 * pelo texto do SQL. Infra de teste — fora do piso de cobertura (ver `jest.config.js`). Só dados sintéticos.
 */

export interface FakeRow {
  id: string;
  title: string | null;
  deleted: boolean;
  talentum_project_id: string | null;
  talentum_public_id: string | null;
  talentum_whatsapp_url: string | null;
  talentum_slug: string | null;
}

export class FakeReconcileDb {
  rows: FakeRow[] = [];
  /** `SHOW default_transaction_read_only`. */
  readOnlySetting = 'on';
  /** A escrita de teste (`CREATE TEMP TABLE`) falha com a mensagem de read-only? */
  probeFails = true;
  /** Contagem devolvida para `wa.me` (null = conta de verdade nas linhas). */
  waMeOverride: number | null = null;
  sql: string[] = [];
  released = 0;
  ended = 0;
  /** Força `rowCount` ≠ 1 nos UPDATE (guarda otimista / linha inexistente). */
  updateRowCount: number | null = null;

  add(r: Partial<FakeRow> & { id: string }): FakeRow {
    const full: FakeRow = {
      title: null, deleted: false, talentum_project_id: null, talentum_public_id: null,
      talentum_whatsapp_url: null, talentum_slug: null, ...r,
    };
    this.rows.push(full);
    return full;
  }

  snapshot(): string {
    return JSON.stringify([...this.rows].sort((a, b) => a.id.localeCompare(b.id)));
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number | null }> {
    this.sql.push(sql.trim().split(/\s+/).slice(0, 2).join(' '));
    if (sql.startsWith('SHOW')) return { rows: [{ default_transaction_read_only: this.readOnlySetting }], rowCount: 1 };
    if (sql.startsWith('CREATE TEMP')) {
      if (this.probeFails) throw new Error('cannot execute CREATE TABLE in a read-only transaction');
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("LIKE 'https://wa.me/%'")) {
      const n = this.waMeOverride ?? this.rows.filter((r) => r.talentum_whatsapp_url?.startsWith('https://wa.me/')).length;
      return { rows: [{ n }], rowCount: 1 };
    }
    if (sql.includes('FROM job_postings')) {
      const rows = this.rows
        .filter((r) => r.talentum_project_id !== null || r.talentum_public_id !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('UPDATE job_postings')) return this.update(params);
    return { rows: [], rowCount: 0 };
  }

  private update(p: unknown[]): { rows: any[]; rowCount: number | null } {
    const row = this.rows.find((r) => r.id === p[0]);
    if (!row || this.updateRowCount !== null) return { rows: [], rowCount: this.updateRowCount ?? 0 };
    if (p.length === 9) {
      const cur = [row.talentum_project_id, row.talentum_public_id, row.talentum_slug, row.talentum_whatsapp_url];
      if (JSON.stringify(cur) !== JSON.stringify(p.slice(5))) return { rows: [], rowCount: 0 };
    }
    [row.talentum_project_id, row.talentum_public_id, row.talentum_slug, row.talentum_whatsapp_url] =
      p.slice(1, 5) as [string | null, string | null, string | null, string | null];
    return { rows: [], rowCount: 1 };
  }

  async connect() {
    return { query: (s: string, p?: unknown[]) => this.query(s, p), release: () => { this.released++; } };
  }

  async end(): Promise<void> {
    this.ended++;
  }
}
