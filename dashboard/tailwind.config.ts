import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0c10',
        panel: '#161a20',
        'panel-2': '#1f242c',
        border: '#262b33',
        muted: '#7d8593',
        text: '#cdd5e0',
        'text-strong': '#e6e6e6',
        accent: '#ffb84d',
        green: '#5cd97e',
        red: '#ff6b6b',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
