#!/usr/bin/env bash
# Packs the extension.
#
#   ./build.sh            -> dist/alarma-recordatorio@galianet.es.shell-extension.zip
#   ./build.sh --install  -> also installs it for the current user
#   ./build.sh --upload   -> also uploads it to extensions.gnome.org (asks for the password)
#
# Needs gnome-extensions (gnome-shell) and msgfmt (gettext package).
set -euo pipefail
cd "$(dirname "$0")"

UUID="alarma-recordatorio@galianet.es"
ZIP="dist/${UUID}.shell-extension.zip"
EGO_USER="GalianetWebs"

mkdir -p dist
gnome-extensions pack src \
    --force \
    --out-dir=dist \
    --podir=../po \
    --extra-source=controller.js \
    --extra-source=indicator.js \
    --extra-source=reminder.js \
    --extra-source=utils.js \
    --extra-source=icons

echo "Package: ${ZIP}"

case "${1:-}" in
--install)
    gnome-extensions install --force "${ZIP}"
    echo "Installed. On Wayland, log out and back in, then:"
    echo "  gnome-extensions enable ${UUID}"
    ;;
--upload)
    gnome-extensions upload --accept-tos --user "${EGO_USER}" "${ZIP}"
    ;;
esac
