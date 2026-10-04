# T-181 Usage UI red control

The unchanged `zcode/packages/desktop/scripts/verify-zaicode-usage.cjs` ran
against the existing pre-refinement packaged executable at
`zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe`.

Command:

```
node packages/desktop/scripts/verify-zaicode-usage.cjs packages/desktop/dist-next/win-unpacked/ZAICODE.exe
```

Exit: 1. Live router metrics loaded through the existing desktop bridge;
no renderer errors were recorded. The UUID-absence assertion then failed
because both Active requests and Recent requests displayed raw opaque provider
IDs. This proves the UI oracle detects the original SRC-120 defect.
The isolated test profile is project-local; no tasks were dispatched and no
router mutations were requested. The later green run must use the same oracle.
