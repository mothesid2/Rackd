// Same brand tokens as storefront/tailwind.config.ts. Scoped under .rsm-root with no preflight so the module
// never restyles the Electron host apps (Manager Portal / Owner Console) it is mounted inside.
module.exports = {
  important: '.rsm-root',
  corePlugins: { preflight: false },
  content: ['./src/**/*.{ts,tsx}', '../../manage/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#f1efec', char: '#0c0d0f', paper: '#17181b', steel: '#232529',
        line: 'rgba(241,239,236,0.10)', accent: '#b01d2e', ember: '#e0293d', smoke: '#9a9da3',
      },
      fontFamily: { display: ['Archivo', 'system-ui', 'sans-serif'], sans: ['Instrument Sans', 'system-ui', 'sans-serif'] },
    },
  },
};
