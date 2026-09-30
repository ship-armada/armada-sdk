// ABOUTME: Vite config for the XC-2 browser-build repro consumer.
// ABOUTME: Output goes to out/ (not committed).
export default { logLevel: 'warn', build: { outDir: 'out', rollupOptions: { external: ['snarkjs'] }, chunkSizeWarningLimit: 100000 } };
