/**
 * Banco FALSO em memória para testar o `SyncTalentumVacanciesUseCase` (spec 040 / F2): responde às
 * consultas do use case pelo texto do SQL (em vez de uma fila de `mockResolvedValueOnce` que quebra
 * a cada consulta nova). Infra de teste — fora do piso de cobertura (ver `jest.config.js`).
 *
 * Guarda só o que o use case lê/escreve: vagas (`job_postings`), perguntas e — para provar que o sync
 * NÃO as toca — as linhas de FAQ. Nenhum dado real, nenhuma PII.
 */

export interface FakeVacancy {
  id: string;
  title: string;
  talentum_project_id: string | null;
  talentum_public_id: string | null;
  talentum_whatsapp_url: string | null;
  talentum_slug: string | null;
  talentum_published_at: string | null;
  talentum_description: string | null;
  vacancy_number: number | null;
  case_number: number | null;
  deleted_at: string | null;
}

export class FakeJobPostingsDb {
  vacancies: FakeVacancy[] = [];
  /** FAQ por vaga — o sync v2 não pode alterá-la. */
  faq = new Map<string, Array<{ question: string; answer: string }>>();
  questionsByVacancy = new Map<string, number>();
  /** Toda SQL que mencionou a tabela de FAQ (esperado: nenhuma). */
  faqSql: string[] = [];
  /** Falhas injetadas: trecho do SQL → erro (dispara uma vez). */
  failOnce = new Map<string, Error>();
  private seq = 0;
  /** Próximo `vacancy_number` devolvido pelo `nextval`. */
  nextVn = 1001;
  poolQueries = 0;
  /** SQL de toda chamada do client transacional (BEGIN/COMMIT/ROLLBACK/INSERT/UPDATE...). */
  clientSql: string[] = [];

  add(v: Partial<FakeVacancy> & { id: string; title: string }): FakeVacancy {
    const full: FakeVacancy = {
      talentum_project_id: null,
      talentum_public_id: null,
      talentum_whatsapp_url: null,
      talentum_slug: null,
      talentum_published_at: null,
      talentum_description: null,
      vacancy_number: null,
      case_number: null,
      deleted_at: null,
      ...v,
    };
    this.vacancies.push(full);
    return full;
  }

  private maybeFail(sql: string): void {
    for (const [frag, err] of this.failOnce) {
      if (sql.includes(frag)) {
        this.failOnce.delete(frag);
        throw err;
      }
    }
  }

  private pick(rows: FakeVacancy[]) {
    return rows.map((r) => ({ id: r.id, talentum_project_id: r.talentum_project_id }));
  }

  /** `pool.query` */
  readonly query = async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
    this.poolQueries++;
    this.maybeFail(sql);
    if (sql.includes('job_posting_prescreening_faq')) {
      this.faqSql.push(sql);
      return { rows: [] };
    }
    if (sql.includes('WHERE talentum_project_id = $1')) {
      return { rows: this.pick(this.vacancies.filter((v) => v.talentum_project_id === params[0])) };
    }
    if (sql.includes('WHERE talentum_public_id = $1')) {
      return { rows: this.pick(this.vacancies.filter((v) => v.talentum_public_id === params[0] && !v.deleted_at)) };
    }
    if (sql.includes('WHERE title = $1')) {
      return {
        rows: this.pick(
          this.vacancies.filter(
            (v) => v.title === params[0] && !v.deleted_at && (v.talentum_public_id === null || v.talentum_public_id === params[1]),
          ),
        ),
      };
    }
    if (sql.includes('WHERE vacancy_number = $1')) {
      return { rows: this.pick(this.vacancies.filter((v) => v.vacancy_number === params[0])) };
    }
    if (sql.includes('WHERE case_number = $1')) {
      return { rows: this.pick(this.vacancies.filter((v) => v.case_number === params[0] && !v.deleted_at).slice(-1)) };
    }
    if (sql.includes('nextval')) {
      return { rows: [{ vn: String(this.nextVn++) }] };
    }
    if (sql.includes('DELETE FROM job_posting_prescreening_questions')) {
      this.questionsByVacancy.set(String(params[0]), 0);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO job_posting_prescreening_questions')) {
      const id = String(params[0]);
      this.questionsByVacancy.set(id, (this.questionsByVacancy.get(id) ?? 0) + 1);
      return { rows: [] };
    }
    return { rows: [] };
  };

  /** `pool.connect()` → client transacional (aplica o INSERT/UPDATE de `job_postings` ao commit). */
  readonly connect = async () => ({
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
      this.clientSql.push(sql);
      this.maybeFail(sql);
      if (sql.includes('INSERT INTO job_postings')) {
        this.seq += 1;
        const v = this.add({
          id: `fake-jp-${this.seq}`,
          title: String(params[2]),
          vacancy_number: params[0] as number,
          case_number: params[1] as number | null,
        });
        return { rows: [{ id: v.id }] };
      }
      if (sql.includes('UPDATE job_postings') && sql.includes('SET talentum_project_id')) {
        const [pid, pub, url, slug, at, desc, id] = params as Array<string | null>;
        const v = this.vacancies.find((x) => x.id === id)!;
        // mesma semântica do SQL: COALESCE nos demais campos (NULL mantém o gravado)
        v.talentum_project_id = pid;
        v.talentum_public_id = pub ?? v.talentum_public_id;
        v.talentum_whatsapp_url = url ?? v.talentum_whatsapp_url;
        v.talentum_slug = slug ?? v.talentum_slug;
        v.talentum_published_at = at ?? v.talentum_published_at;
        v.talentum_description = desc ?? v.talentum_description;
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  });
}
