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
  country: 'AR',
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

  describe('country — Fase 3/DD4 (gateia a ajuda de antecedentes, trâmite argentino)', () => {
    // `country` é atributo de CONTA (não editável no formulário de registro,
    // sem campo próprio na tela) — o servidor é sempre a fonte, nos dois
    // caminhos (carregamento e pós-escrita), igual a `email`.
    it('carregamento de tela: country do servidor vence, mesmo com local diferente', () => {
      const merged = mergeGeneralInfo(server({ country: 'AR' }), { ...local(), country: 'BR' });
      expect(merged.country).toBe('AR');
    });

    it('pós-escrita (authoritative): country do servidor também vence', () => {
      const merged = mergeGeneralInfo(server({ country: 'AR' }), { ...local(), country: 'BR' }, {
        authoritative: true,
      });
      expect(merged.country).toBe('AR');
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

  describe('birthDate × birthDateStatus (spec 025, opção A, 21/09)', () => {
    // T2.3: o localStorage guardava o MESMO texto inválido que o servidor
    // acabou de rejeitar, e a precedência "local vence quando servidor vazio"
    // (regra acima, para proteger edição não-salva) reaproveitava esse lixo
    // pra sempre — o campo ficava travado mostrando a data ruim. Diferente do
    // caso `phone`/`professionalLicense`: aqui o servidor não está "vazio",
    // ele está DIZENDO que o dado é inválido — não é o mesmo silêncio que a
    // regra de proteção de edição foi desenhada para cobrir.
    it('status invalid → força vazio mesmo com local preenchido (carregamento de tela)', () => {
      const merged = mergeGeneralInfo(
        server({ birthDate: undefined, birthDateStatus: 'invalid' }),
        { ...local(), birthDate: '25/31/985' },
      );
      expect(merged.birthDate).toBe('');
    });

    it('status invalid → força vazio também no caminho autoritativo (pós-escrita)', () => {
      const merged = mergeGeneralInfo(
        server({ birthDate: undefined, birthDateStatus: 'invalid' }),
        { ...local(), birthDate: '25/31/985' },
        { authoritative: true },
      );
      expect(merged.birthDate).toBe('');
    });

    it('status missing (nunca cadastrou) → comportamento INALTERADO: local vence no carregamento', () => {
      const merged = mergeGeneralInfo(
        server({ birthDate: undefined, birthDateStatus: 'missing' }),
        { ...local(), birthDate: '1990-01-01' },
      );
      expect(merged.birthDate).toBe('1990-01-01');
    });

    it('status ok → valor do servidor é usado normalmente', () => {
      const merged = mergeGeneralInfo(
        server({ birthDate: '1985-06-20', birthDateStatus: 'ok' }),
        { ...local(), birthDate: '1990-01-01' },
      );
      expect(merged.birthDate).toBe('1985-06-20');
    });

    it('sem birthDateStatus no payload (compat) → cai na regra antiga (local vence se servidor vazio)', () => {
      const merged = mergeGeneralInfo(server({ birthDate: undefined }), {
        ...local(),
        birthDate: '1990-01-01',
      });
      expect(merged.birthDate).toBe('1990-01-01');
    });
  });
});
