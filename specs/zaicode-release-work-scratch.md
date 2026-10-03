# Release backup scratch

`.release-work/` holds preserved generated packages and their verification
receipts. It is local scratch, like `dist-release/`, rather than source input.
Git discovery and lint exclude this directory; source rules and all package
bytes remain unchanged. Verification runs the canonical lint gate before and
after this discovery change and retains the original failure as evidence.
