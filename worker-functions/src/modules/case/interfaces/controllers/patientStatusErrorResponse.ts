import type { Request, Response } from 'express';
import {
  PatientStatusTransitionError,
  PatientStatusPermissionError,
  OnHoldReasonRequiredError,
  PatientStatusNotReadyError,
  PatientStatusLockedByAllocationError,
  SuspensionExitReasonRequiredError,
} from '../../application/PatientStatusWriter';
import { PatientStatusActionNotAvailableError } from '../../application/PatientStatusActionUseCase';
import { clinicalCellsOf } from '../../application/patientClinicalAccess';
import { exposeBlockingCodes, exposeBlockingMessage } from '../../application/patientContainerAccess';

/**
 * A ÚNICA tradução erro de domínio do estado do paciente → resposta HTTP (estado-automatico-do-paciente, F3). `PUT /status`,
 * `POST /status-actions` e a lista usam esta função: o mapa não tem duas implementações (o 422 de uma rota nunca diverge da outra).
 * Devolve `true` quando o erro era DESTA família e a resposta já foi escrita; `false` deixa o chamador tratar 404/500.
 * Só código, contagem e nomes de campo — nenhum texto clínico (`on_hold_note` nunca passa por aqui).
 */
type Corpo = { status: number; body: Record<string, unknown> };
type Traducao<E extends Error> = (err: E, req: Request) => Corpo;

const traducao = <E extends Error>(tipo: new (...args: never[]) => E, traduz: Traducao<E>): [new (...args: never[]) => Error, Traducao<Error>] =>
  [tipo, traduz as Traducao<Error>];

const TRADUCOES = [
  // Troca fora do fluxo sem a célula do destino (spec 051): 403 ANTES de qualquer escrita; `details.cell` leva o nome interno para o suporte.
  traducao(PatientStatusPermissionError, (err, _req) => ({
    status: 403, body: { success: false, error: 'Forbidden', code: err.code, details: { from: err.from, to: err.to, cell: err.cell } },
  })),
  traducao(PatientStatusTransitionError, (err) => ({
    status: 422, body: { success: false, error: err.message, code: err.code, details: { from: err.from, to: err.to } },
  })),
  traducao(OnHoldReasonRequiredError, (err) => ({ status: 422, body: { success: false, error: err.message, code: err.code } })),
  traducao(SuspensionExitReasonRequiredError, (err) => ({ status: 422, body: { success: false, error: err.message, code: err.code } })),
  // D489/D530: prestador com alocação viva no itinerário. Só a contagem — sem nome (PII).
  traducao(PatientStatusLockedByAllocationError, (err) => ({
    status: 422, body: { success: false, error: err.message, code: err.code, details: { allocations: err.allocations } },
  })),
  // F3: retomar fora de ON_HOLD/SUSPENDED, reativar fora de DISCHARGED, …
  traducao(PatientStatusActionNotAvailableError, (err) => ({
    status: 422, body: { success: false, error: err.message, code: err.code, details: { action: err.acao, from: err.from } },
  })),
  // Decisão do Gabriel 07/09. `details.missing` tem o MESMO formato do 422 do `POST /activate`. `DIAGNOSIS` (texto clínico) sai como
  // `CLINICAL_DATA` para quem não lê `patient_clinical` — a recusa é a mesma, só o NOME do item muda. Nunca o valor do diagnóstico.
  traducao(PatientStatusNotReadyError, (err, req) => {
    const cells = clinicalCellsOf(req);
    return {
      status: 422,
      body: { success: false, error: exposeBlockingMessage(err.message, cells), code: err.code, details: { to: err.to, missing: exposeBlockingCodes(err.missing, cells) } },
    };
  }),
];

export function respondPatientStatusError(err: unknown, req: Request, res: Response): boolean {
  const achada = TRADUCOES.find(([tipo]) => err instanceof tipo);
  if (!achada) return false;
  const { status, body } = achada[1](err as Error, req);
  res.status(status).json(body);
  return true;
}
