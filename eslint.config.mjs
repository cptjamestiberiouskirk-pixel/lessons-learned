// ESLint for this repo's own JavaScript: the script, the hook, the tests and the
// dev tools. Node's globals are listed here so no other package is needed.
import js from '@eslint/js';

const node = Object.fromEntries(
  ['process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
    'queueMicrotask', 'structuredClone', 'globalThis', 'performance', 'fetch'].map((g) => [g, 'readonly']),
);

export default [
  // tests/lint-fixtures.mjs is text the lint rules read, kept as it was found.
  {ignores: ['node_modules/', 'tests/lint-fixtures.mjs']},
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {ecmaVersion: 2024, sourceType: 'module', globals: node},
    linterOptions: {reportUnusedDisableDirectives: 'error'},
    rules: {
      'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true}],
      // An empty catch is how the script and the hook say "no answer, go on".
      'no-empty': ['error', {allowEmptyCatch: true}],
    },
  },
  // The tests match control characters and the script's padded output on purpose.
  {files: ['tests/**'], rules: {'no-control-regex': 'off', 'no-regex-spaces': 'off'}},
  {
    files: ['**/*.cjs'],
    languageOptions: {ecmaVersion: 2024, sourceType: 'commonjs', globals: {...node, require: 'readonly', module: 'writable', __dirname: 'readonly'}},
  },
];
