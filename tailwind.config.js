/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Playfair Display"', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'emerald-pulse': {
          '0%, 100%': {
            boxShadow:
              '0 0 6px rgba(16, 185, 129, 0.6), 0 0 12px rgba(16, 185, 129, 0.4)',
          },
          '50%': {
            boxShadow:
              '0 0 10px rgba(16, 185, 129, 0.95), 0 0 20px rgba(16, 185, 129, 0.7)',
          },
        },
      },
      animation: {
        'emerald-pulse': 'emerald-pulse 2.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
