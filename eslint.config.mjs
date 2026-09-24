/**
 * ESLint 扁平配置。
 *
 * 只收「正确性」规则，不碰排版：本项目的排版是手工风格（见 .editorconfig 的说明），
 * prettier / vue 的 formatting 规则族一律不开 —— 让 lint 变成"能不能合"的门槛，
 * 而不是一次全量重排的借口。
 */
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-release/**',
      'src-tauri/**',
      'public/**',
      'node_modules/**',
      '.commandcode/**',
      'resources/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.{ts,vue,mjs,js}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // 标识符由 TypeScript 把关（strict 全开）；no-undef 会在 .vue 的编译宏上误报
      'no-undef': 'off',
      // 有意的 any 只出现在 mock 的远端 JSON 映射里，标黄不拦
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 可选 props 用 TS 的 `?` 表达，不要求运行时默认值
      'vue/require-default-prop': 'off',
      // App.vue 是根组件，单词名属于惯例豁免
      'vue/multi-word-component-names': ['error', { ignores: ['App'] }],
    },
  },
  {
    // .vue 的 <script setup lang="ts"> 由 vue-eslint-parser 先拆块，再交给 TS 解析器
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
  },
)
