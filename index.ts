/**
 * Root entrypoint for OpenCode's local plugin directory loader.
 * The actual plugin lives in src/plugin.ts (package.json "main" is not
 * honored for local plugin directories — a root-level entry is required).
 */
export { default } from "./src/plugin"
