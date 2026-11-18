import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
    plugins: [react()],
    base: '/energy_balance_for_all/',
    // Expose VITE_* (default) and the Firebase web-config vars copied from the older Create React App
    // projects (REACT_APP_FIREBASE_*). Firebase web config is public by design; secrets such as the
    // Fitbit client secret keep their REACT_APP_FITBIT_* names and are NOT exposed to the browser.
    envPrefix: ['VITE_', 'REACT_APP_FIREBASE_'],
     build: {
    cssMinify: false,
  }
})
