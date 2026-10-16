// ABOUTME: Node-only entry for @armada/sdk (`@armada/sdk/node`) — adapters that need Node built-ins (`node:fs`), kept
// ABOUTME: off the browser entries so a browser bundle never has to resolve them.

export { FilesystemArtifactSource } from './filesystem-artifact-source';
export type { FilesystemArtifactSourceOptions } from './filesystem-artifact-source';
// Selective disclosure (ADR-0020) — load the compiled circuit artifacts from a local directory.
export { loadDisclosureArtifacts } from './disclosure-artifacts';
