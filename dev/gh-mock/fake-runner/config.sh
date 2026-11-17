#!/bin/sh
# Stand-in for the GitHub Actions runner's config.sh (test lab only): registers with the fake GitHub.
set -e
cd "$(dirname "$0")"
if [ "$1" = remove ]; then
  shift; TOKEN=''; while [ $# -gt 0 ]; do [ "$1" = --token ] && TOKEN=$2; shift; done
  BASE=$(sed -n 's/^url=//p' .runner | sed -E 's#^(https?://[^/]+)/.*#\1#'); NAME=$(sed -n 's/^name=//p' .runner); REPO=$(sed -n 's/^repo=//p' .runner)
  curl -fsS -X POST "$BASE/__runner/remove" -H 'Content-Type: application/json' -d "{\"repo\":\"$REPO\",\"name\":\"$NAME\",\"token\":\"$TOKEN\"}" >/dev/null
  rm -f .runner; echo "Runner removed"; exit 0
fi
URL=''; TOKEN=''; NAME=''; LABELS=''
while [ $# -gt 0 ]; do
  case "$1" in --url) URL=$2; shift ;; --token) TOKEN=$2; shift ;; --name) NAME=$2; shift ;; --labels) LABELS=$2; shift ;; esac
  shift
done
[ -n "$URL" ] && [ -n "$TOKEN" ] || { echo "config.sh: --url and --token are required" >&2; exit 1; }
BASE=$(echo "$URL" | sed -E 's#^(https?://[^/]+)/.*#\1#'); REPO=$(echo "$URL" | sed -E 's#^https?://[^/]+/##')
curl -fsS -X POST "$BASE/__runner/register" -H 'Content-Type: application/json' \
  -d "{\"repo\":\"$REPO\",\"name\":\"$NAME\",\"labels\":\"$LABELS\",\"token\":\"$TOKEN\",\"user\":\"$(id -un)\"}" >/dev/null
printf 'url=%s\nname=%s\nrepo=%s\nlabels=%s\n' "$URL" "$NAME" "$REPO" "$LABELS" > .runner
echo "√ Runner $NAME registered ($LABELS)"
