'use strict';

// Fifteen TypeScript files shaped like the batch of existing code Docturnal commented in an
// excalidraw fork: packages/element/src/snapping.ts (about 1,400 lines), clipboard.ts, and
// smaller element, scene, and component files. Their code is made up, but their shapes are
// the real ones: exported functions and React components, a JSDoc comment on about one
// function in three, exported constants and interfaces, nested loops over elements and
// points, regular expressions, bitwise colour math, long conditions on element types, and
// small private helpers.

// [path, lines]
const FILES = [
  ['packages/element/src/snapping.ts', 1400],
  ['packages/excalidraw/clipboard.ts', 520],
  ['packages/element/src/binding.ts', 420],
  ['packages/element/src/collision.ts', 360],
  ['packages/excalidraw/scene/Renderer.ts', 300],
  ['packages/element/src/textElement.ts', 280],
  ['packages/excalidraw/components/ColorPicker/colorPickerUtils.ts', 240],
  ['packages/element/src/transformHandles.ts', 220],
  ['packages/excalidraw/scene/scroll.ts', 180],
  ['packages/excalidraw/components/Toolbar.tsx', 170],
  ['packages/element/src/distance.ts', 150],
  ['packages/excalidraw/data/url.ts', 130],
  ['packages/excalidraw/components/HintViewer.tsx', 120],
  ['packages/math/src/segment.ts', 100],
  ['packages/excalidraw/clients.ts', 90],
];

const pascal = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Each template takes a name and returns its lines.
const TEMPLATES = [
  // Nested loops over elements and their points, with a tolerance.
  (n) => [
    `export const getSnapPoints${n} = (elements: readonly ExcalidrawElement[], zoom: number): SnapPoint[] => {`,
    '  const points: SnapPoint[] = [];',
    '  for (const element of elements) {',
    '    if (element.isDeleted) {',
    '      continue;',
    '    }',
    '    for (const corner of getCorners(element)) {',
    '      if (Math.abs(corner.x - element.x) > SNAP_DISTANCE / zoom) {',
    '        points.push({ x: corner.x, y: corner.y, id: element.id });',
    '      }',
    '    }',
    '  }',
    '  return points;',
    '};',
  ],
  // A regular expression and bitwise colour math.
  (n) => [
    `export function getLuminance${n}(color: string): number | null {`,
    '  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());',
    '  if (!match) {',
    '    return null;',
    '  }',
    '  const rgb = parseInt(match[1], 16);',
    '  return ((rgb >> 16) & 0xff) * 0.299 + ((rgb >> 8) & 0xff) * 0.587 + (rgb & 0xff) * 0.114;',
    '}',
  ],
  // A long condition on the element and the app state.
  (n) => [
    `export const isBindable${n} = (element: ExcalidrawElement, appState: AppState): boolean => {`,
    '  if (element.type === "arrow" && !element.isDeleted && appState.selectedElementIds[element.id] && element.points.length > 2) {',
    '    return true;',
    '  }',
    '  return element.type === "rectangle" || element.type === "diamond";',
    '};',
  ],
  // A small private helper.
  (n) => [`const toKey${n} = (id: string, index: number) => \`\${id}:\${index}\`;`],
  // Straightforward code of medium length.
  (n) => [
    `export const updateBounds${n} = (element: ExcalidrawElement, scene: Scene) => {`,
    '  const [x1, y1, x2, y2] = getElementBounds(element);',
    '  const width = x2 - x1;',
    '  const height = y2 - y1;',
    '  const container = scene.getContainer(element);',
    '  const offset = container ? container.offset : { x: 0, y: 0 };',
    '  const next = { ...element, x: x1 + offset.x, y: y1 + offset.y, width, height };',
    '  scene.replaceElement(element.id, next);',
    '  scene.invalidate();',
    '  if (container) {',
    '    scene.replaceElement(container.id, { ...container, updated: Date.now() });',
    '  }',
    '  return next;',
    '};',
  ],
  // A class with methods.
  (n) => [
    `export class SnapCache${n} {`,
    '  private points: SnapPoint[] = [];',
    '  private version = 0;',
    '',
    '  set(points: SnapPoint[]) {',
    '    this.points = points;',
    '    this.version += 1;',
    '  }',
    '',
    '  get(): SnapPoint[] {',
    '    return this.points;',
    '  }',
    '',
    '  isStale(sceneVersion: number) {',
    '    return (sceneVersion ^ this.version) !== 0;',
    '  }',
    '}',
  ],
  // An exported interface.
  (n) => [
    `export interface SnapLine${n} {`,
    '  type: "points" | "gap" | "pointer";',
    '  points: readonly Point[];',
    '  direction?: "horizontal" | "vertical";',
    '}',
  ],
  // A function that converts units with magic numbers.
  (n) => [
    `export const getGridOffset${n} = (value: number, gridSize: number, zoom: number) => {`,
    '  const scaled = value * zoom;',
    '  const step = gridSize * Math.max(1, Math.round(4 / zoom));',
    '  return Math.round(scaled / step) * step - (scaled % 1000) / 60;',
    '};',
  ],
];

// A React component, for .tsx files.
const COMPONENT = (n) => [
  `export const Panel${n} = ({ title, onClose }: { title: string; onClose: () => void }) => {`,
  '  const [open, setOpen] = useState(false);',
  '  useEffect(() => {',
  '    const timer = window.setTimeout(() => setOpen(true), 150);',
  '    return () => window.clearTimeout(timer);',
  '  }, []);',
  '  return (',
  '    <div className="panel" onClick={onClose}>',
  '      {open ? title : null}',
  '    </div>',
  '  );',
  '};',
];

function fileText(file, lines, index) {
  const out = [
    'import { getCorners, getElementBounds } from "./bounds";',
    'import type { AppState, ExcalidrawElement, Point, Scene, SnapPoint } from "./types";',
    file.endsWith('.tsx') ? 'import { useEffect, useState } from "react";' : '',
    '',
    `export const SNAP_DISTANCE = ${8 + index};`,
    'export const DEFAULT_GRID_SIZE = 20;',
    '',
  ];
  let n = 0;
  while (out.length < lines) {
    const template = file.endsWith('.tsx') && n % 3 === 0 ? COMPONENT : TEMPLATES[(n + index) % TEMPLATES.length];
    const body = template(n);
    // About one function in three already has a JSDoc comment, as in the real code.
    if (n % 3 === 1 && /^export (const|function|class)/.test(body[0])) out.push('/**', ` * Part ${n} of ${pascal(file.split('/').pop().replace(/\.\w+$/, ''))}.`, ' */');
    out.push(...body, '');
    n++;
  }
  return `${out.join('\n')}\n`;
}

// Returns { path: text } for the fifteen files.
function excalidrawFiles() {
  return Object.fromEntries(FILES.map(([file, lines], i) => [file, fileText(file, lines, i)]));
}

module.exports = { FILES, excalidrawFiles };
