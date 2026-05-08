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
//   - publish.yml on release: VERSION=<dunamai>, no overrides — full prod
//     defaults (multi-arch for cogmo, single-arch for devbase/skills,
//     attestations on, all caches written).
//   - images-pr-check.yml on PR: bake verify-only (no push), overrides
//     cogmo to amd64-only + amd64-only cache scope so PR cost stays low.
//   - sysbox-e2e.yml: VERSION=test, --load skills, WITH_ATTEST=false. No
//     platform override needed (skills is already amd64-only by default).
//   - Local: `docker buildx bake skills` builds with default tag :dev.
//     For fast amd64-only on cogmo locally, override the same as PR check.

variable "REGISTRY" {
  default = "ghcr.io/iskhakovt"
}

variable "VERSION" {
  default = "dev"
}

// Provenance + SBOM produce extra entries in an OCI manifest list. The
// Docker daemon's `--load` exporter can't import manifest lists, so the
// build→test path in sysbox-e2e disables attestations by exporting
// `WITH_ATTEST=false`. Release builds leave the default in place and ship
// full supply-chain attestations.
variable "WITH_ATTEST" {
  default = "true"
}

// Default group builds every image — used by publish.yml on release and by
// images-pr-check.yml for verify. Per-image targeting (`--targets skills`)
// is for the sysbox-e2e build→test loop.
group "default" {
  targets = ["cogmo", "devbase", "skills"]
}

target "_common" {
  // Multi-arch is the production default. Apple Silicon dev machines plus
  // Graviton / Ampere / Hetzner CAX cloud consumers all pull the right
  // layer transparently. devbase and skills override to amd64-only below
  // because sysbox itself is amd64-only today; flip when sysbox grows
  // arm64 support.
  platforms = ["linux/amd64", "linux/arm64"]
  attest = WITH_ATTEST == "true" ? [
    "type=provenance,mode=max",
    "type=sbom",
  ] : []
}

target "cogmo" {
  inherits   = ["_common"]
  context    = "."
  dockerfile = "Dockerfile"
  tags       = ["${REGISTRY}/cogmo:${VERSION}"]
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
  inherits   = ["_common"]
  context    = "./images/devbase"
  dockerfile = "Dockerfile"
  tags       = ["${REGISTRY}/cogmo-devbase:${VERSION}"]
  // Sysbox amd64-only today — see _common comment. Single-platform cache
  // scope matches the platform.
  platforms  = ["linux/amd64"]
  cache-from = ["type=gha,scope=devbase-amd64"]
  cache-to   = ["type=gha,scope=devbase-amd64,mode=max"]
}

target "skills" {
  inherits   = ["_common"]
  context    = "./images/skills"
  dockerfile = "Dockerfile"
  tags       = ["${REGISTRY}/cogmo-skills:${VERSION}"]
  platforms  = ["linux/amd64"]
  cache-from = ["type=gha,scope=skills-amd64"]
  cache-to   = ["type=gha,scope=skills-amd64,mode=max"]
}
