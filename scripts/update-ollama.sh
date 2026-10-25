#!/usr/bin/env bash
# Computes the checksums for an Ollama release and the digests of the pinned models, and
# writes them to pins/, so upgrading what runs in users' repositories is a deliberate commit.
#
# Usage: bash scripts/update-ollama.sh <version>
#
# For each Linux archive (amd64 and arm64), the checksum must agree in three places: Ollama's
# own sha256sum.txt, the digest GitHub computed for the release asset, and the SHA-256 of the
# archive downloaded here (about 1.5 GB each). The script also records the SHA-256 of every
# file the install uses (scripts/archive-hashes.js, which needs Node.js 22.15 or later), so a
# cached install is checked file by file. Then set OLLAMA_VERSION in action.yml to the new
# version, review the diff, and commit.
#
# Model digests are the SHA-256 of each model's manifest on registry.ollama.ai, which is what
# the Ollama server reports in /api/tags. ollama.com shows the first 12 characters on each
# model's tags page, so you can compare them there.
set -euo pipefail

version="${1:?Usage: update-ollama.sh <version>}"
version="${version#v}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "https://github.com/ollama/ollama/releases/download/v$version/sha256sum.txt" -o "$work/sha256sum.txt"
curl -fsSL "https://api.github.com/repos/ollama/ollama/releases/tags/v$version" -o "$work/release.json"

entries=""
for arch in amd64 arm64; do
  file="ollama-linux-$arch.tar.zst"
  published=$(awk -v f="./$file" -v g="$file" '$2 == f || $2 == g { print $1 }' "$work/sha256sum.txt")
  asset=$(node -e '
    const r = require(process.argv[1]);
    const a = r.assets.find((x) => x.name === process.argv[2]);
    process.stdout.write(a && a.digest ? a.digest.replace(/^sha256:/, "") : "");
  ' "$work/release.json" "$file")
  if [ -z "$published" ] || [ -z "$asset" ]; then
    echo "Release v$version has no $file with a published checksum." >&2
    exit 1
  fi
  if [ "$published" != "$asset" ]; then
    echo "sha256sum.txt and GitHub disagree about $file: $published and $asset." >&2
    exit 1
  fi
  echo "Downloading $file to compute its checksum and its files' hashes..."
  curl -fsSL "https://github.com/ollama/ollama/releases/download/v$version/$file" -o "$work/$file"
  computed=$(sha256sum "$work/$file" | cut -c1-64)
  if [ "$computed" != "$published" ]; then
    echo "The downloaded $file has SHA-256 $computed, not the published $published." >&2
    exit 1
  fi
  node "$root/scripts/archive-hashes.js" "$work/$file" > "$work/$arch.json"
  rm -f "$work/$file"
  echo "$file: $published"
  entries="$entries $arch=$file=$published"
done

node -e '
  const fs = require("fs");
  const [file, work, version, ...entries] = process.argv.slice(1);
  const pins = JSON.parse(fs.readFileSync(file, "utf8"));
  pins[version] = {};
  for (const entry of entries) {
    const [arch, name, sha256] = entry.split("=");
    const contents = JSON.parse(fs.readFileSync(`${work}/${arch}.json`, "utf8"));
    pins[version][arch] = { file: name, sha256, files: contents.files, links: contents.links };
  }
  fs.writeFileSync(file, JSON.stringify(pins, null, 2) + "\n");
' "$root/pins/ollama.json" "$work" "$version" $entries
echo "Wrote the checksums for Ollama $version to pins/ollama.json."

# The pinned models, from the registry.
node -e '
  const fs = require("fs");
  const crypto = require("crypto");
  const file = process.argv[1];
  const pins = JSON.parse(fs.readFileSync(file, "utf8"));
  (async () => {
    for (const name of Object.keys(pins)) {
      const [model, tag] = name.split(":");
      const url = `https://registry.ollama.ai/v2/library/${model}/manifests/${tag}`;
      const response = await fetch(url, { headers: { accept: "application/vnd.docker.distribution.manifest.v2+json" } });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const digest = "sha256:" + crypto.createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
      if (digest !== pins[name]) console.log(`${name}: ${pins[name]} -> ${digest}`);
      else console.log(`${name}: unchanged, ${digest}`);
      pins[name] = digest;
    }
    fs.writeFileSync(file, JSON.stringify(pins, null, 2) + "\n");
  })().catch((err) => { console.error(err.message); process.exit(1); });
' "$root/pins/models.json"

echo
echo "Now set OLLAMA_VERSION to $version in action.yml, review git diff, and commit."
