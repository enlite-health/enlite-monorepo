/**
 * BillingAddressField — spec 044 (D475), A3 + a escolha obrigatória da lista do Google.
 * Endereços de ficção. O hook do Places é substituído por um espião que guarda as opções, para o teste
 * encenar o gesto real (escolher uma linha da lista) sem carregar o Maps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientAddressDetail } from '@domain/entities/PatientDetail';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

let placesOptions: { onPlaceApplied: (p: unknown) => void; guessFirstPredictionOnEnter?: boolean } | null = null;
const placesCalls = vi.fn();
vi.mock('@presentation/hooks/useGooglePlacesAutocomplete', () => ({
  useGooglePlacesAutocomplete: (opts: typeof placesOptions) => { placesOptions = opts; placesCalls(opts); return { apiError: null }; },
}));

import { BillingAddressField, type BillingAddressValue } from '../BillingAddressField';

const base = (over: Partial<PatientAddressDetail>): PatientAddressDetail => ({
  id: 'a', addressType: null, addressTypeOther: null, addressFormatted: null, addressRaw: null, complement: null,
  displayOrder: 1, lat: null, lng: null, isPrimary: false, neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'AR',
  city: null, state: null, ...over,
});
const PRIMEIRO = base({ id: 'a1', displayOrder: 1, addressFormatted: 'Calle Primera 1, Ciudad Primera', city: 'Ciudad Primera', state: 'Provincia Primera' });
const PRINCIPAL = base({ id: 'a2', displayOrder: 2, isPrimary: true, addressFormatted: 'Calle Principal 2, Ciudad Principal', city: 'Ciudad Principal', state: 'Provincia Principal' });
const VAZIO: BillingAddressValue = { formatted: '', city: null, province: null };

/** O pai de verdade guarda o estado; aqui um harness mínimo que expõe o último `picked`. */
let lastPicked: boolean | null = null;
function Harness({ addresses, initial = VAZIO, notPicked = false }: { addresses: PatientAddressDetail[] | null; initial?: BillingAddressValue; notPicked?: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <BillingAddressField value={v} addresses={addresses} notPicked={notPicked} onChange={(n, p) => { setV(n); lastPicked = p; }} />
      <output data-testid="city">{v.city ?? 'null'}</output>
      <output data-testid="province">{v.province ?? 'null'}</output>
    </>
  );
}
const input = () => screen.getByTestId('pge-billing') as HTMLInputElement;
const copyBtn = () => screen.getByTestId('pge-billing-copy-primary') as HTMLButtonElement;

describe('BillingAddressField (spec 044)', () => {
  beforeEach(() => { placesOptions = null; lastPicked = null; placesCalls.mockClear(); });

  it('A3: copia o PRINCIPAL (não addresses[0]) para os 3 valores: texto, cidade e província', () => {
    render(<Harness addresses={[PRIMEIRO, PRINCIPAL]} />);
    fireEvent.click(copyBtn());
    expect(input().value).toBe('Calle Principal 2, Ciudad Principal');
    expect(screen.getByTestId('city')).toHaveTextContent('Ciudad Principal');
    expect(screen.getByTestId('province')).toHaveTextContent('Provincia Principal');
    expect(lastPicked).toBe(true); // a cópia vale como escolha: salva sem passar pelo Google
  });

  it('A3: copia addressRaw quando o Principal não tem texto formatado; cidade/província ausentes viram null', () => {
    render(<Harness addresses={[base({ id: 'x', isPrimary: true, addressFormatted: null, addressRaw: 'calle cruda 9' })]} />);
    fireEvent.click(copyBtn());
    expect(input().value).toBe('calle cruda 9');
    expect(screen.getByTestId('city')).toHaveTextContent('null');
    expect(screen.getByTestId('province')).toHaveTextContent('null');
  });

  it('A3: sem Principal o botão fica desabilitado, com o motivo no title; clicar não muda nada', () => {
    render(<Harness addresses={[PRIMEIRO]} />);
    expect(copyBtn()).toBeDisabled();
    expect(copyBtn()).toHaveAttribute('title', 'O paciente não tem endereço principal');
    fireEvent.click(copyBtn());
    expect(input().value).toBe('');
  });

  it('A3: lista de endereços redigida (null) também desabilita', () => {
    render(<Harness addresses={null} />);
    expect(copyBtn()).toBeDisabled();
  });

  it('Principal sem texto algum: desabilitado com motivo próprio (não finge que não há Principal)', () => {
    render(<Harness addresses={[base({ id: 'x', isPrimary: true })]} />);
    expect(copyBtn()).toBeDisabled();
    expect(copyBtn()).toHaveAttribute('title', 'O endereço principal não tem texto para copiar');
  });

  it('A3: snapshot — trocar o Principal nas props DEPOIS do clique não muda o valor copiado', () => {
    const { rerender } = render(<Harness addresses={[PRIMEIRO, PRINCIPAL]} />);
    fireEvent.click(copyBtn());
    rerender(<Harness addresses={[
      { ...PRIMEIRO, isPrimary: true },
      { ...PRINCIPAL, isPrimary: false, addressFormatted: 'Outra Calle 99' },
    ]} />);
    expect(input().value).toBe('Calle Principal 2, Ciudad Principal');
    expect(screen.getByTestId('city')).toHaveTextContent('Ciudad Principal');
  });

  it('A3: copiar não chama o Google — qualquer acesso a window.google durante o clique falharia o teste', () => {
    render(<Harness addresses={[PRINCIPAL]} />);
    const acessos = vi.fn(() => { throw new Error('window.google acessado'); });
    Object.defineProperty(window, 'google', { configurable: true, get: acessos });
    try {
      fireEvent.click(copyBtn());
    } finally {
      delete (window as unknown as { google?: unknown }).google;
    }
    expect(acessos).not.toHaveBeenCalled();
    expect(input().value).toBe('Calle Principal 2, Ciudad Principal');
  });

  it('usa a busca do Places com o chute do Enter DESLIGADO (escolha obrigatória)', () => {
    render(<Harness addresses={[]} />);
    expect(placesOptions?.guessFirstPredictionOnEnter).toBe(false);
  });

  it('escolher na lista preenche texto + cidade (locality) + província (administrative_area_level_1) e conta como escolhido', () => {
    render(<Harness addresses={[]} />);
    act(() => {
      placesOptions!.onPlaceApplied({
        formatted_address: 'Calle Falsa 123, Ciudad Ficticia',
        address_components: [
          { long_name: 'Ciudad Ficticia', short_name: 'CF', types: ['locality'] },
          { long_name: 'Provincia Ficticia', short_name: 'PF', types: ['administrative_area_level_1'] },
        ],
        geometry: { location: { lat: () => 1, lng: () => 2 } },
      });
    });
    expect(input().value).toBe('Calle Falsa 123, Ciudad Ficticia');
    expect(screen.getByTestId('city')).toHaveTextContent('Ciudad Ficticia');
    expect(screen.getByTestId('province')).toHaveTextContent('Provincia Ficticia');
    expect(lastPicked).toBe(true);
  });

  it('escolha sem address_components: cidade e província null (não inventa)', () => {
    render(<Harness addresses={[]} />);
    act(() => { placesOptions!.onPlaceApplied({ formatted_address: 'Calle Falsa 123' }); });
    expect(input().value).toBe('Calle Falsa 123');
    expect(screen.getByTestId('city')).toHaveTextContent('null');
  });

  it('digitar à mão desfaz a escolha (picked=false) e zera cidade/província', () => {
    render(<Harness addresses={[PRINCIPAL]} />);
    fireEvent.click(copyBtn());
    fireEvent.change(input(), { target: { value: 'Calle Digitada 5' } });
    expect(lastPicked).toBe(false);
    expect(screen.getByTestId('city')).toHaveTextContent('null');
    expect(screen.getByTestId('province')).toHaveTextContent('null');
  });

  it('mostra o erro de "elegir de la lista" quando o pai pede (notPicked) e marca aria-invalid; o input é mascarado', () => {
    render(<Harness addresses={[]} notPicked />);
    expect(screen.getByText('Escolha o endereço de faturamento na lista de sugestões')).toBeInTheDocument();
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(input().closest('[data-clarity-mask="True"]')).not.toBeNull();
  });
});
