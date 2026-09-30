/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // FlowBoard 主题色板
        brand: {
          50: '#eef4ff',
          100: '#dbe6fe',
          200: '#bfd3fe',
          300: '#93b4fd',
          400: '#608afa',
          500: '#3b63f6',
          600: '#2544eb',
          700: '#1d33d8',
          800: '#1e2baf',
          900: '#1e298a',
          950: '#171a54',
        },
        surface: {
          DEFAULT: 'var(--color-surface)',
          muted: 'var(--color-surface-muted)',
          border: 'var(--color-border)',
        },
        ink: {
          DEFAULT: 'var(--color-ink)',
          muted: 'var(--color-ink-muted)',
        },
      },
      spacing: {
        menu: '48px',
        statusbar: '24px',
      },
      borderRadius: {
        panel: '10px',
      },
      boxShadow: {
        panel: '0 1px 3px rgba(16,24,40,0.1), 0 1px 2px rgba(16,24,40,0.06)',
        float: '0 8px 24px rgba(16,24,40,0.16)',
      },
    },
  },
  plugins: [],
}
