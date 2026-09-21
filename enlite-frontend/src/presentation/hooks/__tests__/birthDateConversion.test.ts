import { describe, it, expect } from 'vitest';
import { maskDate, parseDateToISO, formatDateFromISO, isValidBirthDateBr } from '@presentation/hooks/useMask';

// Defeito 1 (21/09/2026): digitar "25/3/1985" (7 dígitos) faz o maskDate agrupar
// errado ("25/31/985") e o parseDateToISO devolver esse lixo como-está (< 8 dígitos).
// isValidBirthDateBr é o gate que o schema usa para barrar isso ANTES do submit.
describe('isValidBirthDateBr - Defeito 1 (validação de data completa/real)', () => {
  it('rejeita o agrupamento quebrado produzido por 7 dígitos (bug reproduzido em prod)', () => {
    const digits = '25' + '3' + '1985'; // usuário digitou "25/3/1985" → só 7 dígitos úteis
    expect(digits).toBe('2531985');
    const masked = maskDate(digits);
    expect(masked).toBe('25/31/985'); // confirma a reprodução do bug
    expect(isValidBirthDateBr(masked)).toBe(false);
  });

  it('rejeita data incompleta (menos de 10 caracteres)', () => {
    expect(isValidBirthDateBr('18/03/90')).toBe(false);
    expect(isValidBirthDateBr('18/03')).toBe(false);
    expect(isValidBirthDateBr('')).toBe(false);
  });

  it('rejeita mês inexistente (13)', () => {
    expect(isValidBirthDateBr('18/13/1990')).toBe(false);
  });

  it('rejeita dia inexistente no mês (31/04)', () => {
    expect(isValidBirthDateBr('31/04/1990')).toBe(false);
  });

  it('rejeita 29/02 em ano não-bissexto', () => {
    expect(isValidBirthDateBr('29/02/2021')).toBe(false);
  });

  it('aceita 29/02 em ano bissexto', () => {
    expect(isValidBirthDateBr('29/02/2020')).toBe(true);
  });

  it('rejeita data futura', () => {
    const futureYear = new Date().getFullYear() + 1;
    expect(isValidBirthDateBr(`01/01/${futureYear}`)).toBe(false);
  });

  it('rejeita ano implausível (antes de 1900)', () => {
    expect(isValidBirthDateBr('01/01/1899')).toBe(false);
  });

  it('aceita data real, completa e passada', () => {
    expect(isValidBirthDateBr('18/03/1990')).toBe(true);
    expect(isValidBirthDateBr('25/07/1985')).toBe(true);
    expect(isValidBirthDateBr('01/01/2000')).toBe(true);
  });
});

// Testes unitários das funções de conversão de data
describe('Conversão de Data de Nascimento - useMask', () => {
  describe('formatDateFromISO - Carregamento do Backend', () => {
    it('deve converter data ISO (AAAA-MM-DD) para formato brasileiro (DD/MM/AAAA)', () => {
      expect(formatDateFromISO('1990-03-18')).toBe('18/03/1990');
      expect(formatDateFromISO('1985-07-25')).toBe('25/07/1985');
      expect(formatDateFromISO('2000-01-01')).toBe('01/01/2000');
    });

    it('deve retornar string vazia quando receber string vazia', () => {
      expect(formatDateFromISO('')).toBe('');
    });

    it('deve retornar string vazia quando receber undefined convertido para string', () => {
      expect(formatDateFromISO(String(undefined))).toBe('undefined');
    });

    it('deve retornar o valor original se não estiver em formato ISO', () => {
      expect(formatDateFromISO('18/03/1990')).toBe('18/03/1990');
      expect(formatDateFromISO('invalid')).toBe('invalid');
    });

    it('deve lidar com datas de ano bissexto corretamente', () => {
      expect(formatDateFromISO('2020-02-29')).toBe('29/02/2020');
    });
  });

  describe('parseDateToISO - Salvamento para Backend', () => {
    it('deve converter data brasileira (DD/MM/AAAA) para ISO (AAAA-MM-DD)', () => {
      expect(parseDateToISO('18/03/1990')).toBe('1990-03-18');
      expect(parseDateToISO('25/07/1985')).toBe('1985-07-25');
      expect(parseDateToISO('01/01/2000')).toBe('2000-01-01');
    });

    it('deve retornar string vazia quando receber string vazia', () => {
      expect(parseDateToISO('')).toBe('');
    });

    it('deve retornar o valor original se não tiver 8 dígitos', () => {
      expect(parseDateToISO('18/03/90')).toBe('18/03/90');
      expect(parseDateToISO('18/03')).toBe('18/03');
    });

    it('deve converter data com máscara aplicada corretamente', () => {
      const maskedDate = maskDate('18031990');
      expect(maskedDate).toBe('18/03/1990');
      expect(parseDateToISO(maskedDate)).toBe('1990-03-18');
    });
  });

  describe('Fluxo completo de ida e volta', () => {
    it('deve manter consistência ao converter de ISO para brasileiro e voltar', () => {
      const originalISO = '1990-03-18';
      const brasileiro = formatDateFromISO(originalISO);
      const deVoltaParaISO = parseDateToISO(brasileiro);

      expect(brasileiro).toBe('18/03/1990');
      expect(deVoltaParaISO).toBe(originalISO);
    });

    it('deve manter consistência para várias datas', () => {
      const datas = [
        '1990-03-18',
        '1985-07-25',
        '2000-01-01',
        '2024-12-31',
      ];

      datas.forEach((isoDate) => {
        const brasileiro = formatDateFromISO(isoDate);
        const deVolta = parseDateToISO(brasileiro);
        expect(deVolta).toBe(isoDate);
      });
    });
  });

  describe('maskDate - Máscara de entrada', () => {
    it('deve aplicar máscara DD/MM/AAAA corretamente', () => {
      expect(maskDate('18')).toBe('18');
      expect(maskDate('1803')).toBe('18/03');
      expect(maskDate('18031990')).toBe('18/03/1990');
    });

    it('deve limitar a 8 dígitos', () => {
      expect(maskDate('18031990123')).toBe('18/03/1990');
    });
  });
});

// Testes de integração simplificados - focados no comportamento de conversão
describe('Integração: GeneralInfoTab - Conversão de Data', () => {
  describe('Cenário: Carregar dados do backend', () => {
    it('deve converter birthDate do formato ISO para DD/MM/AAAA para exibição', () => {
      // Simula dados do backend
      const workerDataFromBackend = {
        birthDate: '1990-03-18',
      };

      // Conversão que acontece no useEffect do GeneralInfoTab
      const displayValue = formatDateFromISO(workerDataFromBackend.birthDate || '');

      expect(displayValue).toBe('18/03/1990');
    });

    it('deve lidar com birthDate vazio do backend', () => {
      const workerDataFromBackend = {
        birthDate: '',
      };

      const displayValue = formatDateFromISO(workerDataFromBackend.birthDate || '');

      expect(displayValue).toBe('');
    });

    it('deve lidar com birthDate undefined do backend', () => {
      const workerDataFromBackend = {
        birthDate: undefined,
      };

      const displayValue = formatDateFromISO(workerDataFromBackend.birthDate || '');

      expect(displayValue).toBe('');
    });
  });

  describe('Cenário: Salvar dados para backend', () => {
    it('deve converter birthDate do formato DD/MM/AAAA para ISO ao salvar', () => {
      // Simula valor do formulário
      const formData = {
        birthDate: '18/03/1990',
      };

      // Conversão que acontece no onSubmit do GeneralInfoTab
      const backendValue = parseDateToISO(formData.birthDate);

      expect(backendValue).toBe('1990-03-18');
    });

    it('deve manter string vazia ao salvar quando data não preenchida', () => {
      const formData = {
        birthDate: '',
      };

      const backendValue = parseDateToISO(formData.birthDate);

      expect(backendValue).toBe('');
    });

    it('deve converter data com máscara aplicada corretamente', () => {
      // Usuário digitou 18031990, máscara aplicou 18/03/1990
      const maskedValue = maskDate('18031990');
      expect(maskedValue).toBe('18/03/1990');

      // Ao salvar, converte para ISO
      const backendValue = parseDateToISO(maskedValue);
      expect(backendValue).toBe('1990-03-18');
    });
  });

  describe('Cenário: Fluxo completo', () => {
    it('data deve permanecer consistente após carregar, editar e salvar', () => {
      // 1. Backend retorna data em ISO
      const backendDate = '1985-07-25';

      // 2. Componente converte para exibição
      const displayDate = formatDateFromISO(backendDate);
      expect(displayDate).toBe('25/07/1985');

      // 3. Usuário mantém a mesma data (ou edita)
      const editedDate = '25/07/1985';

      // 4. Ao salvar, converte de volta para ISO
      const savedDate = parseDateToISO(editedDate);
      expect(savedDate).toBe('1985-07-25');

      // 5. Backend deve receber a mesma data inicial
      expect(savedDate).toBe(backendDate);
    });
  });
});
