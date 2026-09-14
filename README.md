# WordMesh

A walkable WebXR (Three.js) 3D mesh of the Superhero.com / æternity word-token
economy — one static `index.html`, served by GitHub Pages at
https://developerofwebxr-oss.github.io/wordmesh/ . The presence/tip relay lives
in `server/`.

## Contributing: this repo is public

Never commit strategy documents or secrets. Every deploy first runs
`scripts/hygiene-check.sh --all`, which fails on forbidden filenames, listed
terms in docs (`.hygiene-terms`) and secret patterns (`.hygiene-secrets`).

Catch problems before they're committed by enabling the same check as a local
pre-commit hook (once per clone):

    scripts/install-hooks.sh

Evidence screenshots for a version: `npm run capture-evidence` (needs Google Chrome + python3; writes `evidence/<tag or sha>/`, see `evidence/INDEX.md`).

The hook is a convenience and can be bypassed (`git commit --no-verify`); the CI
job is the real gate. Private scratch goes in `_drafts/` or `_private/` (gitignored).
