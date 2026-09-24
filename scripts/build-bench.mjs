#!/usr/bin/env node

/**
 * Build script for the bench - the panel beside a driven app
 *
 * The bench is served from a local port by the MCP server, so the bundle is
 * self-contained: nothing is fetched from a network the app under test may not
 * have. Bundled rather than typechecked by `tsc`, which is why the source sits
 * in a directory the root tsconfig excludes - the same arrangement the
 * dashboard frontend uses.
 */

import * as esbuild from 'esbuild';
import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outDir = join(rootDir, 'build', 'bench');

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

try {
  await esbuild.build({
    entryPoints: [join(rootDir, 'src', 'bench', 'frontend', 'app.tsx')],
    bundle: true,
    minify: true,
    outfile: join(outDir, 'bundle.js'),
    format: 'esm',
    target: ['es2020'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  console.log('Bench frontend built successfully');
} catch (error) {
  console.error('Bench build failed:', error);
  process.exit(1);
}
