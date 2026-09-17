import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Same fixture as the React app, on Preact's dev transform - the two put their
// component and source information in different places, which is the point.
export default defineConfig({
  plugins: [preact()],
  server: { port: 3103, strictPort: true },
});
