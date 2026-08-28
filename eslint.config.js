import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Keep type-only imports explicit — matches `verbatimModuleSyntax` in tsconfig.
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
