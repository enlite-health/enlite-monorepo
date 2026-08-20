import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { AdmissionCountry } from '../domain/admissionCountries';

/**
 * InterviewHostRepository — quem atende entrevista de admissão, por país.
 *
 * A tabela `interview_hosts` (migration 252) guarda só identidade + país +
 * liga/desliga; a DISPONIBILIDADE não mora aqui, é lida da agenda Google de
 * cada pessoa em tempo de consulta. Por isso ligar/desligar uma atendente vale
 * na consulta seguinte, sem deploy — que é o que o spec exige.
 *
 * `display_name` existe para a operação saber de quem é a linha; **não vai para
 * o paciente** em lugar nenhum (nem no evento, nem na confirmação): quem o
 * paciente vê é sempre o nome genérico da equipe do país.
 */
export interface InterviewHost {
  email: string;
  displayName: string | null;
}

interface InterviewHostRow {
  email: string;
  display_name: string | null;
}

export class InterviewHostRepository {
  /**
   * Atendentes ATIVAS do país, em ordem de e-mail ascendente — a ordem é parte
   * do contrato: é o desempate determinístico da atribuição (D5), então não
   * pode depender da ordem física das linhas no Postgres.
   */
  async listActiveByCountry(country: AdmissionCountry): Promise<InterviewHost[]> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<InterviewHostRow>(
      `SELECT email, display_name
         FROM interview_hosts
        WHERE country = $1 AND active = true
        ORDER BY email ASC`,
      [country],
    );
    return res.rows.map((r) => ({ email: r.email, displayName: r.display_name }));
  }
}

export const interviewHostRepository = new InterviewHostRepository();
