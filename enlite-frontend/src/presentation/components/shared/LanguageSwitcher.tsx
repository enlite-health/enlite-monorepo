import { useTranslation } from 'react-i18next';

const LANGUAGES = ['es', 'pt-BR'] as const;
type Language = (typeof LANGUAGES)[number];

/**
 * Seletor de idioma da interface (es / pt-BR). Troca na hora e grava a escolha em `localStorage['i18nextLng']`
 * — a chave que `infrastructure/i18n/config.ts` lê no próximo carregamento (o i18next aqui não tem detector).
 * Gravar é best-effort: storage bloqueado/indisponível não pode impedir a troca em memória.
 * Visual do painel: o ativo é o `primary` cheio; o inativo, contorno visível (`border-gray-800`) com texto `primary`.
 */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();

  const changeLanguage = (lng: Language) => {
    void i18n.changeLanguage(lng);
    try {
      window.localStorage.setItem('i18nextLng', lng);
    } catch {
      // localStorage indisponível (modo privado, iframe sandbox): a troca vale só até recarregar.
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('admin.profile.language.title')}>
      {LANGUAGES.map((lng) => {
        const active = i18n.language === lng;
        return (
          <button
            key={lng}
            type="button"
            onClick={() => changeLanguage(lng)}
            aria-pressed={active}
            data-testid={`language-${lng}`}
            className={`px-4 py-2 rounded-lg border-[1.5px] text-sm font-medium transition-colors ${
              active
                ? 'bg-primary border-primary text-white'
                : 'bg-white border-gray-800 text-primary hover:bg-primary/5'
            }`}
          >
            {t(`admin.profile.language.options.${lng}`)}
          </button>
        );
      })}
    </div>
  );
}
