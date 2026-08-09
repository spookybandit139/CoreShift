# CoreShift Update Release Guide

CoreShift 1.4.0 and newer can update from a generic HTTPS release folder. GitHub Releases works as that folder.

## One-time setup

1. Use the public `SpookyBandit11/CoreShift` repository for CoreShift releases.
2. Install CoreShift 1.4.1 manually.
3. Sign in as Spookybandit139 and connect MySQL.
4. Open Settings → CoreShift updates.
5. Confirm the release source is `https://github.com/SpookyBandit11/CoreShift/releases/latest/download`.
6. Save the source only if you want to override the built-in value. Overrides are stored in MySQL and loaded by all CoreShift users.

## Publish each future update

1. Increase the version in package.json and package-lock.json.
2. Build the update bundle:

   npm run dist:update

3. Create a non-draft GitHub Release with a version tag such as v1.4.1.
4. Upload all three matching files from dist:

   - CoreShift-Setup-1.4.1.exe
   - CoreShift-Setup-1.4.1.exe.blockmap
   - latest.yml

5. Publish the release. Do not mix files from different builds.

Installed users can then press Check for updates. CoreShift verifies the SHA-512 value from latest.yml, downloads the installer, and offers Restart & install.
