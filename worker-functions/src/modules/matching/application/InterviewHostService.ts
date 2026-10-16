import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import type {
  InterviewHostAdminRow,
  InterviewHostRepository,
  InterviewHostWrite,
  StaffCandidate,
} from '../infrastructure/InterviewHostRepository';
import type { TactiqLinkState } from './ports/TactiqPorts';
import {
  InterviewHostAlreadyActiveError,
  InterviewHostNotFoundError,
  InterviewHostUserNotEligibleError,
} from './InterviewHostErrors';

/**
 * InterviewHostService — a tela Entrevistadores (spec 055): lista, busca de candidatos, agregar, editar e quitar.
 *
 *  - R1: só usuário staff ATIVO entra (recusa `INTERVIEW_HOST_USER_NOT_ELIGIBLE`, 400). Vale também no editar: a linha sem usuário
 *    (ex.: Ana Joulie, sem usuário em prd) só aceita "Quitar" (os dois fluxos desligados).
 *  - Os dois fluxos desligados = Quitar: a linha fica `active=false` (não é apagada; os eventos guardam o e-mail como texto).
 *  - POST de pessoa que já existe INATIVA reativa a mesma linha (UNIQUE(email) e UNIQUE(user_uid) seguem valendo).
 *  - `country` (legado, NOT NULL) é gravado pelo repositório como `countries[0]`.
 */
export interface InterviewHostInput {
  countries: string[];
  doesEnquadre: boolean;
  doesAdmission: boolean;
}

export interface InterviewHostCreateInput extends InterviewHostInput {
  userUid: string;
}

export interface InterviewHostListItem extends InterviewHostAdminRow {
  tactiq: TactiqLinkState;
}

export interface InterviewHostServiceDeps {
  db: Pool;
  repo: InterviewHostRepository;
  tactiq: { statesFor(emails: string[]): Promise<Map<string, TactiqLinkState>> };
}

export class InterviewHostService {
  constructor(private readonly deps: InterviewHostServiceDeps) {}

  async list(): Promise<InterviewHostListItem[]> {
    const rows = await this.deps.repo.listAdmin();
    const states = rows.length > 0 ? await this.deps.tactiq.statesFor(rows.map((r) => r.email)) : new Map<string, TactiqLinkState>();
    return rows.map((r) => ({ ...r, tactiq: states.get(r.email.toLowerCase()) ?? 'missing' }));
  }

  async candidates(q: string): Promise<StaffCandidate[]> {
    return this.deps.repo.searchCandidates(q);
  }

  async create(input: InterviewHostCreateInput, actorUid: string): Promise<{ id: string }> {
    return withActorContext(this.deps.db, async (client) => {
      const user = await this.deps.repo.findEligibleUser(input.userUid, client);
      if (!user) throw new InterviewHostUserNotEligibleError();
      const write = this.writeOf(input, actorUid);
      const existing = await this.deps.repo.findByUserOrEmail(user.uid, user.email, client);
      if (!existing) return { id: await this.deps.repo.insert(user, write, client) };
      if (existing.active) throw new InterviewHostAlreadyActiveError();
      await this.deps.repo.update(existing.id, write, client, user);
      return { id: existing.id };
    });
  }

  async update(id: string, patch: Partial<InterviewHostInput>, actorUid: string): Promise<void> {
    await withActorContext(this.deps.db, async (client) => {
      const current = await this.deps.repo.findById(id, client);
      if (!current) throw new InterviewHostNotFoundError();
      const merged: InterviewHostInput = {
        countries: patch.countries ?? current.countries,
        doesEnquadre: patch.doesEnquadre ?? current.doesEnquadre,
        doesAdmission: patch.doesAdmission ?? current.doesAdmission,
      };
      const write = this.writeOf(merged, actorUid);
      // R1 também aqui: sem usuário staff ativo a linha só pode SAIR (os dois fluxos desligados), nunca ser religada/editada.
      if (write.active) {
        const user = current.userUid ? await this.deps.repo.findEligibleUser(current.userUid, client) : null;
        if (!user) throw new InterviewHostUserNotEligibleError();
      }
      await this.deps.repo.update(id, write, client);
    });
  }

  /** `active` deriva dos fluxos: nenhum marcado = Quitar. */
  private writeOf(i: InterviewHostInput, updatedBy: string): InterviewHostWrite {
    return { ...i, active: i.doesEnquadre || i.doesAdmission, updatedBy };
  }
}
