#!/bin/bash
# deploy.sh — copy files to Unraid and rebuild Docker container
# Usage: ./deploy.sh

UNRAID="root@rujirama"
TARGET="/mnt/user/appdata/carpool"

echo "📦 Copying files..."
scp Dockerfile docker-compose.yml package.json package-lock.json server.js ${UNRAID}:${TARGET}/
scp public/index.html public/style.css ${UNRAID}:${TARGET}/public/

echo "🔨 Rebuilding and restarting..."
ssh ${UNRAID} "cd ${TARGET} && docker compose up -d --build"

echo "✅ Done — http://rujirama:3000"
