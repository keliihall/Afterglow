#!/bin/bash
# One-time setup: create a STABLE self-signed code-signing identity in a dedicated
# local keychain. Signing the app with a fixed identity (instead of ad-hoc) keeps
# its code signature constant across rebuilds, so the macOS keychain "Always Allow"
# grant for reading "Claude Safe Storage" persists permanently — no repeated prompts.
#
# Idempotent: safe to run again; it skips work that's already done.
# The keychain below holds only a throwaway self-signed dev cert, so its password
# is intentionally fixed/local and not a meaningful secret.
set -euo pipefail

IDENTITY="Afterglow Local Signing"
KEYCHAIN="$HOME/Library/Keychains/afterglow-codesign.keychain-db"
KC_PASS="afterglow-signing"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
    echo "✓ signing identity already exists: $IDENTITY"
    exit 0
fi

echo "→ creating keychain"
if [ ! -f "$KEYCHAIN" ]; then
    security create-keychain -p "$KC_PASS" "$KEYCHAIN"
fi
security set-keychain-settings "$KEYCHAIN"            # no auto-lock
security unlock-keychain -p "$KC_PASS" "$KEYCHAIN"

echo "→ generating self-signed code-signing certificate"
cat > "$TMP/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $IDENTITY
[v3]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf" >/dev/null 2>&1

openssl pkcs12 -export -legacy \
    -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -name "$IDENTITY" -out "$TMP/id.p12" -passout pass:"$KC_PASS" >/dev/null 2>&1 \
  || openssl pkcs12 -export \
    -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -name "$IDENTITY" -out "$TMP/id.p12" -passout pass:"$KC_PASS" >/dev/null 2>&1

echo "→ importing into keychain (pre-authorizing codesign)"
security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$KC_PASS" \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1

# Allow codesign to use the key without an interactive prompt.
security set-key-partition-list -S apple-tool:,apple:,unsigned: \
    -s -k "$KC_PASS" "$KEYCHAIN" >/dev/null 2>&1 || true

# Add to the keychain search list (keep existing entries) so codesign finds it.
EXISTING=$(security list-keychains -d user | sed 's/[" ]//g')
if ! echo "$EXISTING" | grep -q "afterglow-codesign"; then
    # shellcheck disable=SC2086
    security list-keychains -d user -s $EXISTING "$KEYCHAIN"
fi

echo "✓ created signing identity: $IDENTITY"
security find-identity -v -p codesigning "$KEYCHAIN" | grep "$IDENTITY" || true
