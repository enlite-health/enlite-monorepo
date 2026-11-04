import { useEffect, useState } from 'react';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import type { OutgoingCandidate } from '@domain/entities/SubstitutionRequest';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';

export type SubstitutionPeopleStatus = 'loading' | 'ok' | 'error';

/** "¿Quién no va a venir?": as pessoas com alocação vigente ou futura NESTE serviço, uma linha por pessoa (US3). */
export function useOutgoingCandidates(patientId: string, serviceId: string): { people: OutgoingCandidate[]; status: SubstitutionPeopleStatus } {
  const [state, setState] = useState<{ people: OutgoingCandidate[]; status: SubstitutionPeopleStatus }>({ people: [], status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    AdminSubstitutionRequestsApiService.outgoingOptions(patientId, serviceId).then(
      (people) => !cancelled && setState({ people, status: 'ok' }),
      () => !cancelled && setState({ people: [], status: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [patientId, serviceId]);
  return state;
}

/** "¿Quién la cubre?": o pool do serviço (`allocation-options` — a MESMA regra `canAllocate` do back; o front nunca redefine "Selecionado"). */
export function useCoverCandidates(patientId: string, serviceId: string): { candidates: ServiceTeamMember[]; status: SubstitutionPeopleStatus } {
  const [state, setState] = useState<{ candidates: ServiceTeamMember[]; status: SubstitutionPeopleStatus }>({ candidates: [], status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    AdminContractedServicesApiService.getAllocationOptions(patientId, serviceId).then(
      ({ options }) => !cancelled && setState({ candidates: options, status: 'ok' }),
      () => !cancelled && setState({ candidates: [], status: 'error' }),
    );
    return () => {
      cancelled = true;
    };
  }, [patientId, serviceId]);
  return state;
}
