// Bake definition for the three Cogmo-owned container images.
//
//   - cogmo          — the runtime app image (root Dockerfile)
//   - cogmo-devbase  — task base image for coding-delegation
//   - cogmo-skills   — task base image for tier-2 sysbox skills
//
// All three release together at the same `VERSION` (semver from
// semantic-release / dunamai). The runtime app baked from `cogmo:1.46.0`
// pulls `cogmo-devbase:1.46.0` and `cogmo-skills:1.46.0`. This keeps the
// "which image goes with which app build" question out of the deployment
// model — the answer is always "the same version".
//
// Build pipeline:
//   - publish.yml on release: VERSION=<dunamai>. Three `metadata-action`
//     calls (one per image) emit per-target bake-files with `tags` (semver
//     + `latest`) + OCI labels; bake-action layers them on top of this
//     file, so the empty `*-meta` stubs below populate at runtime.
//   - sysbox-e2e.yml: VERSION=test, --load skills. No platform override
//     needed (skills is already amd64-only by default).
//   - Local: `docker buildx bake skills` builds with default tag :dev.
//     For fast amd64-only on cogmo locally, override platform + cache
//     scope to amd64.
//
// Local-dev convention: the runtime defaults to `cogmo-{devbase,skills}:latest`
// when `process.env.VERSION` is unset (publish.yml pushes `:latest` alongside
// each release semver via metadata-action). Devs iterating on a Dockerfile
// override the runtime env (`COGMO_SKILLS_IMAGE=cogmo-skills:dev`) and bake
// the matching tag here.

variable "REGISTRY" {
  default = "ghcr.io/iskhakovt"
}

variable "VERSION" {
  default = "dev"
}

// Default group builds every image — used by publish.yml on release.
// Per-image targeting (`--targets skills`) is for the sysbox-e2e
// build→test loop.
group "default" {
  targets = ["cogmo", "devbase", "skills"]
}

// Per-image meta targets. publish.yml's three `metadata-action` calls each
// emit a JSON bake-file that redefines the corresponding `*-meta` with
// release tags + OCI labels; bake-action layers them on top of this file.
// Workflows without metadata-action (PR check, sysbox-e2e, local) fall
// through to these in-file fallback tags.
target "cogmo-meta" {
  tags = ["${REGISTRY}/cogmo:${VERSION}"]
}
target "devbase-meta" {
  tags = ["${REGISTRY}/cogmo-devbase:${VERSION}"]
}
target "skills-meta" {
  tags = ["${REGISTRY}/cogmo-skills:${VERSION}"]
}

target "_common" {
  // Multi-arch is the production default. Apple Silicon dev machines plus
  // Graviton / Ampere / Hetzner CAX cloud consumers all pull the right
  // layer transparently. devbase and skills override to amd64-only below
  // because sysbox itself is amd64-only today; flip when sysbox grows
  // arm64 support.
  platforms = ["linux/amd64", "linux/arm64"]
}

target "cogmo" {
  inherits   = ["_common", "cogmo-meta"]
  context    = "."
  dockerfile = "Dockerfile"
  args = {
    VERSION = "${VERSION}"
  }
  // Per-platform cache scopes — single buildx invocation on a single
  // runner needs split scopes to avoid moby/buildkit#2758 (last platform's
  // cache manifest overwrites the first's, so subsequent runs cache-miss).
  // Workflows that override platform must override these in lockstep so an
  // amd64-only build doesn't write amd64 layers into the arm64 scope.
  cache-from = [
    "type=gha,scope=cogmo-amd64",
    "type=gha,scope=cogmo-arm64",
  ]
  cache-to = [
    "type=gha,scope=cogmo-amd64,mode=max",
    "type=gha,scope=cogmo-arm64,mode=max",
  ]
}

target "devbase" {
  inherits   = ["_common", "devbase-meta"]
  context    = "./images/devbase"
  dockerfile = "Dockerfile"
  // Sysbox amd64-only today — see _common comment. Single-platform cache
  // scope matches the platform.
  platforms  = ["linux/amd64"]
  cache-from = ["type=gha,scope=devbase-amd64"]
  cache-to   = ["type=gha,scope=devbase-amd64,mode=max"]
}

target "skills" {
  inherits   = ["_common", "skills-meta"]
  context    = "./images/skills"
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64"]
  cache-from = ["type=gha,scope=skills-amd64"]
  cache-to   = ["type=gha,scope=skills-amd64,mode=max"]
}
