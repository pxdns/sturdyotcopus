#!/usr/bin/env bash
# Entry point of the runner container: set up git/gh with the user's GitHub token, clone the repository if asked, open a shell.
set -u
cd /work || exit 1
git config --global credential.helper '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f'
git config --global --get user.name >/dev/null 2>&1 || git config --global user.name "${GITHUB_USER:-Luma user}"
git config --global --get user.email >/dev/null 2>&1 || git config --global user.email "${GITHUB_USER:-luma}@users.noreply.github.com"
export GH_TOKEN="${GITHUB_TOKEN:-}"
if [ -n "${LUMA_REPO:-}" ]; then
  name="${LUMA_REPO##*/}"
  if [ ! -d "$name/.git" ]; then
    echo "Cloning ${LUMA_REPO} ..."
    git clone ${LUMA_REF:+--branch "$LUMA_REF"} "https://github.com/${LUMA_REPO}.git" "$name" || echo "(clone failed; continuing in /work)"
  fi
  [ -d "$name" ] && cd "$name"
fi
echo "Luma runner - $(java -version 2>&1 | head -1) | node $(node -v) | $(python3 --version) | gradle $(gradle --version 2>/dev/null | awk '/^Gradle/{print $2}')"
exec bash -l
