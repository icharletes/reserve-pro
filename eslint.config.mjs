import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

/**
 * ESLint (flat config). Además de estilo, AQUÍ se hacen cumplir las reglas de arquitectura de CLAUDE.md y de
 * docs/architecture: límites de dependencias entre paquetes y prohibiciones de seguridad.
 */

// Paquetes que SOLO el backend puede usar (el navegador jamás debe importarlos).
const BACKEND_ONLY = [
  '@reservepro/database',
  '@reservepro/booking-domain',
  '@nestjs/*',
  '@prisma/*',
  'pg',
  'argon2',
  'ioredis',
  'bullmq',
  'nodemailer',
];

// Importar "por dentro" de otro paquete o de una app rompe el encapsulamiento.
const DEEP_IMPORTS = {
  group: ['@reservepro/*/src/*', '@reservepro/*/dist/*', '**/apps/*/src/**'],
  message: 'Importa solo por la entrada pública del paquete.',
};

/**
 * OJO: en flat config, si varios bloques definen `no-restricted-imports` el ÚLTIMO REEMPLAZA a los anteriores
 * (no se combinan). Por eso cada bloque usa este helper, que siempre incluye DEEP_IMPORTS.
 */
const restrict = (names, message) => {
  const paths = names.filter((n) => !n.includes('*')).map((name) => ({ name, message }));
  const groups = names.filter((n) => n.includes('*'));
  return {
    'no-restricted-imports': [
      'error',
      {
        paths,
        patterns: [DEEP_IMPORTS, ...(groups.length > 0 ? [{ group: groups, message }] : [])],
      },
    ],
  };
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.astro/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/database/src/generated/**',
      'docs/**',
      '**/*.astro',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],

  // --- Reglas generales (todo el código) -------------------------------------------------------------
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // SQL: solo con parámetros (tagged templates). Las variantes *Unsafe permiten inyección SQL.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^\\$(query|execute)RawUnsafe$/]',
          message:
            'Prohibido: usa $queryRaw / $executeRaw con plantillas parametrizadas (inyección SQL).',
        },
      ],
    },
  },

  // Base para TODO el código: nadie importa "por dentro" de otro paquete o app (los bloques específicos
  // de más abajo lo sustituyen, pero siempre lo incluyen vía `restrict`).
  { files: ['**/*.ts', '**/*.vue'], rules: restrict([], '') },

  // --- Vue: parser TypeScript dentro de los .vue y prohibiciones -----------------------------------------
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, sourceType: 'module' },
      globals: { ...globals.browser },
    },
    rules: {
      'vue/no-v-html': 'error', // XSS: jamás renderizar HTML de usuario
      'vue/multi-word-component-names': 'off', // vistas como Login/Members son claras en su carpeta
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/attributes-order': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
    },
  },

  // --- Reglas con información de tipos (código de producción, no pruebas) --------------------------------
  {
    files: [
      'apps/api/src/**/*.ts',
      'packages/*/src/**/*.ts',
      'apps/admin/src/**/*.ts',
      'apps/web/src/**/*.ts',
    ],
    ignores: ['**/*.test.ts', '**/__tests__/**', 'packages/database/src/testing.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error', // una promesa sin await/catch pierde errores en silencio
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // --- LÍMITES DE ARQUITECTURA ------------------------------------------------------------------------
  // booking-domain: PURO (sin Nest, Prisma, I/O ni otros paquetes del repo).
  {
    files: ['packages/booking-domain/src/**/*.ts'],
    rules: restrict(
      ['@reservepro/*', '@nestjs/*', '@prisma/*', 'pg', 'ioredis', 'bullmq', 'node:*', 'zod'],
      'booking-domain debe ser puro: sin I/O ni dependencias del repo.',
    ),
  },
  // contracts: solo zod.
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: restrict(
      ['@reservepro/*', '@nestjs/*', '@prisma/*', 'pg', 'ioredis', 'bullmq'],
      'contracts solo puede depender de zod.',
    ),
  },
  // Navegador (admin, web, api-client): nunca código de servidor.
  {
    files: [
      'apps/admin/src/**/*.{ts,vue}',
      'apps/web/src/**/*.{ts,vue}',
      'packages/api-client/src/**/*.ts',
    ],
    languageOptions: { globals: { ...globals.browser } },
    rules: restrict(
      BACKEND_ONLY,
      'El navegador no puede importar código de servidor (el backend es la autoridad).',
    ),
  },
  // El panel NUNCA guarda credenciales en el navegador: el access token vive solo en memoria.
  {
    files: ['apps/admin/src/**/*.{ts,vue}'],
    ignores: ['**/*.test.ts', '**/__tests__/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Prohibido guardar tokens en el navegador.' },
        { name: 'sessionStorage', message: 'Prohibido guardar tokens en el navegador.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'localStorage' },
        { object: 'window', property: 'sessionStorage' },
      ],
    },
  },

  // Scripts y configuración: permiten console.log y globals de Node.
  {
    files: [
      'apps/api/src/scripts/**/*.ts',
      'packages/database/prisma.config.ts',
      'packages/database/test/**/*.ts',
      '**/vite.config.ts',
      '**/vitest.config.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  // Pruebas: se relajan reglas de producción.
  {
    files: ['**/*.test.ts', '**/__tests__/**/*.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-console': 'off',
    },
  },

  // SIEMPRE el último: desactiva las reglas de formato que chocan con Prettier (un solo dueño del estilo).
  prettier,
);
