import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#05080a',
        panel: '#080d10',
        'panel-2': '#0d1f17',
        border: '#143a25',
        grid: '#0d1f17',
        dim: '#3d6650',
        mid: '#6f9c83',
        fg: '#a7e0c2',
        hi: '#22ff88',
        amber: '#ffb454',
        red: '#ff5c6c',
        cyan: '#5ed3f3',
        magenta: '#d36bff',
        muted: '#3d6650',
        text: '#a7e0c2',
        'text-strong': '#22ff88',
        accent: '#ffb454',
        green: '#22ff88',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
