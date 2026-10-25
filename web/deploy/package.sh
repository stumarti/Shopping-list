#!/bin/sh
# Build the Unraid / Docker Compose package.
#   deploy/package.sh <image:tag> <version> <owner/repo> [out dir]
# Writes <out>/shopping-list-unraid-<version>.zip containing a shopping-list/ folder.
set -eu
IMAGE=$1
VERSION=$2
REPO=$3
OUT=${4:-dist}
HERE=$(cd "$(dirname "$0")" && pwd)

DIR="$OUT/shopping-list"
rm -rf "$DIR"
mkdir -p "$DIR"
sed -e "s#__IMAGE__#$IMAGE#g" -e "s#__REPO__#$REPO#g" "$HERE/docker-compose.yml" > "$DIR/docker-compose.yml"
sed -e "s#__IMAGE__#$IMAGE#g" -e "s#__REPO__#$REPO#g" "$HERE/shopping-list.xml" > "$DIR/shopping-list.xml"
cp "$HERE/.env.example" "$DIR/.env.example"
cp "$HERE/.env.example" "$DIR/.env"
cp "$HERE/icon.png" "$DIR/icon.png"
sed -e "s#__IMAGE__#$IMAGE#g" -e "s#__VERSION__#$VERSION#g" -e "s#__REPO__#$REPO#g" "$HERE/README.md" > "$DIR/README.md"
echo "$VERSION" > "$DIR/VERSION"

ZIP="shopping-list-unraid-$VERSION.zip"
(cd "$OUT" && rm -f "$ZIP" && zip -qr "$ZIP" shopping-list)
echo "$OUT/$ZIP"
