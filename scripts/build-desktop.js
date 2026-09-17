
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'; 

const path = require('path');
const builder = require('electron-builder');


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
        
        publish: null,
      }
    : base;

console.log(`Building ${config.productName} [${variant}] from ${projectDir} …`);
builder
  .build({ projectDir, config })
  .then((files) => console.log(`✓ ${config.productName}: ${files.join(', ')}`))
  .catch((err) => { console.error(err); process.exit(1); });
