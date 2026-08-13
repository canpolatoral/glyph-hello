# Type declarations for modules you import

Put `*.d.ts` files here to give the type-checker types for the npm packages and
Node builtins you import. Anything matching `.types/**/*.d.ts` is auto-discovered
when you build. For a worked example, see
<https://github.com/chadetov/glyph/blob/main/docs/guide/external-imports.md>.

Module declarations only. A `declare var`, `declare function` or `declare class`
here is a global, and Glyph resolves names from modules, so the global satisfies
`tsc` and stays invisible to Glyph: using it is `[E0103] unresolved name`. A host
global the standard library does not wrap is a gap in the standard library, so
file it and it gets a typed wrapper the way timers and WebSocket did.
