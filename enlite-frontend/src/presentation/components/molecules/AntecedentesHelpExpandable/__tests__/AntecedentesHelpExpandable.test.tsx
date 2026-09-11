/**
 * AntecedentesHelpExpandable.test.tsx
 *
 * Fase 3 de postulacao-documento-pendente (DD4/F12): expansível "¿No lo
 * tenés? Cómo sacarlo" pro documento de antecedentes penais — um
 * componente, dois usos (item da lista `PendingTasksCard` e slot
 * `criminal_record` da aba Documentos `DocumentsGrid`). i18n REAL (es +
 * pt-BR) porque o que importa é o TEXTO (mesmo padrão de
 * `sex-both-i18n.test.tsx`).
 *
 * C9 do lex (`fatos-medidos.md` F15): link com URL CONSTANTE sem query
 * string, `target="_blank"` e `rel="noopener noreferrer"` — teste confere
 * `href`/`target`/`rel` exatos, nunca navega de verdade.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

import { AntecedentesHelpExpandable, ANTECEDENTES_HELP_URL } from '..';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: {
      es: { translation: esJson },
      'pt-BR': { translation: ptBRJson },
    },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

beforeEach(() => {
  i18n.changeLanguage('es');
});

/**
 * `userEvent.setup()` já wrappa o click em `act()` internamente, mas o
 * `beforeAll` acima reinicializa o singleton `i18next` (a mesma instância
 * que `src/test/setup.ts` já inicializou) — a promise dessa reinicialização
 * some solta e o update que ela dispara no próximo render some da wrap do
 * `act()` do userEvent, que só cobre o PRÓPRIO click. `act()` explícito
 * aqui garante que a asserção só roda depois de QUALQUER efeito pendente
 * assentar — sem isso, "not wrapped in act(...)" (achado do gate 11/09).
 */
async function clickToggle(user: ReturnType<typeof userEvent.setup>, toggle: HTMLElement): Promise<void> {
  await act(async () => {
    await user.click(toggle);
  });
}

describe('AntecedentesHelpExpandable', () => {
  it('fechado por padrão — nem o texto nem o link aparecem', () => {
    render(<AntecedentesHelpExpandable />);
    expect(screen.getByText('¿No lo tenés? Cómo sacarlo')).toBeInTheDocument();
    expect(screen.queryByTestId('antecedentes-help-body')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('clicar no toggle abre o texto e o link "Cómo sacarlo"', async () => {
    const user = userEvent.setup();
    render(<AntecedentesHelpExpandable />);

    await clickToggle(user, screen.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i }));

    expect(
      screen.getByText(
        'Se tramita online con Clave Fiscal o Mi Argentina y te llega por e-mail. Podés elegir recibirlo en 5 días hábiles o en 24 horas.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cómo sacarlo' })).toBeInTheDocument();
  });

  it('clicar de novo fecha o texto e o link', async () => {
    const user = userEvent.setup();
    render(<AntecedentesHelpExpandable />);
    const toggle = screen.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i });

    await clickToggle(user, toggle);
    expect(screen.getByTestId('antecedentes-help-body')).toBeInTheDocument();

    await clickToggle(user, toggle);
    expect(screen.queryByTestId('antecedentes-help-body')).not.toBeInTheDocument();
  });

  it('C9 do lex: link com href EXATO (sem query string), target="_blank" e rel="noopener noreferrer"', async () => {
    const user = userEvent.setup();
    render(<AntecedentesHelpExpandable />);
    await clickToggle(user, screen.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i }));

    const link = screen.getByRole('link', { name: 'Cómo sacarlo' });
    expect(link).toHaveAttribute('href', ANTECEDENTES_HELP_URL);
    expect(ANTECEDENTES_HELP_URL).toBe('https://www.argentina.gob.ar/justicia/reincidencia/antecedentespenales');
    expect(ANTECEDENTES_HELP_URL).not.toContain('?');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('aria-expanded reflete o estado aberto/fechado', async () => {
    const user = userEvent.setup();
    render(<AntecedentesHelpExpandable />);
    const toggle = screen.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await clickToggle(user, toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('pt-BR: toggle "Não tem? Como conseguir" e link "Como conseguir"', async () => {
    i18n.changeLanguage('pt-BR');
    const user = userEvent.setup();
    render(<AntecedentesHelpExpandable />);

    await clickToggle(user, screen.getByRole('button', { name: /Não tem\? Como conseguir/i }));
    expect(
      screen.getByText(
        'O trâmite é feito online com Clave Fiscal ou Mi Argentina e chega por e-mail. Você pode escolher recebê-lo em 5 dias úteis ou em 24 horas.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Como conseguir' })).toBeInTheDocument();
  });

  it('aceita className extra no container', () => {
    render(<AntecedentesHelpExpandable className="mt-2" />);
    expect(screen.getByTestId('antecedentes-help')).toHaveClass('mt-2');
  });
});
