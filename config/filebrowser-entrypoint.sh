#!/bin/sh
set -e

CONFIG_FILE="/defaults/settings.json"
DATABASE_FILE="/database/filebrowser.db"

# One-time provisioning: creates the initial admin user from .env so the
# first visitor of the registry page cannot claim the account. This matters
# because filebrowser is exposed publicly through the Tailscale Funnel.
# Also provisions the share-only account used by the recorder to create
# public, expiring video share links.
#
# Note: `config init` only boots a database with built-in defaults; the
# config file (port, address, root...) is applied by the server itself at
# runtime, so nothing else needs to be seeded here.
if [ ! -f "${DATABASE_FILE}" ] && [ -n "${FILEBROWSER_ADMIN_PASSWORD}" ]; then
  echo "Provisioning filebrowser users (one-time)..."

  filebrowser --config "${CONFIG_FILE}" config init

  filebrowser --config "${CONFIG_FILE}" users add \
    "${FILEBROWSER_ADMIN_USER:-admin}" "${FILEBROWSER_ADMIN_PASSWORD}" --perm.admin

  # The share account needs the `share` permission to create links and the
  # `download` permission so the public share page can stream the videos.
  # Default scope "." covers the whole recordings tree.
  if [ -n "${FILEBROWSER_SHARE_PASSWORD}" ]; then
    filebrowser --config "${CONFIG_FILE}" users add \
      "${FILEBROWSER_SHARE_USER:-share}" "${FILEBROWSER_SHARE_PASSWORD}" \
      --perm.share --perm.download
  fi
fi

exec filebrowser --config "${CONFIG_FILE}"
