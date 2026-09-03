/**
 * Teste de CONTRATO back → front da ficha do paciente (spec 011, FR-A2).
 *
 * A fixture `fixtures/patient-detail.api.json` NÃO foi escrita à mão: é o `data`
 * de `GET /api/admin/patients/:id` da API real (docker `enlite-api`, Postgres
 * `enlite_e2e`), para um paciente SINTÉTICO semeado com 1 responsável,
 * 1 endereço, 1 profissional, cobertura e e-mail. Dados inventados — nenhum
 * paciente real. Recaptura: ver `specs/011-admissao-a-bugs-dado/relatorio.md`.
 *
 * O que este teste trava:
 *  - a entidade `PatientDetail` lê as chaves que a API manda (`name`, não
 *    `fullName`; `addressFormatted`, não `fullAddress`) — o `.strict()` do
 *    schema reprova chave a mais OU a menos;
 *  - o e-mail (`contactEmail`) e a cobertura (`insuranceInformed`) chegam na
 *    ficha para o paciente semeado com eles (A3/A4).
 */
import { describe, it, expect } from 'vitest';
import type { PatientDetail } from '../PatientDetail';
import { patientDetailContractSchema, type PatientDetailContract } from '../patientDetailContract';
import fixture from './fixtures/patient-detail.api.json';

// Atribuível nas DUAS direções: campo a mais, a menos ou com outro tipo em
// qualquer um dos lados vira erro de compilação (o `tsc --noEmit` é gate).
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const contractIsEntity: MutuallyAssignable<PatientDetailContract, PatientDetail> = true;

describe('contrato PatientDetail — fixture capturada da API real', () => {
  it('o tipo do schema É a entidade (as duas direções)', () => {
    expect(contractIsEntity).toBe(true);
  });

  it('a resposta real da API passa no schema da entidade, sem chave a mais nem a menos', () => {
    const parsed = patientDetailContractSchema.safeParse(fixture);
    if (!parsed.success) {
      // Mostra o caminho de cada divergência — é a evidência do drift.
      throw new Error(JSON.stringify(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })), null, 2));
    }
    expect(parsed.success).toBe(true);
  });

  it('profissional e endereço vêm nas chaves que os cards leem', () => {
    const p = patientDetailContractSchema.parse(fixture);
    expect(p.professionals[0].name).toBe('Dra. Fixture Tratante');
    expect(p.addresses[0].addressFormatted).toBe('Av. Fixture 123, CABA, AR');
    expect(p.responsibles[0].source).toBe('web_form');
  });

  it('cobertura gravada em health_insurance_name aparece em insuranceInformed (A3) e o e-mail chega (A4)', () => {
    const p = patientDetailContractSchema.parse(fixture);
    expect(p.insuranceInformed).toBe('OSDE 210 (fixture)');
    expect(p.contactEmail).toBe('contrato.fixture@example.test');
  });
});
