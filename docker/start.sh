#!/bin/sh
node /app/docker/proxy-server.mjs &
exec nginx -g "daemon off;"
