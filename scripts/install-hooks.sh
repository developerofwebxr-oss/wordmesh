#!/usr/bin/env bash
# install-hooks.sh — enable the local pre-commit hygiene check for this clone.
# Bypassable (git commit --no-verify) and per-clone only; CI is the real gate.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
hook="$root/.git/hooks/pre-commit"
cat > "$hook" <<'EOF'
#!/bin/sh
# WordMesh: block strategy docs / secrets from being committed (scripts/hygiene-check.sh)
exec "$(git rev-parse --show-toplevel)/scripts/hygiene-check.sh" --staged
EOF
chmod +x "$hook" "$root/scripts/hygiene-check.sh"
echo "pre-commit hygiene hook installed at $hook"
