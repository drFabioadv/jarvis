import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
// `vite build --mode cloud` gera o JARVIS 3.0 (PWA da nuvem): conversa só com a
// API própria e troca o módulo da Anthropic por um vazio — o SDK nem entra.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    mode === 'cloud' && {
      name: 'jarvis-pwa',
      transformIndexHtml: (html: string) =>
        html.replace(
          '</head>',
          '<link rel="manifest" href="/manifest.webmanifest" /><meta name="theme-color" content="#05050f" /><link rel="apple-touch-icon" href="/icone-192.png" /><meta name="apple-mobile-web-app-capable" content="yes" /></head>',
        ),
    },
  ],
  define: mode === 'cloud' ? { 'import.meta.env.VITE_BACKEND': JSON.stringify('cloud') } : {},
  resolve: {
    alias:
      mode === 'cloud'
        ? [{ find: /^\.\/anthropic$/, replacement: fileURLToPath(new URL('./src/lib/anthropic-desligado.ts', import.meta.url)) }]
        : [],
  },
  build: mode === 'cloud' ? { outDir: 'dist-cloud' } : {},
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
}))
