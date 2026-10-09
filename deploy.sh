#!/usr/bin/env bash
# Upload the site to the server. nginx serves /var/www/retro directly, no restart needed.
set -euo pipefail
cd "$(dirname "$0")"

SERVER="${SERVER:-root@46.101.232.250}"

tar czf - index.html style.css config.js games.js terminal.js pictures |
  ssh "$SERVER" 'rm -rf /var/www/retro.new && mkdir -p /var/www/retro.new &&
    tar xzf - -C /var/www/retro.new --no-same-owner &&
    chmod -R u=rwX,go=rX /var/www/retro.new &&
    rm -rf /var/www/retro.old && mv /var/www/retro /var/www/retro.old &&
    mv /var/www/retro.new /var/www/retro && rm -rf /var/www/retro.old'

echo "deployed to https://altynkhan.com/"
