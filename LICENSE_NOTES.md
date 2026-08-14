# License Notes

Goal: nothing in this server may impose a restrictive license (e.g. AGPL) on
the games it produces or on Play Lap.

## Decisions

- **No AGPL dependencies anywhere.** Audited the direct dependency tree
  (see THIRD_PARTY_LICENSES.md) — all runtime dependencies are MIT,
  Apache-2.0 or BSD.
- **game-creator (playableintelligence):** used as *inspiration only* (QA
  workflow ideas). No code or assets copied, so none of its transitive
  dependencies (including any AGPL-adjacent audio tooling) reach us or the
  generated games.
- **Audio:** generated games use procedural/Web Audio synthesis or no audio
  by default. We deliberately do NOT bundle audio libraries or sample packs;
  if audio assets are added later they must be CC0/CC-BY or original.
  (Play Lap already has a Kenney CC0 asset recipe if packs are wanted later.)
- **Game engines shipped into generated games:**
  - Phaser 3 — MIT → games are unencumbered.
  - Babylon.js — Apache-2.0 → games are unencumbered.
- **Model weights:** Qwen3-Coder-30B-A3B-Instruct — Apache-2.0. Output of the
  model is usable commercially.
- **llama.cpp** — MIT. **Playwright** — Apache-2.0. **Express/zod/etc.** — MIT.
- **Base image:** `nvidia/cuda` runtime image is distributed under the NVIDIA
  Deep Learning Container license/EULA — standard for GPU deployment, applies
  to the container, not to generated games.

## Rule for future dependencies

Before adding any dependency (server or generated-game side): check its
license with `npm view <pkg> license`. Allowed by default: MIT, Apache-2.0,
BSD-2/3, ISC, CC0. Anything copyleft (GPL/AGPL/SSPL) requires replacing with
a permissive alternative and documenting it here.
