/** @type {import('tailwindcss').Config} */
export default {
  // App light-only: sem `.dark` no DOM, as variantes `dark:` ficam inertes.
  // Evita que o modo escuro do SO (prefers-color-scheme) quebre o layout —
  // o chrome do admin (PageContainer/Heading/Text) não tem tema escuro.
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: '#180149',
        background: '#FFF9FC',
        'gray-100': '#FFF9FC',
        'gray-200': '#F7F7F7',
        'gray-300': '#EEEEEE',
        'gray-400': '#ECEFF1',
        'gray-500': 'rgba(217, 217, 217, 0.5)',
        'gray-600': '#D9D9D9',
        'gray-700': 'rgba(115, 115, 115, 0.5)',
        'gray-800': '#737373',
        care: '#F227AF',
        clinic: '#8932FD',
        learn: '#FFB607',
        'new-car': '#2B51D6',
        'pink-cancel': '#F96B8C',
        'turquoise': '#3EEBD6',
        'blue-yonder': '#5A73A3',
        'coordination': '#FF575C',
        'cyan-focus': '#06ADDD',
        'wait': '#FFC53B',
        'navbar-active': '#F83667',
        'cancelled': '#FE9490',
      },
      fontFamily: {
        poppins: ['Poppins', 'sans-serif'],
        lexend: ['Lexend', 'sans-serif'],
      },
      borderRadius: {
        'pill': '100px',
        'pill-lg': '549.451px',
        'input': '10px',
        'image': '16px',
        'card': '20px',
        'card-lg': '28px',
        'card-xl': '32px',
      },
      spacing: {
        '18': '4.5rem',
        '22': '5.5rem',
      },
      boxShadow: {
        'small': '0px 4px 8px 0px rgba(0, 0, 0, 0.04)',
        'medium': '0px 8px 16px 0px rgba(0, 0, 0, 0.08)',
        'large': '0px 12px 24px 0px rgba(0, 0, 0, 0.12)',
        'extra-large': '0px 16px 32px 0px rgba(0, 0, 0, 0.16)',
        'tab': '0px 4px 10px 0px rgba(0, 0, 0, 0.4)',
        'tab-active': '0px 4px 20px 0px rgba(0, 0, 0, 0.4)',
      },
    },
  },
  plugins: [],
}

