import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import reactRefreshPlugin from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/coverage/**',
      'client/dist/**',
      // Served-verbatim demo assets and build scripts, both outside any tsconfig project.
      'client/public/**',
      'scripts/**',
      '**.databricks/**',
      'tests/**',
      // Throwaway browser-automation scratch dirs. Both are gitignored, and the code in
      // them runs inside page.evaluate, where `document` exists but the Node config here
      // says it does not.
      '**/.smoke-test/**',
      '**/.ui-test-artifacts/**',
    ],
  },

  // Base JavaScript config
  js.configs.recommended,

  // TypeScript config for all TS files
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // React config for client-side files
  {
    files: ['client/**/*.{ts,tsx}', '**/*.tsx'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'react-refresh': reactRefreshPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react/prop-types': 'off', // Using TypeScript for prop validation
      'react/no-array-index-key': 'warn',
    },
  },

  // Node.js specific config for server files
  {
    files: ['server/**/*.ts', '*.config.{js,ts}'],
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },

  // Disable type-checking for JS config files and standalone config files.
  // Plain .mjs helpers are deliberately outside every tsconfig project, so type-aware
  // rules would fail to parse them at all.
  {
    files: ['**/*.js', '**/*.mjs', '*.config.ts', '**/*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  // Those same helpers run under Node, so declare the globals they rely on.
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },

  // Keeps the password-manager opt-out on every text field. AppKit's Input and
  // Textarea are wrapped in client/src/ui.ts so the opt-out is applied once
  // rather than per call site; importing the package directly skips the wrapper
  // and reintroduces the "Save identity" popup a customer reported during POC
  // testing. client/src/password-manager-optout.test.ts guards the attributes
  // themselves; this reports the bypass in the editor, before the suite runs.
  {
    files: ['client/**/*.{ts,tsx}'],
    ignores: ['client/src/ui.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@databricks/appkit-ui/react',
              message:
                "Import from './ui' instead. That barrel re-exports AppKit unchanged, " +
                'except for Input and Textarea, which it opts out of 1Password, LastPass, ' +
                'Dashlane and Bitwarden. Nothing in this app is a credential field.',
            },
          ],
        },
      ],
    },
  },

  // Prettier config (must be last to override other formatting rules)
  prettier,

  // Custom rules
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Protects the `custom_inputs` transport. Both of the shorter ways to call the
  // agent endpoint drop that field without erroring, which disables plan approval,
  // attachments and conversation history while every request still returns 200.
  // The test suite guards this too (server/routes/serving-transport.guard.test.ts);
  // this layer reports it in the editor, before the suite is ever run.
  {
    files: ['server/**/*.ts'],
    ignores: ['server/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@databricks/appkit',
              importNames: ['serving'],
              message:
                "AppKit's serving() plugin strips custom_inputs at two allowlists (its own " +
                'schema filter, then the SDK typed query). Post to the endpoint through ' +
                'the transport in server/routes/insights-routes.ts instead.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.property.name='servingEndpoints'][property.name='query']",
          message:
            'servingEndpoints.query() rebuilds the request body from a fixed field ' +
            'allowlist that omits custom_inputs. POST to the endpoint /invocations ' +
            'path via apiClient.request() instead.',
        },
        {
          selector: "MemberExpression[object.name='servingEndpoints'][property.name='query']",
          message:
            'servingEndpoints.query() rebuilds the request body from a fixed field ' +
            'allowlist that omits custom_inputs. POST to the endpoint /invocations ' +
            'path via apiClient.request() instead.',
        },
      ],
    },
  }
);
