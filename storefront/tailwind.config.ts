import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Rackd brand — charcoal ink + the signature red, on a warm paper ground.
        ink: '#17191d',
        char: '#101216',   // deeper charcoal (header / footer)
        paper: '#f5f2ed',  // warm off-white ground (chosen, slight warm bias)
        accent: '#b01d2e', // Rackd red
        ember: '#cf2436',  // brighter red (hover / emphasis)
        smoke: '#6b7078',  // warm-neutral muted
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        tag: '0 1px 0 rgba(23,25,29,0.04), 0 6px 20px -8px rgba(23,25,29,0.18)',
      },
    },
  },
  plugins: [],
};
export default config;
