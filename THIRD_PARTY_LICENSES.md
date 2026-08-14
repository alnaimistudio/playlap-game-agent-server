# Third-Party Licenses

Direct dependencies of the Play Lap Game Agent Server (audited 2026-08-13
with `npm view <pkg> license`). All are permissive; no GPL/AGPL/SSPL anywhere
in the direct tree.

## Runtime (server)

| Package | Version | License | Notes |
|---|---|---|---|
| express | 4.x | MIT | HTTP server |
| zod | 3.x | MIT | request validation |
| playwright-core | 1.55.0 | Apache-2.0 | headless Chromium QA |
| phaser | 3.90.x | MIT | vendored into generated 2D games |
| babylonjs | 7.x | Apache-2.0 | vendored into generated 3D games |

## Dev / build

| Package | Version | License |
|---|---|---|
| typescript | 5.9.x | Apache-2.0 |
| tsx | 4.x | MIT |
| @types/express, @types/node | latest | MIT |

## Inside the Docker image

| Component | License | Notes |
|---|---|---|
| llama.cpp (`llama-server`) | MIT | local model runtime |
| Qwen3-Coder-30B-A3B-Instruct (weights, GGUF) | Apache-2.0 | downloaded at first boot to `/models`, not distributed in the image |
| Chromium (via Playwright) | BSD-3-Clause | QA browser |
| Node.js 20 | MIT | |
| nvidia/cuda base image | NVIDIA EULA | container base; does not affect generated games |

## Generated games

Generated games ship only `vendor/phaser.min.js` (MIT) or `vendor/babylon.js`
(Apache-2.0) plus original generated code and procedural assets — no license
obligations are imposed on Play Lap or its users. See LICENSE_NOTES.md for
the audit policy for future additions.
