#!/usr/bin/env bash
# Upkeep for the pinned upstream GLANCE apps and Vikunja.
#
#   scripts/upstream.sh status            what is pinned vs the latest upstream release
#   scripts/upstream.sh bump <name> [tag] move one component (default: latest release),
#                                         update the compose/.env tags, re-vendor the
#                                         dayGLANCE model if needed, run the tests
#   scripts/upstream.sh verify            fail if submodule pin, compose image tag and
#                                         .env.example disagree (CI runs this)
#
# <name> is one of: dayglance lastglance lifeglance vikunja
#
# Nothing here forks anything: the stack runs the upstream ghcr images; the
# submodules are the reference source for the pinned version (and, for dayGLANCE,
# the source the MCP model is vendored from).

set -euo pipefail
cd "$(dirname "$0")/.."

# name|submodule path|github repo|compose/.env variable|ghcr image repo
COMPONENTS=(
  "dayglance|apps/dayglance|krelltunez/dayglance|DAYGLANCE_IMAGE_TAG|krelltunez/dayglance"
  "lastglance|apps/lastglance|krelltunez/lastglance|LASTGLANCE_IMAGE_TAG|krelltunez/lastglance"
  "lifeglance|apps/lifeglance|krelltunez/lifeglance|LIFEGLANCE_IMAGE_TAG|krelltunez/lifeglance"
  "vikunja|services/vikunja|go-vikunja/vikunja|VIKUNJA_IMAGE_TAG|go-vikunja/vikunja"
)

field() { echo "$1" | cut -d'|' -f"$2"; }
find_component() { for c in "${COMPONENTS[@]}"; do [[ "$(field "$c" 1)" == "$1" ]] && { echo "$c"; return; }; done; return 1; }

# Latest stable release tag (vX.Y.Z only; ignores pre-releases and odd tags like "vue3").
latest_tag() {
  git ls-remote --tags --refs "https://github.com/$1" \
    | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
}

pinned_tag() { # tag the submodule is checked out at ("?" if it is not exactly on a tag)
  git -C "$1" describe --tags --exact-match 2>/dev/null || echo "?"
}

compose_tag() { # default tag in docker-compose.yml: ${VAR:-x.y.z}
  grep -oE "\\\$\{$1:-[^}]+\}" docker-compose.yml | head -1 | sed -E 's/.*:-([^}]+)\}/\1/'
}

env_tag() { grep -E "^$1=" gateway/.env.example | head -1 | cut -d= -f2; }

image_exists() { # does ghcr.io/<repo>:<tag> exist (tag without leading v)?
  local tok code
  tok=$(curl -fsS "https://ghcr.io/token?scope=repository:$1:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/') || return 2
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json' \
    "https://ghcr.io/v2/$1/manifests/$2")
  [[ "$code" == 200 ]]
}

cmd_status() {
  printf '%-11s %-9s %-9s %-9s %s\n' component pinned compose latest status
  local behind=0
  for c in "${COMPONENTS[@]}"; do
    local name path repo var; name=$(field "$c" 1); path=$(field "$c" 2); repo=$(field "$c" 3); var=$(field "$c" 4)
    local pin latest ctag state="ok"
    pin=$(pinned_tag "$path"); latest=$(latest_tag "$repo"); ctag=$(compose_tag "$var")
    [[ "$pin" != "v$ctag" ]] && state="DRIFT (pin vs compose)"
    if [[ "$state" == ok && "$pin" != "$latest" ]]; then state="update available"; behind=1; fi
    printf '%-11s %-9s %-9s %-9s %s\n' "$name" "$pin" "v$ctag" "$latest" "$state"
  done
  return $behind
}

cmd_verify() {
  local bad=0
  for c in "${COMPONENTS[@]}"; do
    local name path var; name=$(field "$c" 1); path=$(field "$c" 2); var=$(field "$c" 4)
    local pin ctag etag; pin=$(pinned_tag "$path"); ctag=$(compose_tag "$var"); etag=$(env_tag "$var")
    if [[ "$pin" != "v$ctag" || "$ctag" != "$etag" ]]; then
      echo "DRIFT $name: submodule=$pin compose=v$ctag .env.example=v$etag" >&2; bad=1
    fi
  done
  [[ $bad == 0 ]] && echo "versions consistent"
  return $bad
}

cmd_bump() {
  local name=${1:?usage: bump <name> [tag]}; local c; c=$(find_component "$name") || { echo "unknown component: $name" >&2; exit 2; }
  local path repo var image; path=$(field "$c" 2); repo=$(field "$c" 3); var=$(field "$c" 4); image=$(field "$c" 5)
  local tag=${2:-$(latest_tag "$repo")}; [[ "$tag" == v* ]] || tag="v$tag"
  local ver=${tag#v}

  echo "==> $name: $(pinned_tag "$path") -> $tag"
  if ! image_exists "$image" "$ver"; then
    echo "ghcr.io/$image:$ver does not exist (yet); refusing to bump compose to a missing image." >&2; exit 1
  fi

  git submodule update --init --depth 1 "$path" >/dev/null 2>&1 || true
  git -C "$path" fetch -q --depth 1 origin tag "$tag"
  git -C "$path" checkout -q "$tag"

  sed -i -E "s/(\\\$\{$var:-)[^}]+(\})/\1$ver\2/" docker-compose.yml
  sed -i -E "s/^($var=).*/\1$ver/" gateway/.env.example

  if [[ "$name" == dayglance ]]; then
    echo "==> re-vendoring the dayGLANCE model"
    (cd gateway/container-mcp && node scripts/vendor-model.mjs)
  fi

  echo "==> tests"
  (cd gateway && node --test 2>&1 | grep -E '^# (pass|fail)')
  (cd gateway/container-mcp && { [[ -d node_modules ]] || npm install --no-audit --no-fund >/dev/null; } && node --test 2>&1 | grep -E '^# (pass|fail)')

  cat <<EOF

Bumped $name to $tag. Next:
  1. git diff --stat            (review: submodule pointer, compose/.env tags$( [[ $name == dayglance ]] && echo ", vendored model"))
  2. Re-run the live checks that touch $name (see README "Upkeep") before merging.
  3. git add -A && git commit -m "Bump $name to $tag"
EOF
}

case "${1:-status}" in
  status) cmd_status ;;
  verify) cmd_verify ;;
  bump)   shift; cmd_bump "$@" ;;
  *) sed -n 2,16p "$0"; exit 2 ;;
esac
