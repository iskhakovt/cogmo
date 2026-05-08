// Bake definition for the three Cogmo-owned container images.
//
//   - cogmo          — the runtime app image (root Dockerfile, semver-tagged)
//   - cogmo-devbase  — task base image for coding-delegation (slice-tagged)
//   - cogmo-skills   — task base image for tier-2 sysbox skills (slice-tagged)
//
// Each image has its own GitHub Actions workflow that drives the build:
// `publish.yml`, `devbase.yml`, `skills.yml`. The workflows share this file
// so target structure, cache config, and platform pins live in one place;
// per-target tags + labels arrive at runtime via `metadata-action`'s
// `bake-target: docker-metadata-action` integration. See
// https://docs.docker.com/build/bake/ for the file reference.

variable "REGISTRY" {
  default = "ghcr.io/iskhakovt"
}

// Default group builds every image — useful for local "build everything"
// runs (`docker buildx bake`). CI workflows always pass `--targets <one>` to
// build exactly the image whose paths changed.
group "default" {
  targets = ["cogmo", "devbase", "skills"]
}

// Empty target the metadata-action populates per-workflow with `tags`,
// `labels`, `annotations`. Each target below inherits from this so the
// workflow's metadata wins over local defaults.
target "docker-metadata-action" {}

target "_common" {
  platforms = ["linux/amd64"]
}

target "cogmo" {
  inherits   = ["_common", "docker-metadata-action"]
  context    = "."
  dockerfile = "Dockerfile"
  tags       = ["${REGISTRY}/cogmo:dev"]
  cache-from = ["type=gha,scope=cogmo"]
  cache-to   = ["type=gha,mode=max,scope=cogmo"]
  args = {
    VERSION = "dev"
  }
  attest = [
    "type=provenance,mode=max",
    "type=sbom",
  ]
}

target "devbase" {
  inherits   = ["_common", "docker-metadata-action"]
  context    = "./images/devbase"
  dockerfile = "Dockerfile"
  tags       = ["${REGISTRY}/cogmo-devbase:dev"]
  cache-from = ["type=gha,scope=devbase"]
  cache-to   = ["type=gha,mode=max,scope=devbase"]
  attest = [
    "type=provenance,mode=max",
    "type=sbom",
  ]
}

target "skills" {
  inherits   = ["_common", "docker-metadata-action"]
  context    = "./images/skills"
  dockerfile = "Dockerfile"
  tags       = ["${REGISTRY}/cogmo-skills:dev"]
  cache-from = ["type=gha,scope=skills"]
  cache-to   = ["type=gha,mode=max,scope=skills"]
  attest = [
    "type=provenance,mode=max",
    "type=sbom",
  ]
}
