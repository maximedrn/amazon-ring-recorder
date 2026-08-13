#!/bin/sh
set -e

AUTH_FILE="${NTFY_AUTH_FILE:-/var/lib/ntfy/user.db}"
MARKER_FILE="/var/lib/ntfy/.provisioned"

# One-time provisioning: creates the admin and recorder users plus the
# write-only ACL on the notification topic, from plain .env passwords.
# Nothing to run manually after deployment.
if [ ! -f "${MARKER_FILE}" ]; then
  if [ -z "${NTFY_ADMIN_PASSWORD}" ] || [ -z "${NTFY_PASSWORD}" ]; then
    echo "ERROR: NTFY_ADMIN_PASSWORD and NTFY_PASSWORD must be set in .env" >&2
    exit 1
  fi

  # ntfy CLI commands require the auth database to exist, which only happens
  # after the server has started once. Boot a short-lived server (random
  # local port) to create it, then stop it.
  ntfy serve --listen-http=127.0.0.1:1973 &
  SERVER_PID=$!
  trap 'kill "${SERVER_PID}" 2>/dev/null || true' EXIT

  TRIES=0
  until [ -s "${AUTH_FILE}" ] || [ "${TRIES}" -ge 20 ]; do
    sleep 0.5
    TRIES=$((TRIES + 1))
  done

  kill "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
  trap - EXIT
  sleep 1

  if [ ! -s "${AUTH_FILE}" ]; then
    echo "ERROR: ntfy auth database was not created (${AUTH_FILE})." >&2
    exit 1
  fi

  echo "Provisioning ntfy users (one-time)..."
  NTFY_PASSWORD="${NTFY_ADMIN_PASSWORD}" \
    ntfy user add --role=admin --ignore-exists "${NTFY_ADMIN_USER:-admin}"
  NTFY_PASSWORD="${NTFY_PASSWORD}" \
    ntfy user add --ignore-exists "${NTFY_USER:-recorder}"
  ntfy access "${NTFY_USER:-recorder}" "${NTFY_TOPIC:-recordings}" read-write

  touch "${MARKER_FILE}"
  echo "ntfy provisioning complete."
fi

exec ntfy serve "$@"