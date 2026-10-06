module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
    //'@typescript-eslint/no-explicit-any': 'off',
    //'max-lines': 'off',
    ///'@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    'max-lines': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
    // Data/hora na tela passa por `presentation/utils/dateTimeFormat.ts` (fuso -03 e 24h). Formatar
    // direto cai no fuso do NAVEGADOR e, em es-AR, em 12h ("7:00 p. m."). `toLocaleString` genérico
    // NÃO é proibido (formata número); quem o usa para data também migra, mas a regra não o pega.
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.property.name='toLocaleDateString']",
        message: 'Use formatInstant / formatCalendarDate de @presentation/utils/dateTimeFormat (fuso -03, 24h).',
      },
      {
        selector: "CallExpression[callee.property.name='toLocaleTimeString']",
        message: 'Use formatInstant / formatClockTime de @presentation/utils/dateTimeFormat (fuso -03, 24h).',
      },
      {
        selector: "NewExpression[callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
        message: 'Use formatInstant / formatCalendarDate de @presentation/utils/dateTimeFormat (fuso -03, 24h).',
      },
      {
        selector: "CallExpression[callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
        message: 'Use formatInstant / formatCalendarDate de @presentation/utils/dateTimeFormat (fuso -03, 24h).',
      },
    ],
  },
  overrides: [
    {
      // O módulo central e as EXCEÇÕES declaradas (cada uma tem o motivo no próprio arquivo):
      // AnaCareHours = fuso -06 da fonte Ana Care + formatadores Date.UTC de só-data;
      // AdmisionPage = fuso POR PAÍS (COUNTRY_TZ), não o do operador.
      files: [
        'src/presentation/utils/dateTimeFormat.ts',
        'src/presentation/components/features/admin/AnaCareHours/selectors.ts',
        'src/presentation/components/features/admin/AnaCareHours/AnaCareHoursWeekNavigator.tsx',
        'src/presentation/components/features/admin/AnaCareHours/DayGroup.tsx',
        'src/presentation/pages/public/AdmisionPage.tsx',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
    {
      // Testes montam a régua de referência com Intl direto, de propósito.
      files: ['**/*.test.ts', '**/*.test.tsx', 'e2e/**'],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};
