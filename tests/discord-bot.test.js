'use strict';

const assert = require('assert');
const { COMMANDS, COMMAND_NAMES, FORBIDDEN_COMMAND_NAMES, isDestructiveCommandName, ensureBotTables } = require('../main/discord-bot');

async function run() {
  assert.equal(COMMANDS.length, 20);
  assert.equal(new Set(COMMAND_NAMES).size, COMMAND_NAMES.length);
  assert.deepEqual(COMMANDS.map(command => command.name), COMMAND_NAMES);
  for (const command of COMMANDS) {
    assert.match(command.name, /^[a-z0-9_-]{1,32}$/);
    assert.ok(command.description.length >= 1 && command.description.length <= 100);
  }
  for (const required of ['status', 'invite', 'roles', 'avatar', 'userinfo', 'choose', 'random', 'remind', 'suggest', 'suggestions', 'clipshare', 'clips']) {
    assert.ok(COMMAND_NAMES.includes(required), 'Missing command: ' + required);
  }
  for (const forbidden of FORBIDDEN_COMMAND_NAMES) assert.ok(!COMMAND_NAMES.includes(forbidden), 'Unsafe command registered: ' + forbidden);
  for (const variation of ['clearserver', 'clear-server', 'clear_server', 'nuke', 'purge', 'wipe', 'ban-all', 'kick_all', 'eval', 'exec']) {
    assert.equal(isDestructiveCommandName(variation), true, 'Destructive variation was not blocked: ' + variation);
  }

  const statements = [];
  await ensureBotTables({ async query(sql) { statements.push(sql); return [[], []]; } });
  assert.equal(statements.length, 5);
  for (const table of ['discord_missions', 'discord_benchmarks', 'discord_reminders', 'discord_suggestions', 'discord_shared_clips']) {
    assert.ok(statements.some(sql => sql.includes(table)), 'Missing table creation: ' + table);
  }

  console.log('Discord bot command and schema tests passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
