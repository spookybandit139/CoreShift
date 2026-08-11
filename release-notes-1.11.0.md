# CoreShift 1.11.0 — Intelligence workspace release

## New

- Intelligence is now the default workspace at launch, with a dedicated top tab and a visible sidebar entry.
- Added the guided research flow: authorized case → Discord snowflake → user-supplied Roblox candidate → provider task → evidence and report review.
- Added local, explicitly unverified candidate records and provider-task evidence for authorized investigations.
- Added evidence-detail and citation actions inside case review.

## Fixed

- Removed the missing Game Library script reference that generated a load error on startup.
- Updated the in-app footer to show the 1.11.0 Intelligence release.
- Added a release-safe packaging policy that excludes `API.txt`, `fivepd-audit`, `tmp`, clips, local agent state, and prior build outputs.

## Important

This is a new version number, so CoreShift can detect and install it as an update. Existing 1.10.0 installs do not contain the Intelligence workspace.
