'use strict';

// The language table, plus the rules that decide whether a file is commented,
// only read for docs, or skipped.

const path = require('path');

const MAX_FILE_BYTES = 200 * 1024;

// Lexer tokens for languages checked by placement rules only. At each position the
// lexer tries a language's tokens in order and takes the first match.
const T = {
  slashLine: { re: /\/\//y, kind: 'line' },
  hashLine: { re: /#/y, kind: 'line' },
  // Shell and Perl use # in $#, ${#x} and s#a#b#, so only a # after whitespace starts a comment.
  hashLineSpaced: { re: /#/y, kind: 'line', needsSpaceBefore: true },
  // PHP 8 attributes start with #[.
  hashLineNoAttr: { re: /#(?!\[)/y, kind: 'line' },
  dashLine: { re: /--/y, kind: 'line' },
  // In Haskell, --> and similar are operators, not comments.
  haskellLine: { re: /--+(?![!#$%&*+./<=>?@\\^|~:])/y, kind: 'line' },
  cBlock: { re: /\/\*/y, kind: 'block', close: '*/' },
  haskellBlock: { re: /\{-/y, kind: 'block', close: '-}' },
  luaBlock: { re: /--\[(=*)\[/y, kind: 'block', close: (m) => `]${m[1]}]` },
  psBlock: { re: /<#/y, kind: 'block', close: '#>' },
  dq: { re: /"/y, kind: 'string', close: '"', escape: '\\', multiline: true },
  dqSingleLine: { re: /"/y, kind: 'string', close: '"', escape: '\\', multiline: false },
  dqRaw: { re: /"/y, kind: 'string', close: '"', multiline: true },
  psDq: { re: /"/y, kind: 'string', close: '"', escape: '`', multiline: true },
  sq: { re: /'/y, kind: 'string', close: "'", escape: '\\', multiline: true },
  sqSingleLine: { re: /'/y, kind: 'string', close: "'", escape: '\\', multiline: false },
  sqRaw: { re: /'/y, kind: 'string', close: "'", multiline: true },
  backtick: { re: /`/y, kind: 'string', close: '`', escape: '\\', multiline: true },
  backtickRaw: { re: /`/y, kind: 'string', close: '`', multiline: true },
  tripleDq: { re: /"""/y, kind: 'string', close: '"""', escape: '\\', multiline: true },
  tripleDqRaw: { re: /"""/y, kind: 'string', close: '"""', multiline: true },
  tripleSq: { re: /'''/y, kind: 'string', close: "'''", escape: '\\', multiline: true },
  cppRaw: { re: /R"([^()\\\s]{0,16})\(/y, kind: 'string', close: (m) => `)${m[1]}"`, multiline: true },
  rustRaw: { re: /b?r(#*)"/y, kind: 'string', close: (m) => `"${m[1]}`, multiline: true },
  csVerbatim: { re: /\$?@\$?"/y, kind: 'string', close: '"', multiline: true },
  luaLong: { re: /\[(=*)\[/y, kind: 'string', close: (m) => `]${m[1]}]`, multiline: true },
  psHereDq: { re: /@"/y, kind: 'string', close: '"@', multiline: true },
  psHereSq: { re: /@'/y, kind: 'string', close: "'@", multiline: true },
  // Character literals that could otherwise look like the start of a string, such as '"'.
  charLiteral: { re: /'(?:\\.|[^\\'\n])'/y, kind: 'code' },
  shHeredoc: { re: /<<(?!<)-?[ \t]*(['"]?)([A-Za-z_]\w*)\1/y, kind: 'heredoc', terminator: (m) => m[2] },
  rubyHeredoc: { re: /<<[~-]?(['"`]?)([A-Z_][A-Z0-9_]*)\1/y, kind: 'heredoc', terminator: (m) => m[2] },
  perlHeredoc: { re: /<<~?(?:(['"])([A-Za-z_]\w*)\1|([A-Z_][A-Z0-9_]*))/y, kind: 'heredoc', terminator: (m) => m[2] || m[3] },
  phpHeredoc: { re: /<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1/y, kind: 'heredoc', terminator: (m) => m[2] },
};

// Comment blocks that must start at column 0 and end on a line of their own.
const LINE_BLOCKS = {
  ruby: [{ open: /^=begin\b/, close: /^=end\b/ }],
  perl: [{ open: /^=[a-zA-Z]/, close: /^=cut\b/ }],
};

const AT_ANNOTATION = /^@[A-Za-z_][\w.]*(\(.*\))?\s*$/;

// Declaration starts for languages without a parser, used to place heavy-level block comments.
const C_LIKE_DECLARATION = new RegExp(
  '^(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|sealed|async|extern|' +
  'inline|constexpr|unsafe|open|data|suspend|export|default|partial|readonly|synchronized|native|operator|' +
  'infix|tailrec|pub(?:\\([^)]*\\))?|fileprivate|mutating|required|convenience|dynamic|implicit|' +
  'template\\s*<[^>]*>)\\s+)*' +
  '(?:class|struct|enum|interface|trait|impl|object|record|protocol|extension|fn|func|fun|function|def|' +
  'namespace|module|typedef|union|actor|init|macro_rules!)\\b'
);
// Matches a signature such as "int main(void) {" or "public static void run(String[] args)".
const C_SIGNATURE = /^(?!(?:if|for|while|switch|return|else|catch|do|new|throw|case|sizeof|await|yield|delete|using|lock|foreach|synchronized|goto)\b)[\w$<>[\],.*&:~\s]*\b[A-Za-z_][\w<>,\s*&:]*\s+[*&]*[~A-Za-z_][\w:]*\s*\([^;]*$/;

const C_FAMILY_DECLARATIONS = [C_LIKE_DECLARATION, C_SIGNATURE];

const LANGUAGES = [
  { id: 'javascript', name: 'JavaScript', extensions: ['js', 'mjs', 'cjs'], verifier: 'typescript', scriptKind: 'JS', lineComment: '//', blockStyle: 'jsdoc' },
  { id: 'jsx', name: 'JavaScript (JSX)', extensions: ['jsx'], verifier: 'typescript', scriptKind: 'JSX', lineComment: '//', blockStyle: 'jsdoc' },
  { id: 'typescript', name: 'TypeScript', extensions: ['ts', 'mts', 'cts'], verifier: 'typescript', scriptKind: 'TS', lineComment: '//', blockStyle: 'jsdoc' },
  { id: 'tsx', name: 'TypeScript (TSX)', extensions: ['tsx'], verifier: 'typescript', scriptKind: 'TSX', lineComment: '//', blockStyle: 'jsdoc' },
  { id: 'python', name: 'Python', extensions: ['py', 'pyw', 'pyi'], verifier: 'python', lineComment: '#', blockStyle: 'line', encodingLine: true },

  {
    id: 'c', name: 'C', extensions: ['c', 'h'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.dq, T.sqSingleLine],
    imports: [/^#\s*(include|import)\b/], declarations: C_FAMILY_DECLARATIONS,
  },
  {
    id: 'cpp', name: 'C++', extensions: ['cc', 'cpp', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'ipp'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.cppRaw, T.dq, T.sqSingleLine],
    imports: [/^#\s*(include|import)\b/, /^import\s/, /^using\s+namespace\s/], declarations: C_FAMILY_DECLARATIONS,
  },
  {
    id: 'csharp', name: 'C#', extensions: ['cs'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.tripleDqRaw, T.csVerbatim, T.dq, T.sqSingleLine],
    imports: [/^(global\s+)?using\s+(static\s+)?[\w.]+(\s*=\s*[\w.<>]+)?\s*;/, /^namespace\s+[\w.]+\s*;/],
    annotation: /^\[[A-Za-z_][\w.]*(\(.*\))?(\s*,\s*[A-Za-z_][\w.]*(\(.*\))?)*\]\s*$/,
    declarations: C_FAMILY_DECLARATIONS,
  },
  {
    id: 'java', name: 'Java', extensions: ['java'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.tripleDq, T.dq, T.sqSingleLine],
    imports: [/^(import|package)\s/], annotation: AT_ANNOTATION, declarations: C_FAMILY_DECLARATIONS,
  },
  {
    id: 'go', name: 'Go', extensions: ['go'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.backtickRaw, T.dq, T.sqSingleLine],
    imports: [/^(import|package)\b/], importBlock: { open: /^import\s*\(\s*$/, close: /^\)/ },
    declarations: [/^(func|type)\b/],
  },
  {
    id: 'rust', name: 'Rust', extensions: ['rs'], lineComment: '//', blockStyle: 'line',
    // Single quotes are lifetimes or characters in Rust, never strings.
    tokens: [T.slashLine, T.cBlock, T.rustRaw, T.charLiteral, T.dq],
    imports: [/^(pub(\([\w:]+\))?\s+)?(use\s|extern\s+crate\s|mod\s+\w+\s*;)/], annotation: /^#!?\[.*\]\s*$/,
    declarations: [C_LIKE_DECLARATION],
  },
  {
    id: 'swift', name: 'Swift', extensions: ['swift'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.tripleDq, T.dq],
    imports: [/^(@testable\s+)?import\s/], annotation: AT_ANNOTATION, declarations: [C_LIKE_DECLARATION],
  },
  {
    id: 'kotlin', name: 'Kotlin', extensions: ['kt', 'kts'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.tripleDqRaw, T.dq, T.sqSingleLine],
    imports: [/^(import|package)\s/], annotation: AT_ANNOTATION, declarations: [C_LIKE_DECLARATION],
  },
  {
    id: 'scala', name: 'Scala', extensions: ['scala', 'sc'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.tripleDqRaw, T.dq, T.sqSingleLine],
    imports: [/^(import|package)\s/], annotation: AT_ANNOTATION, declarations: [C_LIKE_DECLARATION],
  },
  {
    id: 'dart', name: 'Dart', extensions: ['dart'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.tripleDq, T.tripleSq, T.dqSingleLine, T.sqSingleLine],
    imports: [/^(import|export|part|library)\s/], annotation: AT_ANNOTATION, declarations: C_FAMILY_DECLARATIONS,
  },
  {
    id: 'php', name: 'PHP', extensions: ['php'], lineComment: '//', blockStyle: 'line', phpTags: true,
    tokens: [T.slashLine, T.hashLineNoAttr, T.cBlock, T.phpHeredoc, T.dq, T.sq],
    imports: [/^(use|namespace|require(_once)?|include(_once)?)\b/], annotation: /^#\[.*\]\s*$/,
    declarations: C_FAMILY_DECLARATIONS,
  },
  {
    id: 'ruby', name: 'Ruby', extensions: ['rb', 'rake', 'gemspec'], lineComment: '#', blockStyle: 'line', encodingLine: true,
    tokens: [T.hashLine, T.rubyHeredoc, T.dq, T.sq, T.backtick], lineBlocks: LINE_BLOCKS.ruby,
    imports: [/^(require|require_relative|load)\b/], declarations: [/^(def|class|module)\s/],
  },
  {
    id: 'shell', name: 'Shell', extensions: ['sh', 'bash', 'zsh', 'ksh'], lineComment: '#', blockStyle: 'line',
    tokens: [T.hashLineSpaced, T.shHeredoc, T.sqRaw, T.dq, T.backtick],
    imports: [/^(source|\.)\s/], declarations: [/^(function\s+[\w:-]+|[\w:-]+\s*\(\s*\))/],
  },
  {
    id: 'r', name: 'R', extensions: ['r'], lineComment: '#', blockStyle: 'line',
    tokens: [T.hashLine, T.dq, T.sq],
    imports: [/^(library|require|source)\s*\(/], declarations: [/^[\w.]+\s*(<-|=)\s*function\s*\(/],
  },
  {
    id: 'perl', name: 'Perl', extensions: ['pl', 'pm'], lineComment: '#', blockStyle: 'line',
    tokens: [T.hashLineSpaced, T.perlHeredoc, T.dq, T.sq], lineBlocks: LINE_BLOCKS.perl,
    imports: [/^(use|require|no)\s/], declarations: [/^sub\s/],
  },
  {
    id: 'powershell', name: 'PowerShell', extensions: ['ps1', 'psm1', 'psd1'], lineComment: '#', blockStyle: 'line',
    tokens: [T.psBlock, T.hashLine, T.psHereDq, T.psHereSq, T.psDq, T.sqRaw],
    imports: [/^(Import-Module|using\s+(module|namespace|assembly)|\.\s)/i], declarations: [/^(function|filter|class|enum)\s/i],
  },
  {
    id: 'sql', name: 'SQL', extensions: ['sql'], lineComment: '--', blockStyle: 'line',
    tokens: [T.dashLine, T.cBlock, T.sqRaw, T.dqRaw],
    imports: [], declarations: [/^create\s+(or\s+replace\s+)?(function|procedure|view|table|trigger|type|index|materialized\s+view)\b/i],
  },
  {
    id: 'lua', name: 'Lua', extensions: ['lua'], lineComment: '--', blockStyle: 'line',
    tokens: [T.luaBlock, T.dashLine, T.luaLong, T.dqSingleLine, T.sqSingleLine],
    imports: [/^(local\s+[\w,\s]+=\s*)?require\b/], declarations: [/^(local\s+)?function\s/, /^[\w.:]+\s*=\s*function\s*\(/],
  },
  {
    id: 'haskell', name: 'Haskell', extensions: ['hs'], lineComment: '--', blockStyle: 'line',
    tokens: [T.haskellBlock, T.haskellLine, T.charLiteral, T.dq],
    imports: [/^(import|module)\s/], declarations: [/^([a-z_][\w']*\s*::|(data|newtype|type|class|instance)\s)/],
  },
  {
    id: 'css', name: 'CSS', extensions: ['css'], lineComment: null, blockStyle: 'cblock',
    tokens: [T.cBlock, T.dqSingleLine, T.sqSingleLine],
    imports: [/^@(import|charset|namespace)\b/], declarations: [/\{\s*$/],
  },
  {
    id: 'scss', name: 'SCSS', extensions: ['scss'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.dqSingleLine, T.sqSingleLine],
    imports: [/^@(import|use|forward|charset)\b/], declarations: [/\{\s*$/, /^@(mixin|function)\s/],
  },
  {
    id: 'less', name: 'Less', extensions: ['less'], lineComment: '//', blockStyle: 'line',
    tokens: [T.slashLine, T.cBlock, T.dqSingleLine, T.sqSingleLine],
    imports: [/^@(import|charset)\b/], declarations: [/\{\s*$/],
  },
];

const BY_EXTENSION = new Map();
const BY_ID = new Map();
for (const language of LANGUAGES) {
  BY_ID.set(language.id, language);
  for (const ext of language.extensions) BY_EXTENSION.set(ext, language);
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', '.docturnal', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.cache', '.parcel-cache', '__pycache__',
  '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', 'vendor', 'bower_components', '.gradle',
  'obj', 'Pods', 'DerivedData', '.dart_tool', '.terraform', '.yarn', 'site-packages', 'elm-stuff',
]);

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'composer.lock', 'go.sum',
  'mix.lock', 'pubspec.lock', 'Podfile.lock', 'packages.lock.json', 'flake.lock',
]);

const DOCS_ONLY_NAMES = new Set([
  'package.json', 'requirements.txt', 'pyproject.toml', 'Dockerfile', '.env.example', 'tsconfig.json',
]);
const DOCS_ONLY_PATTERNS = [
  /^requirements[-_.][\w.-]*\.txt$/, /^Dockerfile\./, /\.dockerfile$/i, /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/,
  /^tsconfig\.[\w.-]+\.json$/, /\.prisma$/, /\.(graphql|gql)$/, /\.proto$/,
];

const GENERATED_PATTERNS = [
  /\.min\.(js|css)$/, /\.map$/, /\.d\.ts$/, /\.pb\.go$/, /_pb2(_grpc)?\.pyi?$/, /\.generated\.\w+$/,
  /\.g\.dart$/, /\.freezed\.dart$/, /\.designer\.cs$/i, /\.lock$/,
];

function extensionOf(filePath) {
  return path.posix.extname(filePath).slice(1).toLowerCase();
}

function languageForPath(filePath) {
  return BY_EXTENSION.get(extensionOf(filePath)) || null;
}

function languageById(id) {
  return BY_ID.get(id) || null;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

// A pattern with no slash matches a file name or any folder name, as in .gitignore.
function matchesGlob(filePath, glob) {
  const pattern = glob.replace(/^\.\//, '').replace(/\/$/, '');
  if (!pattern) return false;
  const re = globToRegExp(pattern);
  if (pattern.includes('/')) return re.test(filePath);
  return filePath.split('/').some((segment) => re.test(segment));
}

function isBinary(sample) {
  if (!sample) return false;
  const end = Math.min(sample.length, 8000);
  for (let i = 0; i < end; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

// Returns { action: 'comment' | 'docs' | 'skip', language, reason }.
function classifyFile(filePath, { docsDir = 'docs', exclude = [], extensions = [], size = 0, sample = null } = {}) {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/')).replace(/^\.\//, '');
  const segments = normalized.split('/');
  const name = segments[segments.length - 1];
  const docsPrefix = path.posix.normalize(docsDir).replace(/\/$/, '');

  if (segments.slice(0, -1).some((segment) => SKIP_DIRS.has(segment))) {
    return { action: 'skip', reason: 'ignored folder' };
  }
  if (docsPrefix !== '.' && (normalized === docsPrefix || normalized.startsWith(`${docsPrefix}/`))) {
    return { action: 'skip', reason: 'docs folder' };
  }
  if (LOCKFILES.has(name)) return { action: 'skip', reason: 'lockfile' };
  if (exclude.some((glob) => matchesGlob(normalized, glob))) return { action: 'skip', reason: 'excluded' };
  if (size > MAX_FILE_BYTES) return { action: 'skip', reason: 'larger than 200 KB' };
  if (isBinary(sample)) return { action: 'skip', reason: 'binary' };
  if (DOCS_ONLY_NAMES.has(name) || DOCS_ONLY_PATTERNS.some((re) => re.test(name))) {
    return { action: 'docs', reason: 'read for docs only' };
  }
  if (GENERATED_PATTERNS.some((re) => re.test(name))) return { action: 'skip', reason: 'generated' };

  const language = languageForPath(normalized);
  if (!language) return { action: 'skip', reason: 'unsupported language' };
  const allowed = extensions.map((ext) => ext.replace(/^\./, '').toLowerCase());
  if (allowed.length && !allowed.includes(extensionOf(normalized))) {
    return { action: 'skip', reason: 'extension not listed' };
  }
  return { action: 'comment', language };
}

module.exports = {
  LANGUAGES,
  LEXER_TOKENS: T,
  LOCKFILES,
  MAX_FILE_BYTES,
  SKIP_DIRS,
  classifyFile,
  languageById,
  languageForPath,
  matchesGlob,
};
