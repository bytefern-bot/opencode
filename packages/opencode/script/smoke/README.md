# Smoke Scripts

Small, focused scripts for testing one module without starting the full opencode service.

Run scripts from `packages/opencode` so package imports and tsconfig path aliases resolve consistently.

```sh
bun run --conditions=browser script/smoke/codesearch.ts --help
```
