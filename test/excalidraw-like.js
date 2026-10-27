'use strict';

// A project shaped like excalidraw/excalidraw, by paths only: 788 source files in workspace
// packages (packages/common, element, excalidraw, math, and utils, excalidraw-app, and two
// examples), each with a simple package.json, plus dev-docs/ and scripts/. packages/excalidraw
// has components, actions, renderer, data, fonts, scene, hooks, and tests folders. Every file
// has a one-sentence leading comment and imports the next file in its folder.

const FOLDERS = [
  // [folder, count, extension, test]
  ['packages/common/src', 22, 'ts'],
  ['packages/common/src', 4, 'ts', true],
  ['packages/element/src', 80, 'ts'],
  ['packages/element/tests', 18, 'tsx', true],
  ['packages/math/src', 20, 'ts'],
  ['packages/math/tests', 6, 'ts', true],
  ['packages/utils/src', 14, 'ts'],
  ['packages/utils/tests', 4, 'ts', true],
  ['packages/excalidraw', 30, 'tsx'],
  ['packages/excalidraw/components', 180, 'tsx'],
  ['packages/excalidraw/components/dropdownMenu', 12, 'tsx'],
  ['packages/excalidraw/components/TTDDialog', 14, 'tsx'],
  ['packages/excalidraw/components/icons', 34, 'tsx'],
  ['packages/excalidraw/actions', 48, 'tsx'],
  ['packages/excalidraw/renderer', 12, 'ts'],
  ['packages/excalidraw/data', 26, 'ts'],
  ['packages/excalidraw/fonts', 10, 'ts'],
  ['packages/excalidraw/fonts/Virgil', 6, 'ts'],
  ['packages/excalidraw/fonts/Excalifont', 6, 'ts'],
  ['packages/excalidraw/scene', 16, 'ts'],
  ['packages/excalidraw/hooks', 6, 'ts'],
  ['packages/excalidraw/tests', 90, 'tsx', true],
  ['excalidraw-app', 12, 'tsx'],
  ['excalidraw-app/components', 20, 'tsx'],
  ['excalidraw-app/collab', 10, 'tsx'],
  ['excalidraw-app/data', 12, 'ts'],
  ['excalidraw-app/share', 6, 'tsx'],
  ['excalidraw-app/tests', 8, 'tsx', true],
  ['examples/with-nextjs/src', 10, 'tsx'],
  ['examples/with-script-in-browser', 8, 'tsx'],
  ['dev-docs/src/components', 6, 'tsx'],
  ['dev-docs/src/theme', 8, 'tsx'],
  ['scripts', 22, 'js'],
];

const PACKAGES = {
  'packages/common': '@excalidraw/common',
  'packages/element': '@excalidraw/element',
  'packages/excalidraw': '@excalidraw/excalidraw',
  'packages/math': '@excalidraw/math',
  'packages/utils': '@excalidraw/utils',
  'excalidraw-app': 'excalidraw-app',
  'examples/with-nextjs': 'with-nextjs',
  'examples/with-script-in-browser': 'with-script-in-browser',
  'dev-docs': 'docs',
};

function excalidrawLike() {
  const files = {
    'package.json': `${JSON.stringify({ name: 'excalidraw-monorepo', private: true, workspaces: ['excalidraw-app', 'packages/*', 'examples/*'], scripts: { start: 'yarn --cwd ./excalidraw-app start', test: 'vitest' } }, null, 2)}\n`,
    'yarn.lock': '# yarn lockfile v1\n',
    'vitest.config.mts': "// Configures the test runner for every package.\nexport default { test: { environment: 'jsdom' } };\n",
    'setupTests.ts': '// Sets up the browser globals the tests need.\nexport const ready = true;\n',
    'dev-docs/docusaurus.config.js': '// Configures the developer documentation site.\nmodule.exports = { title: "Excalidraw developers" };\n',
    'dev-docs/sidebars.js': '// Lists the pages of the developer documentation sidebar.\nmodule.exports = { docs: [] };\n',
  };
  for (const [dir, name] of Object.entries(PACKAGES)) files[`${dir}/package.json`] = `${JSON.stringify({ name, version: '0.1.0', private: true }, null, 2)}\n`;
  // Root files beyond the two above, for 6 in all.
  for (const name of ['vite.config.mts', 'playwright.config.ts', 'eslint.config.mjs', 'prettier.config.mjs']) {
    files[name] = `// Holds the shared ${name.split('.')[0].replace(/-/g, ' ')} settings for the workspace.\nexport const settings = {};\n`;
  }
  for (const [dir, count, ext, test] of FOLDERS) {
    const area = dir.split('/').filter((s) => !['packages', 'src'].includes(s)).join(' ');
    for (let i = 0; i < count; i++) {
      const stem = `${dir.split('/').pop().replace(/\W/g, '')}${String(i).padStart(2, '0')}`;
      const next = `${dir.split('/').pop().replace(/\W/g, '')}${String((i + 1) % count).padStart(2, '0')}`;
      const suffix = test ? '.test' : '';
      files[`${dir}/${stem}${suffix}.${ext}`] = test
        ? `// Checks the ${area} behavior of ${stem}.\nimport { value } from './${next}${suffix}';\n\nexport function check${i}(): boolean {\n  return value >= 0;\n}\n\nexport const value = ${i};\n`
        : `// Handles the ${area} ${stem} step for the editor.\nimport { value as other } from './${next}';\n\nexport function run${i}(input: number): number {\n  return input + other;\n}\n\nexport const value = ${i};\n`;
    }
  }
  return files;
}

// The number of source files in the project.
const SOURCE_FILES = 788;

module.exports = { PACKAGES, SOURCE_FILES, excalidrawLike };
