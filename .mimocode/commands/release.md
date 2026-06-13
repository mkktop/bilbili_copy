---
description: "Bump version in all 3 files, commit, tag, and push. Usage: /release <version> (e.g. 0.4.4)"
---

# Version Bump + Release

Bump the project version from the current value to `$ARGUMENTS`, then commit, tag, and push.

## Steps

1. **Verify current version** — read the version from all three files and confirm they match:
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package].version`
   - `src-tauri/tauri.conf.json` → `"version"`

2. **If `$ARGUMENTS` is empty**, ask the user what version to bump to.

3. **Update all three files** — use Edit to replace the old version string with `$ARGUMENTS` in each file. The patterns are:
   - `package.json`: `"version": "OLD"` → `"version": "NEW"`
   - `src-tauri/Cargo.toml`: `version = "OLD"` → `version = "NEW"`
   - `src-tauri/tauri.conf.json`: `"version": "OLD"` → `"version": "NEW"`

4. **Verify** — grep all three files to confirm the new version is present.

5. **Commit** — `git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json && git commit -m "chore: version bump to $ARGUMENTS"`

6. **Tag** — `git tag v$ARGUMENTS`

7. **Push** — `git push origin master v$ARGUMENTS`

## Important

- Do NOT modify any other files during this flow.
- If there are uncommitted changes in other files, warn the user and abort.
- The three-file sync is critical — never skip one.
- If the tag already exists, warn the user before overwriting.
