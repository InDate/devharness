import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev transform is the point of this fixture: it stamps __source onto every
// JSX element, which is what the bench reads back off the fiber.
export default defineConfig({
  plugins: [react()],
  server: { port: 3102, strictPort: true },
});
