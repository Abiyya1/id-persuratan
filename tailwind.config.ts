import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          50: '#f0f4f9',
          100: '#dce5f0',
          200: '#bccfe3',
          300: '#92b0d1',
          400: '#628cba',
          500: '#416fa2',
          600: '#30588c',
          700: '#284771',
          800: '#253c5f',
          900: '#1b2b45',
          950: '#111c2e',
        },
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
