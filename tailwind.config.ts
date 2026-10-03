import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Champagne: the one accent on a neutral graphite UI. Used for
        // selection, focus, progress and the brand mark — sparingly.
        accent: {
          DEFAULT: '#D4B47C',
          50: '#FBF7EF',
          100: '#F5ECDA',
          200: '#EDDDBC',
          300: '#E4CA9A',
          400: '#D4B47C',
          500: '#C09A5E',
          600: '#A3804A',
          700: '#7F633A',
          800: '#58452A',
          900: '#352A1A',
          950: '#1C160D',
        },
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'pulse-dot': 'pulse-dot 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
