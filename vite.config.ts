import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `same-origin-allow-popups` instead of `same-origin` so the Google OAuth popup
// can talk back to us via postMessage. ffmpeg-mt would need full `same-origin`
// for SharedArrayBuffer, but the app no longer uses ffmpeg — heic2any handles
// HEIC and WebCodecs handles the encode.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
  // `host: true` binds Vite to 0.0.0.0 so phones on the same Wi-Fi can hit
  // the dev server at http://<your-computer-ip>:5173 . If you don't want
  // others on the LAN to reach it, comment this back out.
  server: { host: true, headers: crossOriginIsolation },
  preview: { host: true, headers: crossOriginIsolation },
})
