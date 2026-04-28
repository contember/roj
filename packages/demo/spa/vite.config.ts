import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
	root: __dirname,
	plugins: [
		tsconfigPaths(),
		react(),
		tailwindcss(),
	],
	resolve: {
		dedupe: ['react', 'react-dom'],
	},
	server: {
		port: 2487,
	},
	build: {
		outDir: 'dist',
	},
})
