import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/client', import.meta.url)) } },
  build: {
    outDir: 'dist/client',
    manifest: true,
    assetsInlineLimit: 0,
    rollupOptions: { input: {
      staff: fileURLToPath(new URL('./index.html', import.meta.url)),
      guestMenu: fileURLToPath(new URL('./guest-menu.html', import.meta.url))
    } }
  }
});
