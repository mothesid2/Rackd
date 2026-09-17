import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Rackd brand v2 — dark rebuild (red / black / grey). Token NAMES kept
        // stable across the flip so every existing className still points at
        // the right role; only the values moved from warm-paper-light to true
        // dark. `ink` is a role ("primary text"), not a literal color, so it
        // flipping from near-black to near-white on a dark ground is correct,
        // not a hack.
        ink: '#f1efec',     // primary text — light, on the dark ground below
        char: '#0c0d0f',    // true-black body ground
        // paper: was the light cream page background pre-rebuild; now a
        // raised dark surface (cards, the header/footer band) one step
        // lighter than `char` so content reads as sitting ON the page.
        paper: '#17181b',
        steel: '#232529',   // one step lighter still — hover states, inputs
        line: 'rgba(241,239,236,0.10)', // hairline borders/dividers on dark
        accent: '#b01d2e',  // Rackd red — unchanged, now the hot spot on black
        ember: '#e0293d',   // brighter red (hover / emphasis) — bumped up for dark-ground contrast
        // smoke: secondary/muted text — was tuned for a light background;
        // re-tuned lighter for AA contrast against the new dark ground
        // (5.9:1 against #0c0d0f, 4.7:1 against #17181b).
        smoke: '#9a9da3',
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
