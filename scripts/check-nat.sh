#!/usr/bin/env bash
set -Eeuo pipefail

WAN_IP="${1:-${WAN_IP:-}}"
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 2; }
command -v ip >/dev/null || { echo 'iproute2 is required' >&2; exit 2; }

PUBLIC_IP="$(curl -4 --fail --silent --show-error --max-time 10 https://api.ipify.org)" || {
  echo 'Could not determine the public IPv4 address.' >&2
  exit 2
}
printf 'Public egress IPv4: %s\n' "$PUBLIC_IP"

in_cgnat() {
  local ip="$1" a b
  IFS=. read -r a b _ <<< "$ip"
  [[ "$a" == 100 && "$b" =~ ^(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])$ ]]
}

if [[ -n "$WAN_IP" ]]; then
  [[ "$WAN_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo 'Router WAN address must be IPv4.' >&2; exit 2; }
  printf 'Router WAN IPv4:   %s\n' "$WAN_IP"
  if in_cgnat "$WAN_IP"; then
    echo 'LIKELY CGNAT: router WAN address is in 100.64.0.0/10; inbound port forwarding will not work.'
    exit 2
  fi
  if [[ "$WAN_IP" != "$PUBLIC_IP" ]]; then
    echo 'UPSTREAM NAT DETECTED: router WAN address differs from public egress; ask the ISP for a public IPv4 address.'
    exit 2
  fi
  echo 'No upstream NAT detected from the supplied router WAN address. Confirm firewall and forwarding separately.'
  exit 0
fi

LOCAL_IPS="$(ip -o -4 addr show scope global | awk '{sub(/\/.*/, "", $4); print $4}')"
if grep -Fxq "$PUBLIC_IP" <<< "$LOCAL_IPS"; then
  echo 'The public address is assigned to this host; no NAT detected.'
  exit 0
fi

ROUTE_SOURCE="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
printf 'Host route source: %s\n' "${ROUTE_SOURCE:-unknown}"
echo 'NAT is present or the host has no directly assigned public IPv4. This alone cannot distinguish ordinary router NAT from ISP CGNAT.'
echo 'For a reliable check, pass the router WAN address: scripts/check-nat.sh <router-wan-ipv4>'
exit 1

