## Destructive Discord Command Purge

- Permanently removes `clearserver` from the approved CoreShift command registry.
- Blocks destructive legacy command names including nuke, purge, wipe, mass-ban, mass-kick, channel/role deletion, shutdown, eval, exec, and common hyphen/underscore variations.
- Refuses destructive or unknown legacy interactions even before Discord finishes refreshing its command cache.
- Bulk-overwrites the global registry with only the approved 20 safe commands.
- Bulk-overwrites the configured test-server registry with only the approved safe commands.
- Clears stale guild-specific command scopes from every connected non-test server so global commands remain without unsafe duplicates.
- Reports how many stale guild commands and scopes were removed.
- Renames the panel action to **Sync safe commands & purge legacy**.
- Extends command-inspection diagnostics to flag any forbidden global or test-server command returned by Discord.
- Adds regression tests covering destructive command spellings and variations.

After installation, save a newly reset private bot token, start the bot, and press **Sync safe commands & purge legacy**. Then use **Inspect command sync** to confirm `Global: 20/20` with no forbidden-command warning.

SHA-256: `500B3CAF3CF221A782CE498C54FB794F707A3C4F619F6F329D7CF67A06B48CE2`
