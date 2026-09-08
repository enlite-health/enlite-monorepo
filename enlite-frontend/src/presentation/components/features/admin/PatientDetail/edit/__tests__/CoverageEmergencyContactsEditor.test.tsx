/**
 * CoverageEmergencyContactsEditor — 417 / D301.3b: a lista dos contatos de emergência da cobertura
 * (tipo, nome, telefone), o aviso do dever de informar (lex C10) e a régua de "linha inválida".
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientCoverageEmergencyContactInput } from '@domain/entities/PatientCoverage';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

import { CoverageEmergencyContactsEditor } from '../CoverageEmergencyContactsEditor';
import { invalidCoverageContacts, contactFieldErrors } from '../coverageContactValidation';

const te = (k: string): string => t(`admin.patients.editDrawer.${k}`);
const tc = (k: string): string => t(`admin.patients.detail.coverageCard.${k}`);

function montar(value: PatientCoverageEmergencyContactInput[], disabled = false, allowDirectProfessional = true) {
  const onChange = vi.fn();
  render(<CoverageEmergencyContactsEditor value={value} onChange={onChange} disabled={disabled} allowDirectProfessional={allowDirectProfessional} />);
  return onChange;
}

describe('CoverageEmergencyContactsEditor', () => {
  it('vazio: rótulo, aviso do dever de informar (lex C10) e "sem contatos"; "Agregar" cria uma linha AMBULANCE vazia', () => {
    const onChange = montar([]);
    expect(screen.getByText(tc('emergencyContacts'))).toBeInTheDocument();
    expect(screen.getByTestId('pcv-contacts-notice')).toHaveTextContent(te('coverageContactNotice'));
    expect(screen.getByTestId('pcv-contacts-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pcv-contact-add'));
    expect(onChange).toHaveBeenCalledWith([{ kind: 'AMBULANCE', name: '', phone: '' }]);
  });

  it('linha: os 3 tipos traduzidos no select; editar tipo/nome/telefone devolve a lista inteira com SÓ aquela linha mudada; remover tira a linha', () => {
    const lista: PatientCoverageEmergencyContactInput[] = [
      { kind: 'AMBULANCE', name: 'Ambulancia', phone: '0800' },
      { kind: 'EMERGENCY_CENTER', name: 'Central', phone: '107' },
    ];
    const onChange = montar(lista);
    expect(screen.queryByTestId('pcv-contacts-empty')).toBeNull();
    const select = screen.getByTestId('pcv-contact-kind-0') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      tc('emergencyContactKinds.DIRECT_PROFESSIONAL'), tc('emergencyContactKinds.AMBULANCE'), tc('emergencyContactKinds.EMERGENCY_CENTER'),
    ]);
    fireEvent.change(select, { target: { value: 'DIRECT_PROFESSIONAL' } });
    expect(onChange).toHaveBeenLastCalledWith([{ kind: 'DIRECT_PROFESSIONAL', name: 'Ambulancia', phone: '0800' }, lista[1]]);
    fireEvent.change(screen.getByTestId('pcv-contact-name-1'), { target: { value: 'Central X' } });
    expect(onChange).toHaveBeenLastCalledWith([lista[0], { kind: 'EMERGENCY_CENTER', name: 'Central X', phone: '107' }]);
    fireEvent.change(screen.getByTestId('pcv-contact-phone-1'), { target: { value: '911' } });
    expect(onChange).toHaveBeenLastCalledWith([lista[0], { kind: 'EMERGENCY_CENTER', name: 'Central', phone: '911' }]);
    fireEvent.click(screen.getByTestId('pcv-contact-remove-0'));
    expect(onChange).toHaveBeenLastCalledWith([lista[1]]);
    // lex C2.1: a LINHA inteira (nome de profissional é texto) carrega a máscara do Clarity.
    expect(screen.getByTestId('pcv-contact-0').getAttribute('data-clarity-mask')).toBe('True');
  });

  it('linha inválida marca `aria-invalid` no campo certo; `disabled` trava tudo; teto de 20 trava o "Agregar"', () => {
    montar([{ kind: 'AMBULANCE', name: '', phone: 'x'.repeat(41) }]);
    expect(screen.getByTestId('pcv-contact-name-0').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('pcv-contact-phone-0').getAttribute('aria-invalid')).toBe('true');
    const cheia = Array.from({ length: 20 }, (_, i) => ({ kind: 'AMBULANCE' as const, name: `A${i}`, phone: '1' }));
    const onChange = vi.fn();
    render(<CoverageEmergencyContactsEditor value={cheia} onChange={onChange} disabled />);
    const adds = screen.getAllByTestId('pcv-contact-add');
    expect((adds[adds.length - 1] as HTMLButtonElement).disabled).toBe(true);
    const removes = screen.getAllByTestId('pcv-contact-remove-0');
    expect((removes[removes.length - 1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('lex C3 (LISTA A2): sem `allowDirectProfessional` (o DEFAULT esconde) o select NÃO oferece "Profissional direto" — o servidor recusaria com 403', () => {
    const onChange = vi.fn();
    render(<CoverageEmergencyContactsEditor value={[{ kind: 'AMBULANCE', name: 'A', phone: '1' }]} onChange={onChange} />);
    const select = screen.getByTestId('pcv-contact-kind-0') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['AMBULANCE', 'EMERGENCY_CENTER']);
  });

  it('invalidCoverageContacts: vazio é válido; nome/telefone em branco ou acima do teto invalidam; espaços contam como branco', () => {
    expect(invalidCoverageContacts([])).toBe(false);
    expect(invalidCoverageContacts([{ kind: 'AMBULANCE', name: 'A', phone: '1' }])).toBe(false);
    expect(invalidCoverageContacts([{ kind: 'AMBULANCE', name: '  ', phone: '1' }])).toBe(true);
    expect(invalidCoverageContacts([{ kind: 'AMBULANCE', name: 'A', phone: '  ' }])).toBe(true);
    expect(invalidCoverageContacts([{ kind: 'AMBULANCE', name: 'a'.repeat(201), phone: '1' }])).toBe(true);
    expect(invalidCoverageContacts([{ kind: 'AMBULANCE', name: 'A', phone: '1'.repeat(41) }])).toBe(true);
    // O predicado por campo é o MESMO que alimenta o aria-invalid da linha.
    expect(contactFieldErrors({ kind: 'AMBULANCE', name: '', phone: '1' })).toEqual({ name: true, phone: false });
    expect(contactFieldErrors({ kind: 'AMBULANCE', name: 'A', phone: ' ' })).toEqual({ name: false, phone: true });
  });
});
