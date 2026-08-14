# Chromium sandbox inside the container

The playtest browser executes **untrusted generated game code**, so the image
keeps Chromium's namespace sandbox ON by default and runs everything as the
non-root `agent` user. At startup, `start.sh` probes whether the sandbox can
actually start and refuses to boot if it can't (so `/health` never lies).

## Why the probe can fail

Chromium's user-namespace sandbox calls `clone(CLONE_NEWUSER)`. Docker's
default seccomp profile blocks that for unprivileged processes, and some hosts
also set `kernel.unprivileged_userns_clone=0`.

## Options, in order of preference

1. **Allow unprivileged user namespaces (recommended)**
   - Plain Docker: run with a seccomp profile that permits `clone`/`unshare`
     with `CLONE_NEWUSER`, e.g. Docker ≥ 24 default profile already allows it
     when the kernel does; otherwise:
     `docker run --security-opt seccomp=unconfined ...` (broad) or a scoped
     profile based on Docker's default with `clone`, `unshare`, `setns` allowed.
   - Host kernel: `sysctl kernel.unprivileged_userns_clone=1` (Debian/older).

2. **Explicitly accepted fallback: `ALLOW_NO_SANDBOX=1`**
   On platforms where you cannot change seccomp/sysctls (RunPod templates do
   not expose `--security-opt`), set the env var `ALLOW_NO_SANDBOX=1`. Startup
   then continues with `--no-sandbox` and logs a clear warning.
   Remaining mitigations still in place:
   - the whole process tree runs as the unprivileged `agent` user (no root),
   - the playtest browser context blocks ALL network egress except the
     game's own loopback QA server (metadata/internal endpoints included),
   - generated code is confined to its per-job workspace (symlink-safe paths,
     no arbitrary command execution, scrubbed env),
   - the API key is never exposed to game code (sandboxed iframe + short-lived
     tokens).

If neither option is configured and the sandbox can't start, the container
exits with a clear error instead of reporting healthy.
