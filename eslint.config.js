// Flat ESLint config for @vukvukovich/hammerspoon-mcp.
//
// Formatting is deliberately NOT configured here. Prettier owns whitespace,
// quotes, and line width; ESLint owns correctness and safety. Because this file
// declares no formatting rules, eslint-config-prettier is unnecessary: there is
// nothing for it to switch off. Do not add stylistic-whitespace rules here.
//
// Note: @eslint/js is not a declared dependency of this package, so
// js.configs.recommended is not extended. The typescript-eslint presets below,
// plus the explicit core rules, cover what this project needs. If you want the
// full core recommended set, add @eslint/js to devDependencies first.

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Generated output and vendored code are never our problem.
    ignores: ['dist/', 'coverage/', 'node_modules/'],
  },

  {
    // Type-aware rules only make sense on files the TS program knows about.
    // Scoping to *.ts keeps this config file itself (plain JS) out of the
    // project service, which would otherwise fail to resolve it: tsconfig.json
    // lists eslint.config.js under "include" but "allowJs" is off, so it is not
    // part of any program.
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],

    languageOptions: {
      parserOptions: {
        // projectService resolves the nearest tsconfig per file. The root
        // tsconfig.json already covers src/, test/ and *.config.ts.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // ---------------------------------------------------------------------
      // Naming
      // ---------------------------------------------------------------------
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'default',
          format: ['camelCase'],
          leadingUnderscore: 'forbid',
          trailingUnderscore: 'forbid',
        },
        {
          // Module-level constants are SCREAMING_SNAKE_CASE by convention here.
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE'],
        },
        {
          // A single leading underscore marks a parameter that exists only to
          // satisfy an arity contract and is intentionally unused.
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['camelCase'],
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          // Hungarian-style "IFoo" hides whether a name is a type or a value.
          // The type system already tells us.
          selector: 'interface',
          format: ['PascalCase'],
          custom: { regex: '^I[A-Z]', match: false },
        },
        {
          selector: 'typeParameter',
          format: ['PascalCase'],
          prefix: ['T'],
        },
        {
          selector: 'enumMember',
          format: ['PascalCase'],
        },
        {
          // Object literal keys and type members are frequently wire
          // identifiers we do not own: MCP tool names are hs_snake_case, and
          // JSON payload keys come from Hammerspoon and the MCP protocol.
          // Renaming them to satisfy a linter would break the wire format, so
          // format checks are switched off for these two selectors.
          selector: ['objectLiteralProperty', 'typeProperty'],
          format: null,
        },
        {
          // Default imports of PascalCase modules (classes, namespaces) are
          // legitimate; everything else stays camelCase.
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],

      // ---------------------------------------------------------------------
      // stdout is the protocol
      // ---------------------------------------------------------------------
      // An MCP server speaks JSON-RPC over stdout. A single stray console.log
      // corrupts the framing and the client drops the connection. Every
      // diagnostic goes through the stderr logger instead. This rule is a
      // safety control, not a style preference.
      'no-console': 'error',

      // ---------------------------------------------------------------------
      // No escape hatches out of the type system
      // ---------------------------------------------------------------------
      // Untyped values flowing from a subprocess into Lua generation is exactly
      // the injection path this project exists to close, so the no-unsafe-*
      // family inherited from recommendedTypeChecked stays at error. Do not
      // downgrade it.
      '@typescript-eslint/no-explicit-any': 'error',
      // Non-null assertions turn a runtime crash into a silent lie about types.
      // Narrow, or throw a real error with a message.
      '@typescript-eslint/no-non-null-assertion': 'error',
      // `{ ... } as Foo` skips excess-property checking, which is how malformed
      // tool payloads get built without the compiler noticing. Annotate the
      // variable instead.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],

      // ---------------------------------------------------------------------
      // Async correctness
      // ---------------------------------------------------------------------
      // Every bridge call shells out to a subprocess. A dropped promise means a
      // silently swallowed Hammerspoon failure or an unhandled rejection that
      // kills the server.
      '@typescript-eslint/no-floating-promises': 'error',
      // Passing an async function where a void callback is expected loses the
      // rejection entirely.
      '@typescript-eslint/no-misused-promises': 'error',

      // Tool dispatch and error mapping switch over discriminated unions.
      // Adding a variant must break the build, not fall through at runtime.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // ---------------------------------------------------------------------
      // Module surface
      // ---------------------------------------------------------------------
      // verbatimModuleSyntax is on, so a type-only import written as a value
      // import emits a real runtime import of a module that may not exist at
      // runtime.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // Types compose with unions and intersections and cannot be silently
      // reopened by a later declaration merge, which matters for Zod-derived
      // shapes. Overrides the stylistic preset's default of 'interface'.
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      // The published API is the contract. Inference is fine internally, but an
      // exported signature should never change because an implementation detail
      // changed.
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      // A leading underscore is the explicit "I know, it is on purpose" marker.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // tsconfig sets noPropertyAccessFromIndexSignature, which requires
      // obj['key'] for index-signature members. Without this option the
      // stylistic preset's dot-notation rule would demand the opposite and the
      // two would deadlock.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],

      // ---------------------------------------------------------------------
      // Core JS hygiene
      // ---------------------------------------------------------------------
      // `== null` is the idiomatic single check for null-or-undefined and is
      // the one loose comparison worth keeping.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Reassigning a parameter makes the value at the top of a function differ
      // from the value at the bottom, which is a nasty read in argument
      // sanitising code.
      'no-param-reassign': ['error', { props: true }],
      'prefer-const': 'error',
      // This package is ESM-only ("type": "module"). __dirname and __filename
      // do not exist and referencing them is a ReferenceError at runtime, not a
      // compile error, because @types/node declares them for the CJS case.
      'no-restricted-globals': [
        'error',
        {
          name: '__dirname',
          message: 'Not defined in ESM. Use import.meta.dirname instead.',
        },
        {
          name: '__filename',
          message: 'Not defined in ESM. Use import.meta.filename instead.',
        },
      ],
    },
  },

  {
    // The one module allowed to touch the console, and it writes to stderr
    // only. Everything else routes through it.
    files: ['src/logging/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    // Fixtures and mocks are hand-built stand-ins for values the type system
    // cannot see into: parsed JSON blobs, partial SDK objects, deliberate
    // garbage fed to the codec. Forcing full type safety on them would mean
    // writing more assertion ceremony than test.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // no-console stays on. A test that prints to stdout is still a test that
      // will one day be copied into src/.
    },
  }
);
