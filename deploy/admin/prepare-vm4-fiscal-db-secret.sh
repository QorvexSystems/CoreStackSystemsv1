#!/usr/bin/env bash
# Store the existing PostgreSQL runtime password, not a new generated password.
# Operator-run on VM4; does not connect, enable LOGIN or change any container.
set +x
set -euo pipefail
umask 077
ulimit -c 0
readonly secret_dir='/opt/corestack/secrets'
readonly secret_file="$secret_dir/rivnu-fe-pre-postgresql.password"
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$EUID" -eq 0 && "$(hostname)" == CoreStackSystems-VM4-Billing ]] || fail 'Run personally with sudo on VM4.'
[[ ! -L "$secret_dir" && -d "$secret_dir" && "$(stat -c '%u:%g:%a' "$secret_dir")" == 0:0:700 ]] || fail 'Expected root:root 0700 secrets directory; no permissions changed.'
[[ ! -e "$secret_file" && ! -L "$secret_file" ]] || fail 'Secret already exists; no overwrite or rotation performed.'
[[ -t 0 && -t 1 ]] || fail 'Interactive terminal required. Do not pass passwords in arguments or environment.'
secret_temp=''
cleanup() {
  unset fiscal_password fiscal_confirmation
  if [[ -n "$secret_temp" ]]; then rm -f -- "$secret_temp"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Enter the SAME password already assigned to rivnu_fe_pre_runtime in VM3.\n'
IFS= read -r -s -p 'Existing fiscal DB password: ' fiscal_password; printf '\n'
IFS= read -r -s -p 'Repeat existing password: ' fiscal_confirmation; printf '\n'
[[ -n "$fiscal_password" && ${#fiscal_password} -le 4096 && "$fiscal_password" == "$fiscal_confirmation" ]] || fail 'Empty, too long or mismatching input; no secret created.'
[[ "$fiscal_password" != *$'\r'* ]] || fail 'Carriage return rejected; enter the password without line endings.'
unset fiscal_confirmation
secret_temp=$(mktemp "$secret_dir/.rivnu-fe-pre-password.XXXXXX")
# Raw bytes, no newline; never shell-evaluated, trimmed or put into a URL.
printf '%s' "$fiscal_password" > "$secret_temp"
unset fiscal_password
chown 1000:1000 "$secret_temp"
chmod 0400 "$secret_temp"
# Atomic no-clobber publication. Parent remains root-only; future mount is one file.
ln -- "$secret_temp" "$secret_file"
printf 'FISCAL_DB_SECRET_STORED\nSecret protected for UID 1000; value not displayed. No database or container changes.\n'
