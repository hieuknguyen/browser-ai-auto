import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = `http://127.0.0.1:${env.PORT || 3220}`;
  return { plugins: [react()], build: { outDir: 'dist' }, server: { host: '127.0.0.1', port: Number(env.VITE_PORT || 5174), strictPort: true,
    proxy: { '/api': backend, '/debug': backend, '/artifacts': backend, '/events': { target: backend, ws: true } }
  } };
});
