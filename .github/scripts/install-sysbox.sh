#!/usr/bin/env bash
# Install Nestybox sysbox-ce on a GHA `ubuntu-24.04` runner and verify the
# `sysbox-runc` runtime is registered with Docker. Pinned URL + SHA256 so
# bumping sysbox is "edit version + recompute SHA"; runtime registration
# is the postcondition that gates the rest of the sysbox-e2e workflow.
#
# The `sysbox-ce` postinst stops Docker, registers `sysbox-runc`, then
# restarts Docker. On busy runners, `sysbox-mgr` (a `Wants=` dep of
# `sysbox.service`) starts before Docker is fully ready, fails its
# readiness probe, and `sysbox.service` then fails with the unhelpful
# "Dependency failed" — with no detail under `journalctl -u sysbox`
# because the dep unit's logs aren't covered by that filter. Two
# mitigations: (1) wait for Docker before checking sysbox; (2) on first
# failure, restart the dep units once and re-check; (3) widen the journal
# filter to all four units on hard failure so the actual cause is visible.

set -euo pipefail

readonly SYSBOX_VERSION="0.7.0"
readonly SYSBOX_URL="https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb"
readonly SYSBOX_SHA256="eeff273671467b8fa351ab3d40709759462dc03d9f7b50a1b207b37982ce40a9"

echo "::group::Download + install sysbox-ce ${SYSBOX_VERSION}"
curl -fsSL "${SYSBOX_URL}" -o /tmp/sysbox.deb
echo "${SYSBOX_SHA256} /tmp/sysbox.deb" | sha256sum -c -
sudo apt-get install -y /tmp/sysbox.deb
echo "::endgroup::"

echo "::group::Wait for Docker to come back after postinst restart"
for _ in $(seq 1 30); do
  sudo systemctl is-active --quiet docker && break
  sleep 1
done
sudo systemctl is-active --quiet docker || {
  echo "::error::docker did not come back after sysbox postinst" >&2
  exit 1
}
echo "::endgroup::"

if ! sudo systemctl is-active --quiet sysbox; then
  echo "::group::sysbox inactive after install — likely postinst race with Docker, retrying"
  sudo systemctl restart sysbox-mgr sysbox-fs sysbox || true
  sleep 2
  echo "::endgroup::"
fi

if ! sudo systemctl is-active --quiet sysbox; then
  echo "::error::sysbox still inactive after retry"
  # Widen the journal filter to all relevant units so the actual cause is
  # visible (the original `-u sysbox` only captured the dep-failure
  # summary, never the underlying sysbox-mgr / sysbox-fs error).
  sudo journalctl -u sysbox -u sysbox-mgr -u sysbox-fs -u docker \
    --no-pager -n 200
  exit 1
fi

docker info --format '{{json .Runtimes}}' | grep -q sysbox-runc || {
  docker info
  echo "::error::sysbox-runc not registered with Docker" >&2
  exit 1
}

echo "sysbox ${SYSBOX_VERSION} active; sysbox-runc registered with Docker"
