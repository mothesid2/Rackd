/*
 * Shared desktop build runner for the Rackd fleet.
 *
 *   node scripts/build-desktop.js <appDir> <prod|demo>
 *
 * Builds an installable Electron app from <appDir> using its package.json `build`
 * config. For the DEMO variant it derives a side-by-side installer — distinct
 * appId, productName, shortcut, and artifact name — and injects
 * extraMetadata.rackdDemo=true so the app watermarks itself "DEMO" and keeps its
 * own isolated local data (Electron derives userData from productName). Cloud
 * isolation (sandbox project) is opt-in later via SANDBOX_SUPABASE_URL.
 *
 * A single electron-builder (this repo root's) builds every app via projectDir.
 */
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'; // unsigned local builds

const path = require('path');
const builder = require('electron-builder');

// Keep the three renderers' shared-ui-kit.{css,js} copies current before
// packaging any of them — this is the one choke point every build path
// (per-app desktop:prod/demo, build-fleet.js, release-all.js) actually runs
// through, so it's the safest place to guarantee the sync happened rather
// than trusting every caller to have run it themselves.
require(path.join(__dirname, 'sync-shared-ui.js'));

const appDir = process.argv[2] || '.';
const variant = process.argv[3] === 'demo' ? 'demo' : 'prod';
const projectDir = path.resolve(appDir);
const pkg = require(path.join(projectDir, 'package.json'));
const base = pkg.build || {};

const slug = String(base.productName || pkg.name).replace(/[^A-Za-z0-9]+/g, '-');

const config =
  variant === 'demo'
    ? {
        ...base,
        appId: `${base.appId || pkg.name}.demo`,
        productName: `${base.productName || pkg.name} (Demo)`,
        extraMetadata: { ...(base.extraMetadata || {}), rackdDemo: true },
        nsis: {
          ...(base.nsis || {}),
          shortcutName: `${(base.nsis && base.nsis.shortcutName) || base.productName || pkg.name} (Demo)`,
          artifactName: `${slug}-Demo-Setup-\${version}.\${ext}`,
        },
        // Never publish a demo build to a production auto-update channel.
        publish: null,
      }
    : base;

console.log(`Building ${config.productName} [${variant}] from ${projectDir} …`);
builder
  .build({ projectDir, config })
  .then((files) => console.log(`✓ ${config.productName}: ${files.join(', ')}`))
  .catch((err) => { console.error(err); process.exit(1); });
