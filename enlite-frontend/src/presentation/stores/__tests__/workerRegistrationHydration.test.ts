import { describe, it, expect } from 'vitest';
import { mergeGeneralInfo, mergeServiceAddress } from '../workerRegistrationHydration';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';

/**
 * A regra de precedência servidor × local — o coração do conserto de
 * 08/09/2026.
 *
 * O laço que travou 129 cadastros: a prestadora digitava o telefone, o backend
 * não o persistia (`COALESCE` com payload omisso), o cliente gravava no store o
 * que ELE tinha mandado, o store ia para o localStorage, e na volta a
 * hidratação preferia o valor local ao vazio do servidor. Conclusão: o número
 * aparecia preenchido para sempre, o campo nunca voltava a ficar "sujo", nunca
 * era reenviado — e a postulação era recusada por falta dele.
 */

const server = (overrides: Partial<WorkerProgressResponse> = {}): WorkerProgressResponse =>
  ({
    id: 'w1',
    authUid: 'a1',
    email: 'ana@example.com',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  }) as WorkerProgressResponse;

const local = () => ({
  email: 'ana@example.com',
  fullName: 'Ana',
  lastName: 'Perez',
  phone: '+5491151265663',
  birthDate: '1990-01-01',
  sex: 'female',
  gender: 'female',
  documentType: 'CUIL_CUIT',
  cpf: '20304050',
  languages: ['es'],
  profession: 'AT',
  knowledgeLevel: 'SECONDARY',
  professionalLicense: 'X-1',
  experienceTypes: ['adicciones'],
  yearsExperience: '0_2',
  preferredTypes: ['psicosis'],
  preferredAgeRange: ['adults'],
  profilePhoto: null as string | null,
});

describe('hidratação: precedência servidor × local', () => {
  describe('carregamento de tela (não autoritativo)', () => {
    it('preserva o valor local quando o servidor devolve vazio', () => {
      // Protege edição ainda não salva — o conserto do "campo aparece e some"
      // de 29/06/2026. Este comportamento NÃO muda.
      const merged = mergeGeneralInfo(server({ phone: undefined }), local());
      expect(merged.phone).toBe('+5491151265663');
      expect(merged.fullName).toBe('Ana');
    });

    it('o valor do servidor vence quando ele existe', () => {
      const merged = mergeGeneralInfo(server({ phone: '+5491199998888' }), local());
      expect(merged.phone).toBe('+5491199998888');
    });
  });

  describe('depois de uma escrita (authoritative)', () => {
    it('REGRESSÃO — campo que o banco NÃO tem some da tela', () => {
      // O servidor acabou de gravar e não devolveu telefone: o banco não tem.
      // Manter o valor local aqui é o defeito. Esvaziar é o conserto: a
      // prestadora vê que falta, e o campo volta a ficar "sujo" para reenvio.
      const merged = mergeGeneralInfo(server({ phone: undefined }), local(), {
        authoritative: true,
      });
      expect(merged.phone).toBe('');
    });

    it('REGRESSÃO — vale para todo campo do portão, não só o telefone', () => {
      const merged = mergeGeneralInfo(server({}), local(), { authoritative: true });
      expect(merged.professionalLicense).toBe('');
      expect(merged.yearsExperience).toBe('');
      expect(merged.languages).toEqual([]);
      expect(merged.experienceTypes).toEqual([]);
    });

    it('o que o servidor devolve é mantido', () => {
      const merged = mergeGeneralInfo(
        server({ phone: '+5491151265663', titleCertificate: 'MP-4321', languages: ['es', 'pt'] }),
        local(),
        { authoritative: true },
      );
      expect(merged.phone).toBe('+5491151265663');
      expect(merged.professionalLicense).toBe('MP-4321');
      expect(merged.languages).toEqual(['es', 'pt']);
    });

    it('a foto de perfil fica FORA da regra (apagar é operação legítima na tela)', () => {
      const withPhoto = { ...local(), profilePhoto: 'data:image/png;base64,x' };
      const merged = mergeGeneralInfo(server({}), withPhoto, { authoritative: true });
      expect(merged.profilePhoto).toBe('data:image/png;base64,x');
    });
  });

  describe('preferredAgeRange — o servidor às vezes manda string, não array', () => {
    it('string única vira array de um elemento', () => {
      const merged = mergeGeneralInfo(
        server({ preferredAgeRange: 'adults' as unknown as string[] }),
        local(),
      );
      expect(merged.preferredAgeRange).toEqual(['adults']);
    });

    it('string única também no caminho autoritativo', () => {
      const merged = mergeGeneralInfo(
        server({ preferredAgeRange: 'elderly' as unknown as string[] }),
        local(),
        { authoritative: true },
      );
      expect(merged.preferredAgeRange).toEqual(['elderly']);
    });
  });

  describe('endereço de atendimento', () => {
    it('preserva o local no carregamento', () => {
      const merged = mergeServiceAddress(server({}), {
        address: 'Av. Corrientes 1234',
        complement: '3B',
        serviceRadius: 10,
      });
      expect(merged.address).toBe('Av. Corrientes 1234');
    });

    it('esvazia depois da escrita quando o banco não tem', () => {
      const merged = mergeServiceAddress(
        server({}),
        { address: 'Av. Corrientes 1234', complement: '3B', serviceRadius: 10 },
        { authoritative: true },
      );
      expect(merged.address).toBe('');
      expect(merged.complement).toBe('');
    });
  });
});
