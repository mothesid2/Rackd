import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Rackd brand — charcoal ink + the signature red, on a warm paper ground.
        ink: '#17191d',
        char: '#101216',   // deeper charcoal (header / footer)
        // paper: softened from #f5f2ed (L95, ~14% brighter) after user feedback
        // that the near-white ground was hard on the eyes — same warm hue/sat
        // family, just less glare. Kept in sync with the raw hex in globals.css
        // body background, which is what's actually rendered (this token itself
        // isn't referenced via bg-paper anywhere yet).
        paper: '#e9e2d8',
        accent: '#b01d2e', // Rackd red
        ember: '#cf2436',  // brighter red (hover / emphasis)
        // smoke: darkened from #6b7078 (4.46:1, just under WCAG AA's 4.5:1 floor
        // against the old paper bg) to #5f646c — 5.33:1 against the old bg,
        // 4.63:1 against the new darker paper bg above, comfortable margin either way.
        smoke: '#5f646c',
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
