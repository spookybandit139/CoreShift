'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { COMMANDS, COMMAND_NAMES, PREFIX_COMMANDS, FORBIDDEN_COMMAND_NAMES, isDestructiveCommandName, parsePrefixCommand, ensureBotTables } = require('../main/discord-bot');

async function run() {
  assert.equal(COMMANDS.length, 28);
  assert.equal(new Set(COMMAND_NAMES).size, COMMAND_NAMES.length);
  assert.deepEqual(COMMANDS.map(command => command.name), COMMAND_NAMES);
  for (const command of COMMANDS) {
    assert.match(command.name, /^[a-z0-9_-]{1,32}$/);
    assert.ok(command.description.length >= 1 && command.description.length <= 100);
  }
  for (const required of ['status', 'invite', 'membercount', 'channelinfo', 'roleinfo', 'servericon', 'roles', 'avatar', 'userinfo', 'choose', 'random', 'roll', 'poll', 'announce', 'verification', 'remind', 'suggest', 'suggestions', 'clipshare', 'clips']) {
    assert.ok(COMMAND_NAMES.includes(required), 'Missing command: ' + required);
  }
  const poll = COMMANDS.find(command => command.name === 'poll');
  const announce = COMMANDS.find(command => command.name === 'announce');
  const verification = COMMANDS.find(command => command.name === 'verification');
  assert.equal(poll.default_member_permissions, String(1n << 13n), 'Poll must require Manage Messages.');
  assert.equal(announce.default_member_permissions, String(1n << 5n), 'Announce must require Manage Server.');
  assert.equal(verification.default_member_permissions, String(1n << 5n), 'Verification setup must require Manage Server.');
  assert.equal(verification.options[0].name, 'setup', 'Verification must use an explicit setup action.');
  assert.equal(verification.options[0].options.find(option => option.name === 'role')?.required, true, 'Verification setup must require a role.');
  assertRequiredBeforeOptional(COMMANDS);
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'discord-bot.js'), 'utf8');
  assert.ok(source.includes('Routes.applicationGuildCommands(APPLICATION_ID, guildId), { body: COMMANDS }'), 'Every connected server must receive an instant command copy.');
  assert.ok(!source.includes('body: []'), 'Sync must not clear server command scopes.');
  assert.ok(source.includes('GatewayIntentBits.GuildMembers'), 'Welcome flow must subscribe to member joins.');
  assert.ok(source.includes('discord_join_sources'), 'Welcome source answers must be saved to the dedicated database table.');
  assert.ok(source.includes('We do not collect IP addresses'), 'Welcome source menu must disclose its data use.');
  for (const forbidden of FORBIDDEN_COMMAND_NAMES) assert.ok(!COMMAND_NAMES.includes(forbidden), 'Unsafe command registered: ' + forbidden);
  for (const variation of ['clearserver', 'clear-server', 'clear_server', 'nuke', 'purge', 'wipe', 'ban-all', 'kick_all', 'eval', 'exec']) {
    assert.equal(isDestructiveCommandName(variation), true, 'Destructive variation was not blocked: ' + variation);
  }
  assert.ok(PREFIX_COMMANDS.includes('!serverinvite'));
  assert.ok(PREFIX_COMMANDS.includes('!lock'));
  assert.deepEqual(parsePrefixCommand('!announce Server event at 8 PM'), { command: 'announce', arguments: 'Server event at 8 PM' });
  assert.equal(parsePrefixCommand('/help'), null);

  const statements = [];
  await ensureBotTables({ async query(sql) { statements.push(sql); return [[], []]; } });
  assert.equal(statements.length, 6);
  for (const table of ['discord_missions', 'discord_benchmarks', 'discord_reminders', 'discord_suggestions', 'discord_shared_clips', 'discord_join_sources']) {
    assert.ok(statements.some(sql => sql.includes(table)), 'Missing table creation: ' + table);
  }

  console.log('Discord bot command and schema tests passed.');
}

function assertRequiredBeforeOptional(commands) {
  const walk = (options, label) => {
    let foundOptional = false;
    for (const option of options || []) {
      if (option.type === 1 || option.type === 2) { walk(option.options, label + ' ' + option.name); continue; }
      if (option.required) assert.equal(foundOptional, false, label + ' puts required option ' + option.name + ' after an optional option.');
      else foundOptional = true;
    }
  };
  for (const command of commands) walk(command.options, '/' + command.name);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
