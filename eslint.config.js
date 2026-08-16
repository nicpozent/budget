// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Lint configuration.
 *
 * Most of this is ordinary hygiene. The `no-restricted-syntax` block is not —
 * those rules are named security controls that SPEC requires to be enforced
 * mechanically rather than by review:
 *
 *   SEC-020  "String-concatenated or template-interpolated SQL is prohibited
 *             and blocked in CI by a lint rule and a review checklist item."
 *   SEC-030  "React's dangerouslySetInnerHTML and any equivalent are prohibited."
 *   NFR-002  Money must never touch float arithmetic.
 */
export default tseslint.config(
  {
    // `design/` is reference material: generated runtime and prototype markup,
    // neither built nor deployed.
    ignores: ['**/dist/**', '**/node_modules/**', 'design/**', 'db/fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      'no-restricted-syntax': [
        'error',
        {
          // SEC-020. `client.query('select ... ' + x)` and its template-literal
          // equivalent. All database access goes through the `sql` tagged
          // template, which binds every interpolated value.
          selector:
            "CallExpression[callee.property.name=/^(query|execute)$/] > TemplateLiteral[expressions.length>0]",
          message:
            'SEC-020: build statements with the `sql` tagged template so values are bound, never interpolated.',
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(query|execute)$/] > BinaryExpression[operator='+']",
          message:
            'SEC-020: string-concatenated SQL is prohibited. Use the `sql` tagged template.',
        },
        {
          // SEC-030.
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'SEC-030: output encoding is the XSS defence. Render text as text.',
        },
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: 'SEC-030: assigning innerHTML bypasses output encoding.',
        },
        {
          // NFR-002. parseFloat on an amount reintroduces float money.
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            'NFR-002: money is fixed-precision. Use Money.parse, which takes a decimal string.',
        },
      ],
    },
  },
  {
    // Tests deliberately construct malformed input and poke at internals.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
