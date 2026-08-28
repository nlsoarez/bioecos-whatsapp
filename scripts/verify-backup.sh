#!/bin/sh
set -eu

encrypted_file=${1:?Uso: verify-backup.sh /backups/bioecos-AAAAMMDD.dump.gpg}
checksum_file="${encrypted_file}.sha256"
temporary_file=$(mktemp /tmp/bioecos-restore.XXXXXX.dump)
trap 'rm -f "$temporary_file"' EXIT

test -n "${BACKUP_ENCRYPTION_KEY:-}" || { echo "BACKUP_ENCRYPTION_KEY não definida" >&2; exit 1; }
test -f "$checksum_file" || { echo "Checksum não encontrado: $checksum_file" >&2; exit 1; }

(cd "$(dirname "$encrypted_file")" && sha256sum -c "$(basename "$checksum_file")")
mkdir -p "${GNUPGHOME:-/tmp/gnupg}" && chmod 700 "${GNUPGHOME:-/tmp/gnupg}"
printf '%s' "$BACKUP_ENCRYPTION_KEY" | gpg --batch --yes --pinentry-mode loopback \
  --passphrase-fd 0 --decrypt --output "$temporary_file" "$encrypted_file"
pg_restore --list "$temporary_file" >/dev/null
echo "Backup íntegro e descriptografável: $encrypted_file"
