#!/usr/bin/env bash
# Store one fixed RIVNU route and token for the API. Does not modify api.env or restart it.
set -Eeuo pipefail
set +x
umask 077

readonly secret_root='/opt/corestack/apps/rivnu/secrets'
readonly destination="$secret_root/fiscal-range-registration"
readonly api_gid='1000'
readonly tenant='cmqn0r66a0002lit0vxbzq5l4'
readonly rnc='40220429126'
readonly expected_ca='AF:73:79:95:0A:C8:45:A0:86:FE:8A:52:6E:52:E7:B6:0E:C9:A8:E9:9F:79:5E:34:81:70:98:58:DF:2B:B4:37'
readonly source_ca=${1:-}

fail() { printf '%s\n' "$1" >&2; exit 1; }

validate_published_route() {
  local token
  [[ -d "$destination" && ! -L "$destination" && "$(stat -c '%u:%g:%a' "$destination")" == "0:$api_gid:2750" ]] || return 1
  for file in rivnu.token rivnu-ca.crt routes.json; do
    [[ -f "$destination/$file" && ! -L "$destination/$file" && -s "$destination/$file" && "$(stat -c '%u:%g:%a' "$destination/$file")" == "0:$api_gid:440" ]] || return 1
  done
  [[ "$(openssl x509 -in "$destination/rivnu-ca.crt" -noout -fingerprint -sha256 | cut -d= -f2)" == "$expected_ca" ]] || return 1
  cmp -s "$source_ca" "$destination/rivnu-ca.crt" || return 1
  token=$(<"$destination/rivnu.token")
  [[ "$token" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || return 1
  unset token
  cmp -s "$destination/routes.json" <(cat <<JSON
{
  "version": 1,
  "routes": [
    {
      "tenantId": "$tenant",
      "issuerRnc": "$rnc",
      "origin": "https://10.0.0.1:4083",
      "tokenFile": "/run/secrets/fiscal-range-registration/rivnu.token",
      "caFile": "/run/secrets/fiscal-range-registration/rivnu-ca.crt"
    }
  ]
}
JSON
  ) || return 1
}

[[ ${EUID:-$(id -u)} -eq 0 && "$(hostname)" == 'VM2-APP' ]] || fail 'RUN_WITH_SUDO_ON_VM2'
[[ $# == 1 && -f "$source_ca" && ! -L "$source_ca" ]] || fail 'SUPPLY_PUBLIC_INTERNAL_CA'
[[ -t 0 && -t 1 ]] || fail 'INTERACTIVE_TTY_REQUIRED'
[[ -d "$secret_root" && ! -L "$secret_root" ]] || fail 'APPLICATION_SECRET_ROOT_INVALID'
placeholder='false'
if [[ -e "$destination" || -L "$destination" ]]; then
  if validate_published_route; then
    printf '%s\n' 'RIVNU_API_RANGE_ROUTE_ALREADY_STORED_NOT_ACTIVATED'
    printf '%s\n' 'api.env and containers remain unchanged; no range, invoice or DGII request was created.'
    exit 0
  elif [[ -d "$destination" && ! -L "$destination" && "$(stat -c '%u:%g:%a' "$destination")" == '0:0:2755' ]]; then
    [[ -z "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'RANGE_ROUTE_DESTINATION_NOT_EMPTY'
    placeholder='true'
  else
    fail 'RANGE_ROUTE_DESTINATION_EXISTS_REVIEW_REQUIRED'
  fi
fi
[[ "$(openssl x509 -in "$source_ca" -noout -fingerprint -sha256 | cut -d= -f2)" == "$expected_ca" ]] || fail 'INTERNAL_CA_PIN_MISMATCH'
openssl x509 -in "$source_ca" -noout -checkend 31622400 || fail 'INTERNAL_CA_RENEWAL_REQUIRED'

first=''
second=''
read -r -s -p 'Mismo token base64url almacenado en VM4: ' first </dev/tty
printf '\n' >/dev/tty
read -r -s -p 'Repita exactamente el mismo token: ' second </dev/tty
printf '\n' >/dev/tty
[[ "$first" == "$second" ]] || fail 'TOKEN_CONFIRMATION_FAILED'
[[ "$first" =~ ^[A-Za-z0-9_-]{43,128}$ ]] || fail 'TOKEN_FORMAT_INVALID'

work=$(mktemp -d "$secret_root/.rivnu-range-route.XXXXXX")
cleanup() {
  unset first second
  rm -f -- "$work/token.input" "$work/publish/rivnu.token" "$work/publish/rivnu-ca.crt" "$work/publish/routes.json"
  rmdir -- "$work/publish" 2>/dev/null || true
  rmdir -- "$work" 2>/dev/null || true
}
trap cleanup EXIT
install -d -o root -g "$api_gid" -m 0750 "$work/publish"
printf %s "$first" >"$work/token.input"
unset first second
install -o root -g "$api_gid" -m 0440 "$work/token.input" "$work/publish/rivnu.token"
install -o root -g "$api_gid" -m 0440 "$source_ca" "$work/publish/rivnu-ca.crt"
cat >"$work/publish/routes.json" <<JSON
{
  "version": 1,
  "routes": [
    {
      "tenantId": "$tenant",
      "issuerRnc": "$rnc",
      "origin": "https://10.0.0.1:4083",
      "tokenFile": "/run/secrets/fiscal-range-registration/rivnu.token",
      "caFile": "/run/secrets/fiscal-range-registration/rivnu-ca.crt"
    }
  ]
}
JSON
chown root:"$api_gid" "$work/publish/routes.json"
chmod 0440 "$work/publish/routes.json"
for file in rivnu.token rivnu-ca.crt routes.json; do
  [[ "$(stat -c '%u:%g:%a' "$work/publish/$file")" == "0:$api_gid:440" && -s "$work/publish/$file" && ! -L "$work/publish/$file" ]] || fail 'RANGE_ROUTE_FILE_INVALID'
done
if [[ "$placeholder" == 'true' ]]; then
  [[ -d "$destination" && ! -L "$destination" && "$(stat -c '%u:%g:%a' "$destination")" == '0:0:2755' ]] || fail 'RANGE_ROUTE_PLACEHOLDER_CHANGED'
  [[ -z "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'RANGE_ROUTE_PLACEHOLDER_NOT_EMPTY'
  rmdir -- "$destination"
fi
mv -T "$work/publish" "$destination"
[[ "$(stat -c '%u:%g:%a' "$destination")" == "0:$api_gid:2750" ]] || fail 'PUBLISHED_RANGE_ROUTE_DIRECTORY_INVALID'
validate_published_route || fail 'PUBLISHED_RANGE_ROUTE_VALIDATION_FAILED'

printf '%s\n' 'RIVNU_API_RANGE_ROUTE_STORED_NOT_ACTIVATED'
printf '%s\n' 'api.env and containers were unchanged; no range, invoice or DGII request was created.'
