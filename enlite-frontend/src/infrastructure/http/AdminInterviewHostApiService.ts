/**
 * AdminInterviewHostApiService — a tela Entrevistadores (spec 055). Células `interview_host:read` (listar) e `interview_host:update`
 * (candidatos, agregar, editar, quitar). Mesmo cliente HTTP da admissão (auth, envelope, `ApiError`).
 */
import { AdminAdmissionApiService } from './AdminAdmissionApiService';
import type { InterviewHost, InterviewHostCandidate, InterviewHostInput } from '@domain/entities/InterviewHost';

const BASE = '/api/admin/interview-hosts';

export class AdminInterviewHostApiService {
  static list(): Promise<InterviewHost[]> {
    return AdminAdmissionApiService.requestJson<InterviewHost[]>('GET', BASE);
  }

  static searchCandidates(q: string): Promise<InterviewHostCandidate[]> {
    return AdminAdmissionApiService.requestJson<InterviewHostCandidate[]>('GET', `${BASE}/candidates?q=${encodeURIComponent(q)}`);
  }

  static create(input: InterviewHostInput & { userUid: string }): Promise<{ id: string }> {
    return AdminAdmissionApiService.requestJson<{ id: string }>('POST', BASE, input);
  }

  /** Qualquer subconjunto; os dois fluxos `false` = Quitar. */
  static update(id: string, patch: Partial<InterviewHostInput>): Promise<{ id: string }> {
    return AdminAdmissionApiService.requestJson<{ id: string }>('PATCH', `${BASE}/${encodeURIComponent(id)}`, patch);
  }

  /** F5 (D16): declara/retira a licença de Tactiq da pessoa — mesma célula `interview_host:update`. */
  static setTactiqSeat(id: string, assigned: boolean): Promise<unknown> {
    return AdminAdmissionApiService.requestJson<unknown>('POST', `${BASE}/${encodeURIComponent(id)}/tactiq-seat`, { assigned });
  }
}
