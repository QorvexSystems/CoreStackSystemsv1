import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        serif: ['var(--font-serif)', 'Georgia', 'serif'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: '#1B2A2F',
        muted: '#5E6B6E',
        sand: { DEFAULT: '#F7F4EE', deep: '#EFE9DF' },
        line: '#E4DFD5',
        sea: { light: '#E3F2EF', DEFAULT: '#137E74', dark: '#0E625A', deep: '#0A4A44' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(27,42,47,.04), 0 8px 24px -12px rgba(27,42,47,.12)',
      },
    },
  },
  plugins: [],
};

export default config;
