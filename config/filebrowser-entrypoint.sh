#!/bin/sh
set -e

CONFIG_FILE="/defaults/settings.json"
DATABASE_FILE="/database/filebrowser.db"

# One-time provisioning: creates the initial admin user from .env so the
# first visitor of the registry page cannot claim the account. This matters
# because filebrowser is exposed publicly through the Tailscale Funnel.
if [ ! -f "${DATABASE_FILE}" ] && [ -n "${FILEBROWSER_ADMIN_PASSWORD}" ]; then
  echo "Provisioning filebrowser admin user (one-time)..."
  filebrowser --config "${CONFIG_FILE}" users add \
    "${FILEBROWSER_ADMIN_USER:-admin}" "${FILEBROWSER_ADMIN_PASSWORD}" --perm.admin
fi

exec filebrowser --config "${CONFIG_FILE}"
