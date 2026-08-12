'use strict';

const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Colors,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const crypto = require('crypto');

const APPLICATION_ID = '1414846841371099156';
// Existing read/send/embed/history permissions plus Manage Roles for verification only.
const INVITE_PERMISSIONS = '268520465';
const IPC_CHANNELS = [
  'bot:status',
  'bot:config:save',
  'bot:start',
  'bot:stop',
  'bot:invite',
  'bot:commands:register',
  'bot:commands:inspect'
];
const CHALLENGES = [
  'Turn a 20-second raw clip into a dramatic trailer using only three cuts.',
  'Create the cleanest vertical 9:16 highlight from ordinary gameplay.',
  'Make a funny fail edit with one caption and no more than eight seconds.',
  'Record a before-and-after FPS comparison using the same game location.',
  'Design a crosshair, win a match with it, and submit the resulting clip.',
  'Create a cinematic clip using only color grading and slow motion.',
  'Capture a clutch moment and edit it so the final video is under 12 seconds.',
  'Produce a game clip whose audio tells the story before the video does.'
];
const DEFAULT_AUTO_REPLY_CONFIG = Object.freeze({
  enabled: true,
  serverName: 'El Rancho',
  mentionReply: 'Hey {user}! Need something? Try /help to see what I can do.',
  keywordReplies: [
    'hello|hi|hey => Hey {user}, welcome to {server}!',
    'rules => Please take a look at the server rules before jumping in.',
    'vc|voice chat => Hop into a voice channel and see who is chilling.',
    'games|gaming => Ask in chat what everyone is playing and squad up.',
    'help => Try /help for the full command list.'
  ].join('\n')
});
const PREFIX_COMMANDS = Object.freeze([
  '!cmds', '!rules', '!serverinfo', '!welcome', '!security',
  '!staffhelp', '!announce <message>', '!embed <title> | <message>',
  '!serverinvite', '!lock', '!unlock', '!slowmode <0-21600>'
]);

const guildOnly = builder => builder.setContexts(InteractionContextType.Guild);
const COMMANDS = [
  new SlashCommandBuilder().setName('help').setDescription('Show every CoreShift bot command'),
  new SlashCommandBuilder().setName('ping').setDescription('Check CoreShift bot and Discord gateway latency'),
  new SlashCommandBuilder().setName('status').setDescription('Show bot, database, and command status'),
  new SlashCommandBuilder().setName('coreshift').setDescription('Show CoreShift download and feature information'),
  new SlashCommandBuilder().setName('invite').setDescription('Get the official CoreShift bot invite'),
  guildOnly(new SlashCommandBuilder().setName('server').setDescription('Show a quick server operations snapshot')),
  guildOnly(new SlashCommandBuilder().setName('membercount').setDescription('Show the current server member count')),
  guildOnly(new SlashCommandBuilder().setName('channelinfo').setDescription('Show details about this channel')),
  guildOnly(new SlashCommandBuilder().setName('roleinfo').setDescription('Show details about a server role')
    .addRoleOption(option => option.setName('role').setDescription('Role to inspect').setRequired(true))),
  guildOnly(new SlashCommandBuilder().setName('servericon').setDescription('Show the server icon in full size')),
  guildOnly(new SlashCommandBuilder().setName('roles').setDescription('List the server roles and member counts')),
  new SlashCommandBuilder().setName('avatar').setDescription('Show a Discord user avatar')
    .addUserOption(option => option.setName('user').setDescription('User to view')),
  new SlashCommandBuilder().setName('userinfo').setDescription('Show useful information about a Discord user')
    .addUserOption(option => option.setName('user').setDescription('User to inspect')),
  new SlashCommandBuilder().setName('choose').setDescription('Choose one item from a comma-separated list')
    .addStringOption(option => option.setName('options').setDescription('Example: JavaScript, Python, Rust').setRequired(true).setMinLength(3).setMaxLength(500)),
  new SlashCommandBuilder().setName('random').setDescription('Generate a random whole number')
    .addIntegerOption(option => option.setName('minimum').setDescription('Lowest possible value').setRequired(true).setMinValue(-1000000).setMaxValue(1000000))
    .addIntegerOption(option => option.setName('maximum').setDescription('Highest possible value').setRequired(true).setMinValue(-1000000).setMaxValue(1000000)),
  new SlashCommandBuilder().setName('roll').setDescription('Roll dice using notation such as 2d20+3')
    .addStringOption(option => option.setName('dice').setDescription('Between 1d2 and 20d1000, optionally with + or - modifier').setRequired(true).setMaxLength(14)),
  guildOnly(new SlashCommandBuilder().setName('poll').setDescription('Create a native Discord poll (Manage Messages required)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption(option => option.setName('question').setDescription('Question to ask').setRequired(true).setMaxLength(300))
    .addStringOption(option => option.setName('option1').setDescription('First answer').setRequired(true).setMaxLength(55))
    .addStringOption(option => option.setName('option2').setDescription('Second answer').setRequired(true).setMaxLength(55))
    .addIntegerOption(option => option.setName('hours').setDescription('How long the poll stays open').setRequired(true).setMinValue(1).setMaxValue(168))
    .addStringOption(option => option.setName('option3').setDescription('Optional third answer').setMaxLength(55))
    .addStringOption(option => option.setName('option4').setDescription('Optional fourth answer').setMaxLength(55))
    .addBooleanOption(option => option.setName('multiple').setDescription('Let members select more than one answer'))),
  guildOnly(new SlashCommandBuilder().setName('announce').setDescription('Post a styled announcement in this channel (Manage Server required)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName('title').setDescription('Announcement title').setRequired(true).setMaxLength(100))
    .addStringOption(option => option.setName('message').setDescription('Announcement text').setRequired(true).setMaxLength(1800))),
  guildOnly(new SlashCommandBuilder().setName('verification').setDescription('Post a privacy-respecting verification role gate (Manage Server required)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(command => command.setName('setup').setDescription('Post a verification panel in this channel')
      .addRoleOption(option => option.setName('role').setDescription('Role members receive after verifying').setRequired(true))
      .addStringOption(option => option.setName('rules').setDescription('Optional short server-rules acknowledgement').setMaxLength(900)))),
  new SlashCommandBuilder().setName('fpsguide').setDescription('Get safe performance suggestions for a game')
    .addStringOption(option => option.setName('game').setDescription('Game name').setRequired(true).setMaxLength(80)),
  new SlashCommandBuilder().setName('clipchallenge').setDescription('Reveal this week\'s CoreShift editing challenge'),
  guildOnly(new SlashCommandBuilder().setName('remind').setDescription('Save a MySQL-backed reminder in this channel')
    .addIntegerOption(option => option.setName('minutes').setDescription('Minutes from now, up to seven days').setRequired(true).setMinValue(1).setMaxValue(10080))
    .addStringOption(option => option.setName('message').setDescription('Reminder text').setRequired(true).setMaxLength(500))),
  guildOnly(new SlashCommandBuilder().setName('suggest').setDescription('Save a community suggestion to CoreShift MySQL')
    .addStringOption(option => option.setName('idea').setDescription('Your suggestion').setRequired(true).setMinLength(3).setMaxLength(1000))),
  guildOnly(new SlashCommandBuilder().setName('suggestions').setDescription('Show the latest community suggestions')),
  guildOnly(new SlashCommandBuilder().setName('clipshare').setDescription('Save a gameplay clip link for the community')
    .addStringOption(option => option.setName('url').setDescription('HTTPS link to the clip').setRequired(true).setMaxLength(1000))
    .addStringOption(option => option.setName('game').setDescription('Game title').setMaxLength(80))
    .addStringOption(option => option.setName('caption').setDescription('Short description').setMaxLength(300))),
  guildOnly(new SlashCommandBuilder().setName('clips').setDescription('Show recently shared community clips')),
  guildOnly(new SlashCommandBuilder().setName('mission').setDescription('View or manage the server\'s active community mission')
    .addSubcommand(command => command.setName('view').setDescription('View the active server mission'))
    .addSubcommand(command => command.setName('create').setDescription('Create a new mission (Manage Server required)')
      .addStringOption(option => option.setName('title').setDescription('Mission title').setRequired(true).setMaxLength(100))
      .addStringOption(option => option.setName('description').setDescription('What members need to accomplish').setRequired(true).setMaxLength(1000))
      .addStringOption(option => option.setName('reward').setDescription('Role, points, recognition, or prize').setMaxLength(200)))
    .addSubcommand(command => command.setName('close').setDescription('Close the current mission (Manage Server required)'))),
  guildOnly(new SlashCommandBuilder().setName('benchmark').setDescription('Submit or view community FPS benchmark results')
    .addSubcommand(command => command.setName('submit').setDescription('Submit a before-and-after FPS result')
      .addStringOption(option => option.setName('game').setDescription('Game tested').setRequired(true).setMaxLength(80))
      .addIntegerOption(option => option.setName('before').setDescription('FPS before changes').setRequired(true).setMinValue(1).setMaxValue(2000))
      .addIntegerOption(option => option.setName('after').setDescription('FPS after changes').setRequired(true).setMinValue(1).setMaxValue(2000))
      .addStringOption(option => option.setName('notes').setDescription('Settings or changes tested').setMaxLength(400)))
    .addSubcommand(command => command.setName('leaderboard').setDescription('Show the largest verified FPS improvements')
      .addStringOption(option => option.setName('game').setDescription('Optional game filter').setMaxLength(80))))
].map(command => command.toJSON());
const COMMAND_NAMES = COMMANDS.map(command => command.name);
const FORBIDDEN_COMMAND_NAMES = Object.freeze([
  'clearserver', 'nuke', 'purge', 'wipe', 'deletechannels', 'deleteroles',
  'banall', 'kickall', 'massban', 'masskick', 'shutdown', 'eval', 'exec', 'execute'
]);
function isDestructiveCommandName(name) {
  const normalized = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return FORBIDDEN_COMMAND_NAMES.includes(normalized);
}
if (COMMAND_NAMES.some(isDestructiveCommandName)) throw new Error('CoreShift safe command registry contains a forbidden destructive command.');

function registerDiscordBot({ ipcMain, BrowserWindow, app, fs, path, safeStorage, getSettings, saveSettings, getDbConnection, getActiveAccount, ownerUsername }) {
  for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
  let client = null;
  let starting = false;
  let reminderTimer = null;
  let status = {
    state: 'stopped',
    connected: false,
    commandCount: COMMANDS.length,
    guildCount: 0,
    userTag: '',
    sync: null,
    message: 'CoreShift bot is stopped.'
  };

  function tokenPath() { return path.join(app.getPath('userData'), 'discord-bot-token.dat'); }
  function getConfig() {
    const value = getSettings().discordBot || {};
    return {
      enabled: Boolean(value.enabled),
      applicationId: APPLICATION_ID,
      testGuildId: /^\d{16,22}$/.test(String(value.testGuildId || '').trim()) ? String(value.testGuildId).trim() : '',
      hasToken: fs.existsSync(tokenPath()),
      autoReplies: normalizeAutoReplyConfig(value.autoReplies),
      welcome: normalizeWelcomeConfig(value.welcome),
      expectedCommands: COMMAND_NAMES
    };
  }
  function requireOwner() {
    if (getActiveAccount()?.username?.toLowerCase() !== String(ownerUsername).toLowerCase()) throw new Error('Only Spookybandit139 can manage the Discord bot.');
  }
  function broadcast(next) {
    status = { ...status, ...next };
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('bot:statusChanged', status);
    return status;
  }
  function saveToken(token) {
    const cleaned = String(token || '').trim();
    if (!cleaned) return;
    if (cleaned.length < 40 || !/^[A-Za-z0-9._-]+$/.test(cleaned)) throw new Error('That does not look like a Discord bot token.');
    const encodedId = cleaned.split('.')[0];
    try {
      const tokenApplicationId = Buffer.from(encodedId, 'base64url').toString('utf8');
      if (/^\d{16,22}$/.test(tokenApplicationId) && tokenApplicationId !== APPLICATION_ID) throw new Error('This token belongs to a different Discord application.');
    } catch (error) {
      if (/different Discord application/i.test(error.message)) throw error;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption is unavailable, so CoreShift will not save the bot token.');
    fs.writeFileSync(tokenPath(), safeStorage.encryptString(cleaned), { mode: 0o600 });
  }
  function readToken() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(fs.readFileSync(tokenPath()));
    } catch { return ''; }
  }
  function inviteUrl() {
    return 'https://discord.com/oauth2/authorize?client_id=' + APPLICATION_ID + '&permissions=' + INVITE_PERMISSIONS + '&integration_type=0&scope=bot%20applications.commands';
  }
  async function saveConfig(payload) {
    requireOwner();
    if (payload?.token) saveToken(payload.token);
    if (payload?.welcome?.enabled && !/^\d{16,22}$/.test(String(payload.welcome.channelId || '').trim())) throw new Error('Copy a valid welcome channel ID before enabling the welcome flow.');
    const current = getSettings();
    const config = {
      enabled: Boolean(payload?.enabled),
      applicationId: APPLICATION_ID,
      testGuildId: /^\d{16,22}$/.test(String(payload?.testGuildId || '').trim()) ? String(payload.testGuildId).trim() : '',
      autoReplies: normalizeAutoReplyConfig(payload?.autoReplies),
      welcome: normalizeWelcomeConfig(payload?.welcome)
    };
    saveSettings({ ...current, discordBot: config });
    return { success: true, config: { ...config, hasToken: Boolean(readToken()), expectedCommands: COMMAND_NAMES }, message: 'Discord bot settings saved securely on this Windows account.' };
  }
  async function syncCommands(token, config, connectedGuildIds = []) {
    const rest = new REST({ version: '10' }).setToken(token);
    broadcast({ state: 'registering', message: 'Publishing the complete global command set and instant server copies...' });
    const globalResult = await rest.put(Routes.applicationCommands(APPLICATION_ID), { body: COMMANDS });
    const guildIds = [...new Set([...connectedGuildIds, config.testGuildId].map(String).filter(id => /^\d{16,22}$/.test(id)))];
    const guildSync = { succeeded: 0, failed: 0, errors: [] };
    let testGuildResult = [];
    for (const guildId of guildIds) {
      try {
        const result = await rest.put(Routes.applicationGuildCommands(APPLICATION_ID, guildId), { body: COMMANDS });
        guildSync.succeeded++;
        if (guildId === config.testGuildId) testGuildResult = result;
      } catch (error) { guildSync.failed++; guildSync.errors.push({ guildId, message: cleanDiscordError(error) }); }
    }
    const sync = {
      expectedCount: COMMANDS.length,
      globalCount: Array.isArray(globalResult) ? globalResult.length : COMMANDS.length,
      guildCount: Array.isArray(testGuildResult) ? testGuildResult.length : 0,
      testGuildId: config.testGuildId,
      guildSync,
      guildError: guildSync.errors.find(error => error.guildId === config.testGuildId)?.message || ''
    };
    broadcast({ sync, commandCount: sync.globalCount, message: syncMessage(sync) });
    return sync;
  }
  async function inspectCommands(token, config) {
    const rest = new REST({ version: '10' }).setToken(token);
    const globalCommands = await rest.get(Routes.applicationCommands(APPLICATION_ID));
    let guildCommands = [];
    let guildError = '';
    if (config.testGuildId) {
      try { guildCommands = await rest.get(Routes.applicationGuildCommands(APPLICATION_ID, config.testGuildId)); }
      catch (error) { guildError = cleanDiscordError(error); }
    }
    const globalNames = Array.isArray(globalCommands) ? globalCommands.map(command => command.name).sort() : [];
    const guildNames = Array.isArray(guildCommands) ? guildCommands.map(command => command.name).sort() : [];
    return {
      expected: COMMAND_NAMES,
      globalNames,
      guildNames,
      missingGlobal: COMMAND_NAMES.filter(name => !globalNames.includes(name)),
      missingGuild: config.testGuildId ? COMMAND_NAMES.filter(name => !guildNames.includes(name)) : [],
      forbiddenGlobal: globalNames.filter(isDestructiveCommandName),
      forbiddenGuild: guildNames.filter(isDestructiveCommandName),
      testGuildId: config.testGuildId,
      guildError
    };
  }
  function startReminderWorker(nextClient) {
    if (reminderTimer) clearInterval(reminderTimer);
    const deliver = () => deliverDueReminders(nextClient, getDbConnection).catch(error => console.error('Discord reminder worker:', cleanError(error)));
    reminderTimer = setInterval(deliver, 30000);
    setTimeout(deliver, 3500);
  }
  function stopReminderWorker() {
    if (reminderTimer) clearInterval(reminderTimer);
    reminderTimer = null;
  }
  async function startBot() {
    if (starting) return { success: false, status, message: 'The Discord bot is already starting.' };
    if (client?.isReady()) return { success: true, status, message: 'The Discord bot is already online.' };
    const token = readToken();
    if (!token) return { success: false, status: broadcast({ state: 'error', connected: false, message: 'Add and save a newly reset Discord bot token first.' }), message: 'Add and save a newly reset Discord bot token first.' };
    starting = true;
    broadcast({ state: 'connecting', connected: false, message: 'Connecting CoreShift to the Discord gateway...' });
    const config = getConfig();
    const nextClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    client = nextClient;
    nextClient.on(Events.InteractionCreate, interaction => handleInteraction(interaction, getDbConnection, inviteUrl, nextClient).catch(error => safeInteractionError(interaction, error)));
    nextClient.on(Events.MessageCreate, message => handleMessage(message, getConfig, nextClient).catch(error => console.error('Discord message command:', cleanError(error))));
    nextClient.on(Events.GuildMemberAdd, member => handleMemberWelcome(member, getConfig, getDbConnection).catch(error => console.error('Discord welcome:', cleanError(error))));
    nextClient.on(Events.Error, error => broadcast({ state: 'error', connected: false, message: 'Discord bot error: ' + cleanError(error) }));
    nextClient.on(Events.ShardDisconnect, () => broadcast({ state: 'reconnecting', connected: false, message: 'Discord disconnected. Reconnecting automatically...' }));
    nextClient.on(Events.ShardResume, () => broadcast({ state: 'online', connected: true, message: 'CoreShift bot reconnected.' }));
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Discord bot connection timed out.')), 20000);
        nextClient.once(Events.ClientReady, async readyClient => {
          clearTimeout(timeout);
          try {
            const sync = await syncCommands(token, config, [...readyClient.guilds.cache.keys()]);
            readyClient.user.setActivity('CoreShift commands | /help', { type: ActivityType.Watching });
            startReminderWorker(readyClient);
            const warning = sync.guildError ? ' Test-server mirror warning: ' + sync.guildError : '';
            broadcast({ state: 'online', connected: true, commandCount: sync.globalCount, guildCount: readyClient.guilds.cache.size, userTag: readyClient.user.tag, sync, message: readyClient.user.tag + ' is online with ' + sync.globalCount + ' global commands in ' + readyClient.guilds.cache.size + ' server(s).' + warning });
            resolve();
          } catch (error) { reject(error); }
        });
        nextClient.login(token).catch(reject);
      });
      return { success: true, status, message: status.message };
    } catch (error) {
      stopReminderWorker();
      await Promise.resolve(nextClient.destroy()).catch(() => {});
      if (client === nextClient) client = null;
      const message = cleanDiscordError(error);
      return { success: false, status: broadcast({ state: 'error', connected: false, message }), message };
    } finally { starting = false; }
  }
  async function stopBot() {
    stopReminderWorker();
    if (client) await Promise.resolve(client.destroy()).catch(() => {});
    client = null;
    starting = false;
    return { success: true, status: broadcast({ state: 'stopped', connected: false, guildCount: 0, userTag: '', message: 'CoreShift bot is stopped.' }), message: 'CoreShift bot stopped.' };
  }

  ipcMain.handle('bot:status', () => ({ success: true, status, config: getConfig(), inviteUrl: inviteUrl() }));
  ipcMain.handle('bot:config:save', async (_event, payload) => {
    try { return await saveConfig(payload); } catch (error) { return { success: false, message: cleanError(error) }; }
  });
  ipcMain.handle('bot:start', async () => {
    try { requireOwner(); return await startBot(); } catch (error) { return { success: false, message: cleanError(error), status }; }
  });
  ipcMain.handle('bot:stop', async () => {
    try { requireOwner(); return await stopBot(); } catch (error) { return { success: false, message: cleanError(error), status }; }
  });
  ipcMain.handle('bot:invite', () => ({ success: true, inviteUrl: inviteUrl() }));
  ipcMain.handle('bot:commands:register', async () => {
    try {
      requireOwner();
      const token = readToken();
      if (!token) throw new Error('Save a newly reset Discord bot token first.');
      const sync = await syncCommands(token, getConfig(), client?.isReady() ? [...client.guilds.cache.keys()] : []);
      return { success: true, sync, message: syncMessage(sync) };
    } catch (error) { return { success: false, message: cleanDiscordError(error) }; }
  });
  ipcMain.handle('bot:commands:inspect', async () => {
    try {
      requireOwner();
      const token = readToken();
      if (!token) throw new Error('Save a newly reset Discord bot token first.');
      const inspection = await inspectCommands(token, getConfig());
      return { success: true, inspection, message: inspection.missingGlobal.length ? inspection.missingGlobal.length + ' global commands are missing.' : 'Discord returned every expected global command.' };
    } catch (error) { return { success: false, message: cleanDiscordError(error) }; }
  });

  return {
    async autoStart() { if (getConfig().enabled && readToken()) await startBot(); },
    async stop() { stopReminderWorker(); if (client) await Promise.resolve(client.destroy()).catch(() => {}); client = null; },
    async getStatus() {
      try {
        requireOwner();
        return { success: true, status: { ...status }, message: status.message || 'Bot controls are ready.' };
      } catch (error) { return { success: false, message: cleanError(error) }; }
    },
    async start() {
      try { requireOwner(); return await startBot(); }
      catch (error) { return { success: false, message: cleanError(error), status }; }
    },
    async stopFromController() {
      try { requireOwner(); return await stopBot(); }
      catch (error) { return { success: false, message: cleanError(error), status }; }
    },
    async syncFromController() {
      try {
        requireOwner();
        const token = readToken();
        if (!token) throw new Error('Save a newly reset Discord bot token first.');
        const sync = await syncCommands(token, getConfig(), client?.isReady() ? [...client.guilds.cache.keys()] : []);
        return { success: true, sync, message: syncMessage(sync) };
      } catch (error) { return { success: false, message: cleanDiscordError(error) }; }
    },
    async getMobileStatus() {
      const guilds = client?.isReady() ? [...client.guilds.cache.values()].map(guild => ({
        id: guild.id,
        name: guild.name,
        channels: [...guild.channels.cache.values()].filter(channel => channel.isTextBased?.() && !channel.isThread?.()).slice(0, 100).map(channel => ({ id: channel.id, name: channel.name || 'channel' }))
      })) : [];
      return { success: true, status: { ...status }, message: status.message || 'Bot Command Center is ready.', commands: COMMAND_NAMES, guilds };
    },
    async startFromMobile() {
      return startBot();
    },
    async stopFromMobile() {
      return stopBot();
    },
    async syncFromMobile() {
      try {
        const token = readToken();
        if (!token) throw new Error('Save a newly reset Discord bot token on this PC first.');
        const sync = await syncCommands(token, getConfig(), client?.isReady() ? [...client.guilds.cache.keys()] : []);
        return { success: true, sync, message: syncMessage(sync) };
      } catch (error) { return { success: false, message: cleanDiscordError(error) }; }
    },
    async postFromMobile(payload = {}) {
      if (!client?.isReady()) return { success: false, message: 'Start the Discord bot before posting from your phone.' };
      const guild = client.guilds.cache.get(String(payload.guildId || ''));
      const channel = guild ? await guild.channels.fetch(String(payload.channelId || '')).catch(() => null) : null;
      if (!channel?.isTextBased?.() || !channel.send) return { success: false, message: 'Choose a text channel in a server where the bot is online.' };
      const type = String(payload.type || 'announcement');
      const serverName = guild.name || 'El Rancho';
      let embed;
      if (type === 'rules') embed = prefixRulesEmbed(serverName);
      else if (type === 'welcome') embed = baseEmbed('Welcome to ' + serverName, 'Glad you are here. Say hi, find a game, or jump into VC and chill with everyone.');
      else if (type === 'security') embed = baseEmbed(serverName + ' safety', 'Do not share passwords or tokens, avoid suspicious links and downloads, and report scams or harassment to staff.');
      else {
        const title = String(payload.title || serverName + ' announcement').trim().slice(0, 256);
        const message = String(payload.message || '').trim().slice(0, 4000);
        if (!message) return { success: false, message: 'Write an announcement before posting.' };
        embed = baseEmbed('📢 ' + title, message);
      }
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      return { success: true, message: 'Posted to #' + (channel.name || 'channel') + '.' };
    }
  };
}

async function handleInteraction(interaction, getDbConnection, inviteUrl, client) {
  if (interaction.isButton()) return handleVerificationButton(interaction);
  if (interaction.isStringSelectMenu()) return handleJoinSourceSelect(interaction, getDbConnection);
  if (!interaction.isChatInputCommand()) return;
  const command = interaction.commandName;
  if (isDestructiveCommandName(command)) return interaction.reply({ content: 'That legacy destructive command is permanently disabled in CoreShift.', ephemeral: true });
  if (!COMMAND_NAMES.includes(command)) return interaction.reply({ content: 'That legacy command is no longer available. Use /help for the safe command deck.', ephemeral: true });
  if (command === 'ping') {
    const roundTrip = Math.max(0, Date.now() - interaction.createdTimestamp);
    return interaction.reply({ embeds: [baseEmbed('CoreShift signal check', 'Gateway: **' + Math.round(client.ws.ping) + ' ms**\nInteraction: **' + roundTrip + ' ms**')], ephemeral: true });
  }
  if (command === 'help') {
    return interaction.reply({ embeds: [baseEmbed('CoreShift command deck', [
      '**Core:** /help /ping /status /coreshift /invite',
      '**Server:** /server /membercount /channelinfo /roleinfo /servericon /roles /verification setup',
      '**Utilities:** /choose /random /roll /poll /announce /remind',
      '**Gaming:** /fpsguide /clipchallenge /clipshare /clips',
      '**Community:** /suggest /suggestions /mission',
      '**Performance:** /benchmark submit /benchmark leaderboard'
    ].join('\n\n'))] });
  }
  if (command === 'status') {
    const connection = getDbConnection();
    return interaction.reply({ embeds: [baseEmbed('CoreShift operations status', 'CoreShift bot is online and responding.')
      .addFields(
        { name: 'Gateway', value: Math.round(client.ws.ping) + ' ms', inline: true },
        { name: 'MySQL', value: connection ? 'Connected' : 'Offline', inline: true },
        { name: 'Commands', value: String(COMMANDS.length) + ' expected', inline: true },
        { name: 'Uptime', value: formatDuration(client.uptime || 0), inline: true },
        { name: 'Servers', value: String(client.guilds.cache.size), inline: true }
      )], ephemeral: true });
  }
  if (command === 'coreshift') {
    return interaction.reply({ embeds: [baseEmbed('CoreShift Desktop Suite', 'A Windows gaming command center with Clip Studio Ultra, instant replay, performance tools, crosshairs, diagnostics, community chat, and MySQL utilities.')
      .addFields({ name: 'Latest release', value: '[Download CoreShift](https://github.com/spookybandit139/CoreShift/releases/latest)', inline: true }, { name: 'Bot invite', value: '[Add CoreShift Bot](' + inviteUrl() + ')', inline: true })] });
  }
  if (command === 'invite') return interaction.reply({ embeds: [baseEmbed('Invite CoreShift Bot', '[Add CoreShift to another server](' + inviteUrl() + ')')], ephemeral: true });
  if (command === 'server') return handleServer(interaction);
  if (command === 'membercount') return handleMemberCount(interaction);
  if (command === 'channelinfo') return handleChannelInfo(interaction);
  if (command === 'roleinfo') return handleRoleInfo(interaction);
  if (command === 'servericon') return handleServerIcon(interaction);
  if (command === 'roles') return handleRoles(interaction);
  if (command === 'avatar') return handleAvatar(interaction);
  if (command === 'userinfo') return handleUserInfo(interaction);
  if (command === 'choose') return handleChoose(interaction);
  if (command === 'random') return handleRandom(interaction);
  if (command === 'roll') return handleRoll(interaction);
  if (command === 'poll') return handlePoll(interaction);
  if (command === 'announce') return handleAnnouncement(interaction);
  if (command === 'verification') return handleVerificationSetup(interaction);
  if (command === 'fpsguide') return interaction.reply({ embeds: [fpsGuideEmbed(interaction.options.getString('game', true))] });
  if (command === 'clipchallenge') {
    const week = Math.floor(Date.now() / 604800000);
    return interaction.reply({ embeds: [baseEmbed('Weekly Clip Operation', CHALLENGES[week % CHALLENGES.length]).addFields({ name: 'Rules', value: 'Use your own footage. Keep it under 30 seconds. Post the result in your server clip channel.' }, { name: 'Next operation', value: '<t:' + ((week + 1) * 604800) + ':R>' })] });
  }
  if (command === 'remind') return handleReminder(interaction, getDbConnection);
  if (command === 'suggest') return handleSuggestion(interaction, getDbConnection);
  if (command === 'suggestions') return handleSuggestions(interaction, getDbConnection);
  if (command === 'clipshare') return handleClipShare(interaction, getDbConnection);
  if (command === 'clips') return handleClips(interaction, getDbConnection);
  if (command === 'mission') return handleMission(interaction, getDbConnection);
  if (command === 'benchmark') return handleBenchmark(interaction, getDbConnection);
}

function normalizeAutoReplyConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const serverName = String(source.serverName || DEFAULT_AUTO_REPLY_CONFIG.serverName).trim().slice(0, 80) || DEFAULT_AUTO_REPLY_CONFIG.serverName;
  const mentionReply = String(source.mentionReply || DEFAULT_AUTO_REPLY_CONFIG.mentionReply).trim().slice(0, 500) || DEFAULT_AUTO_REPLY_CONFIG.mentionReply;
  const keywordReplies = String(source.keywordReplies || DEFAULT_AUTO_REPLY_CONFIG.keywordReplies).trim().slice(0, 4000) || DEFAULT_AUTO_REPLY_CONFIG.keywordReplies;
  return { enabled: source.enabled !== false, serverName, mentionReply, keywordReplies };
}

function normalizeWelcomeConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const channelId = String(source.channelId || '').trim();
  return { enabled: Boolean(source.enabled) && /^\d{16,22}$/.test(channelId), channelId };
}

function joinSourceOptions() {
  return [
    { label: 'Friend / member invitation', value: 'friend_or_member', description: 'Someone invited or told me about it' },
    { label: 'Discord server discovery', value: 'discord_discovery', description: 'I found it through Discord' },
    { label: 'TikTok / social media', value: 'social_media', description: 'I saw it on TikTok or another social app' },
    { label: 'Gaming community', value: 'gaming_community', description: 'I found it through a game or gaming group' },
    { label: 'Other', value: 'other', description: 'Something else' }
  ];
}

async function handleMemberWelcome(member, getConfig, getDbConnection) {
  if (member.user?.bot) return;
  const welcome = getConfig().welcome;
  if (!welcome.enabled) return;
  const channel = await member.guild.channels.fetch(welcome.channelId).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.send) return;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('elrancho:join-source:' + member.id)
    .setPlaceholder('Where did you find El Rancho?')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(joinSourceOptions());
  await channel.send({
    content: 'Welcome to **' + member.guild.name + '**, <@' + member.id + '>! 🎮',
    embeds: [baseEmbed('Quick welcome check-in', 'Where did you find the server? Your answer helps staff understand what brings people here. We save your selected answer, Discord user ID, username, account-created date, server-join date, and response time in the server database. We do not collect IP addresses, device data, or location.')],
    components: [new ActionRowBuilder().addComponents(menu)],
    allowedMentions: { parse: [], users: [member.id], roles: [] }
  });
}

async function handleJoinSourceSelect(interaction, getDbConnection) {
  const parts = String(interaction.customId || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'elrancho' || parts[1] !== 'join-source') return;
  if (parts[2] !== interaction.user.id) return interaction.reply({ content: 'This welcome menu belongs to another member.', ephemeral: true });
  const selected = String(interaction.values?.[0] || '');
  const valid = joinSourceOptions().some(option => option.value === selected);
  if (!valid || !interaction.guildId) return interaction.reply({ content: 'That answer is not valid. Please use the welcome menu again.', ephemeral: true });
  const connection = getDbConnection();
  if (!connection) return interaction.reply({ content: 'The server database is offline, so your answer was not saved. Please try again later.', ephemeral: true });
  try {
    await ensureBotTables(connection);
    const joinedAt = interaction.member?.joinedTimestamp ? new Date(interaction.member.joinedTimestamp) : new Date();
    await connection.query('INSERT INTO discord_join_sources (guild_id, discord_user_id, discord_username, account_created_at, joined_at, source) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE discord_username = VALUES(discord_username), account_created_at = VALUES(account_created_at), joined_at = VALUES(joined_at), source = VALUES(source), responded_at = CURRENT_TIMESTAMP', [interaction.guildId, interaction.user.id, interaction.user.username, new Date(interaction.user.createdTimestamp), joinedAt, selected]);
    const label = joinSourceOptions().find(option => option.value === selected)?.label || 'your answer';
    return interaction.reply({ content: 'Thanks — saved **' + label + '** as how you found the server.', ephemeral: true });
  } catch (error) { return interaction.reply({ content: 'Your answer could not be saved: ' + cleanError(error), ephemeral: true }); }
}

function parseKeywordReplies(value) {
  return String(value || '').split(/\r?\n/).map(line => {
    const divider = line.indexOf('=>');
    if (divider < 1) return null;
    const keywords = line.slice(0, divider).split('|').map(word => word.trim().toLowerCase()).filter(word => word.length >= 2 && word.length <= 64).slice(0, 10);
    const response = line.slice(divider + 2).trim().slice(0, 500);
    return keywords.length && response ? { keywords, response } : null;
  }).filter(Boolean).slice(0, 20);
}

const autoReplyCooldowns = new Map();
function canAutoReply(message) {
  const key = message.guildId + ':' + message.channelId + ':' + message.author.id;
  const now = Date.now(); const previous = autoReplyCooldowns.get(key) || 0;
  if (now - previous < 15000) return false;
  autoReplyCooldowns.set(key, now);
  if (autoReplyCooldowns.size > 2000) for (const [storedKey, timestamp] of autoReplyCooldowns) if (now - timestamp > 60000) autoReplyCooldowns.delete(storedKey);
  return true;
}
function replyTemplate(template, message, config) { return String(template).replaceAll('{user}', '<@' + message.author.id + '>').replaceAll('{server}', config.serverName); }
function parsePrefixCommand(content) {
  const raw = String(content || '').trim(); if (!raw.startsWith('!')) return null;
  const [command = '', ...parts] = raw.slice(1).split(/\s+/);
  return { command: command.toLowerCase(), arguments: parts.join(' ').trim() };
}
function memberCan(message, permission) { return Boolean(message.member?.permissions?.has(permission)); }
async function handleMessage(message, getConfig, client) {
  if (!message.guildId || message.author?.bot || !message.content) return;
  if (await handlePrefixCommand(message, getConfig)) return;
  const config = getConfig().autoReplies;
  if (!config.enabled || !canAutoReply(message)) return;
  let response = '';
  if (client.user && message.mentions.users.has(client.user.id)) response = config.mentionReply;
  else {
    const content = message.content.toLowerCase();
    const match = parseKeywordReplies(config.keywordReplies).find(rule => rule.keywords.some(keyword => new RegExp('(^|[^a-z0-9])' + escapeRegex(keyword) + '($|[^a-z0-9])', 'i').test(content)));
    response = match?.response || '';
  }
  if (response) await message.reply({ content: '**' + config.serverName + '** • ' + replyTemplate(response, message, config), allowedMentions: { parse: [], users: [message.author.id], roles: [] } });
}
async function sendPrefixHelp(message, staffOnly = false) {
  const publicCommands = ['`!cmds` — show this list', '`!rules` — post the server rules', '`!serverinfo` — show server information', '`!welcome` — post a welcome message', '`!security` — show community safety info'];
  const staffCommands = ['`!staffhelp` — show staff commands', '`!announce <message>` — post an announcement', '`!embed <title> | <message>` — post a formatted panel', '`!serverinvite` — post a seven-day server invite', '`!lock` / `!unlock` — lock or reopen this channel', '`!slowmode <0–21600>` — set channel slowmode'];
  const embed = baseEmbed(staffOnly ? 'El Rancho staff commands' : 'El Rancho commands', (staffOnly ? staffCommands : publicCommands).join('\n'));
  if (!staffOnly) embed.addFields({ name: 'Staff', value: 'Staff with the needed Discord permissions can use `!staffhelp`.' });
  return message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}
function prefixRulesEmbed(serverName) { return baseEmbed(serverName + ' rules', ['**1.** Be respectful — no harassment, hate, or targeted drama.', '**2.** Keep chats and voice channels chill; do not spam or mic spam.', '**3.** No NSFW, scams, malicious links, cheats, or account-selling.', '**4.** Use the right channels and listen to staff when they step in.', '**5.** Have fun, game together, and help keep ' + serverName + ' welcoming.'].join('\n')); }
async function handlePrefixCommand(message, getConfig) {
  const parsed = parsePrefixCommand(message.content); if (!parsed) return false;
  const { command, arguments: args } = parsed; const serverName = getConfig().autoReplies.serverName || message.guild.name || 'El Rancho';
  if (command === 'cmds') { await sendPrefixHelp(message); return true; }
  if (command === 'rules') { await message.reply({ embeds: [prefixRulesEmbed(serverName)], allowedMentions: { parse: [] } }); return true; }
  if (command === 'serverinfo') { await message.reply({ embeds: [baseEmbed(serverName + ' server information', 'Gaming, hanging out, and finding people to chill with in VC.').addFields({ name: 'Members', value: String(message.guild.memberCount || 0), inline: true }, { name: 'Channels', value: String(message.guild.channels.cache.size || 0), inline: true }, { name: 'Getting started', value: 'Read the rules, pick your roles, then jump into chat or VC.' })], allowedMentions: { parse: [] } }); return true; }
  if (command === 'welcome') { await message.reply({ embeds: [baseEmbed('Welcome to ' + serverName, 'Glad you are here. Say hi, find a game, or jump into VC and chill with everyone.')], allowedMentions: { parse: [] } }); return true; }
  if (command === 'security') { await message.reply({ embeds: [baseEmbed(serverName + ' safety', 'Do not share passwords or tokens, avoid suspicious links and downloads, and report scams or harassment to staff.')], allowedMentions: { parse: [] } }); return true; }
  const staffCommands = new Set(['staffhelp', 'announce', 'embed', 'serverinvite', 'lock', 'unlock', 'slowmode']);
  if (!staffCommands.has(command)) return false;
  if (!memberCan(message, PermissionFlagsBits.ManageGuild) && ['staffhelp', 'announce', 'embed', 'serverinvite'].includes(command)) { await message.reply('You need the **Manage Server** permission for that staff command.'); return true; }
  if (command === 'staffhelp') { await sendPrefixHelp(message, true); return true; }
  if (command === 'announce' || command === 'embed') {
    if (!args) { await message.reply(command === 'announce' ? 'Use `!announce <message>`.' : 'Use `!embed <title> | <message>`.'); return true; }
    if (command === 'announce') await message.channel.send({ embeds: [baseEmbed('📢 ' + serverName + ' announcement', args.slice(0, 4000))], allowedMentions: { parse: [] } });
    else { const divider = args.indexOf('|'); if (divider < 1) await message.reply('Use `!embed <title> | <message>`.'); else await message.channel.send({ embeds: [baseEmbed(args.slice(0, divider).trim(), args.slice(divider + 1).trim() || ' ')], allowedMentions: { parse: [] } }); }
    return true;
  }
  if (command === 'serverinvite') {
    if (!message.channel?.createInvite) { await message.reply('Use this command in a regular server text channel.'); return true; }
    try { const invite = await message.channel.createInvite({ maxAge: 604800, maxUses: 0, unique: true, reason: 'El Rancho staff invite by ' + message.author.tag }); await message.channel.send({ embeds: [baseEmbed('Join ' + serverName, 'El Rancho is a chill gaming and hangout server to talk in VC, play games, meet people, and have a good time.\n\n[Join the server](https://discord.gg/' + invite.code + ')')], allowedMentions: { parse: [] } }); }
    catch { await message.reply('I could not create an invite. Give the bot the **Create Invite** permission in this channel and try again.'); }
    return true;
  }
  if (!memberCan(message, PermissionFlagsBits.ManageChannels)) { await message.reply('You need the **Manage Channels** permission for that channel security command.'); return true; }
  if (!message.channel?.permissionOverwrites?.edit || !message.guild?.roles?.everyone) { await message.reply('That command only works in a standard server text channel.'); return true; }
  if (command === 'lock' || command === 'unlock') { await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: command === 'lock' ? false : null }, { reason: 'El Rancho staff command by ' + message.author.tag }); await message.channel.send({ content: command === 'lock' ? '🔒 This channel is now locked by staff.' : '🔓 This channel is open again.', allowedMentions: { parse: [] } }); return true; }
  const seconds = Number(args); if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) { await message.reply('Use `!slowmode <0–21600>` — use 0 to turn it off.'); return true; }
  if (!message.channel.setRateLimitPerUser) { await message.reply('This channel does not support slowmode.'); return true; }
  await message.channel.setRateLimitPerUser(seconds, 'El Rancho staff command by ' + message.author.tag); await message.channel.send({ content: seconds ? '⏱️ Slowmode is now ' + seconds + ' second(s).' : '⏱️ Slowmode is now off.', allowedMentions: { parse: [] } }); return true;
}
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function handleServer(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Use this command inside a server.', ephemeral: true });
  const embed = baseEmbed(interaction.guild.name + ' operations', 'CoreShift is connected and ready.')
    .addFields(
      { name: 'Members', value: String(interaction.guild.memberCount), inline: true },
      { name: 'Channels', value: String(interaction.guild.channels.cache.size), inline: true },
      { name: 'Roles', value: String(Math.max(0, interaction.guild.roles.cache.size - 1)), inline: true },
      { name: 'Created', value: '<t:' + Math.floor(interaction.guild.createdTimestamp / 1000) + ':R>', inline: true },
      { name: 'Boosts', value: String(interaction.guild.premiumSubscriptionCount || 0), inline: true }
    );
  const icon = interaction.guild.iconURL({ size: 256 });
  if (icon) embed.setThumbnail(icon);
  return interaction.reply({ embeds: [embed] });
}
function handleMemberCount(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Use this command inside a server.', ephemeral: true });
  const cachedMembers = [...interaction.guild.members.cache.values()];
  const cachedBots = cachedMembers.filter(member => member.user?.bot).length;
  return interaction.reply({ embeds: [baseEmbed(interaction.guild.name + ' member count', 'A live count from Discord. Cached bot counts can be lower until Discord loads every member.')
    .addFields(
      { name: 'Total members', value: String(interaction.guild.memberCount), inline: true },
      { name: 'Cached bots', value: String(cachedBots), inline: true },
      { name: 'Cached humans', value: String(Math.max(0, cachedMembers.length - cachedBots)), inline: true }
    )] });
}
function handleChannelInfo(interaction) {
  const channel = interaction.channel;
  if (!interaction.guild || !channel) return interaction.reply({ content: 'Use this command inside a server channel.', ephemeral: true });
  const topic = typeof channel.topic === 'string' && channel.topic.trim() ? channel.topic.trim() : 'No topic set.';
  const parent = channel.parent?.name ? '#' + channel.parent.name : 'No category';
  const created = channel.createdTimestamp ? '<t:' + Math.floor(channel.createdTimestamp / 1000) + ':R>' : 'Unavailable';
  return interaction.reply({ embeds: [baseEmbed('Channel: #' + channel.name, topic)
    .addFields(
      { name: 'Channel ID', value: channel.id, inline: true },
      { name: 'Category', value: parent, inline: true },
      { name: 'Created', value: created, inline: true }
    )], allowedMentions: { parse: [] } });
}
function handleRoleInfo(interaction) {
  const role = interaction.options.getRole('role', true);
  const permissions = describeRolePermissions(role);
  return interaction.reply({ embeds: [baseEmbed('Role: ' + role.name, 'Details for this server role.')
    .addFields(
      { name: 'Role ID', value: role.id, inline: true },
      { name: 'Cached members', value: String(role.members.size), inline: true },
      { name: 'Color', value: role.hexColor || 'Default', inline: true },
      { name: 'Permissions', value: permissions, inline: false },
      { name: 'Created', value: '<t:' + Math.floor(role.createdTimestamp / 1000) + ':R>', inline: true }
    )], allowedMentions: { parse: [] } });
}
function handleServerIcon(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Use this command inside a server.', ephemeral: true });
  const icon = interaction.guild.iconURL({ size: 1024, extension: 'png' });
  if (!icon) return interaction.reply({ content: 'This server does not have a custom icon.', ephemeral: true });
  return interaction.reply({ embeds: [baseEmbed(interaction.guild.name + ' icon', '[Open full-size server icon](' + icon + ')').setImage(icon)] });
}
function handleRoles(interaction) {
  const roles = [...interaction.guild.roles.cache.values()]
    .filter(role => role.id !== interaction.guildId && !role.managed)
    .sort((a, b) => b.position - a.position)
    .slice(0, 20);
  const lines = roles.map(role => role.toString() + ' - ' + role.members.size + ' cached member(s)');
  return interaction.reply({ embeds: [baseEmbed(interaction.guild.name + ' roles', lines.join('\n') || 'No custom roles were found.')], allowedMentions: { parse: [] } });
}
function handleAvatar(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const url = user.displayAvatarURL({ size: 1024, extension: 'png' });
  return interaction.reply({ embeds: [baseEmbed(user.username + ' avatar', '[Open full-size avatar](' + url + ')').setImage(url)] });
}
function handleUserInfo(interaction) {
  const user = interaction.options.getUser('user') || interaction.user;
  const member = interaction.options.getMember('user') || (user.id === interaction.user.id ? interaction.member : null);
  const embed = baseEmbed('User: ' + user.username, 'Discord profile information.')
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: 'User ID', value: user.id, inline: true },
      { name: 'Account created', value: '<t:' + Math.floor(user.createdTimestamp / 1000) + ':R>', inline: true },
      { name: 'Bot account', value: user.bot ? 'Yes' : 'No', inline: true }
    );
  if (member?.joinedTimestamp) embed.addFields({ name: 'Joined server', value: '<t:' + Math.floor(member.joinedTimestamp / 1000) + ':R>', inline: true });
  return interaction.reply({ embeds: [embed], ephemeral: true });
}
function handleChoose(interaction) {
  const options = interaction.options.getString('options', true).split(',').map(value => value.trim()).filter(Boolean).slice(0, 25);
  if (options.length < 2) return interaction.reply({ content: 'Give me at least two comma-separated choices.', ephemeral: true });
  const selected = options[Math.floor(Math.random() * options.length)];
  return interaction.reply({ embeds: [baseEmbed('CoreShift chose', '**' + escapeDiscord(selected) + '**\n\nFrom: ' + options.map(escapeDiscord).join(', '))] });
}
function handleRandom(interaction) {
  const minimum = interaction.options.getInteger('minimum', true);
  const maximum = interaction.options.getInteger('maximum', true);
  if (minimum > maximum) return interaction.reply({ content: 'Minimum must be less than or equal to maximum.', ephemeral: true });
  const result = crypto.randomInt(minimum, maximum + 1);
  return interaction.reply({ embeds: [baseEmbed('Random number', '**' + result + '**\nRange: ' + minimum + ' to ' + maximum)] });
}
function handleRoll(interaction) {
  const raw = interaction.options.getString('dice', true).replace(/\s+/g, '').toLowerCase();
  const match = raw.match(/^(\d{1,2})d(\d{1,4})(?:([+-])(\d{1,4}))?$/);
  if (!match) return interaction.reply({ content: 'Use dice notation like `1d20`, `2d6+3`, or `4d8-1`.', ephemeral: true });
  const count = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] ? (match[3] === '-' ? -1 : 1) * Number(match[4]) : 0;
  if (count < 1 || count > 20 || sides < 2 || sides > 1000 || Math.abs(modifier) > 1000) return interaction.reply({ content: 'Use between 1d2 and 20d1000, with a modifier no larger than 1000.', ephemeral: true });
  const rolls = Array.from({ length: count }, () => crypto.randomInt(1, sides + 1));
  const total = rolls.reduce((sum, value) => sum + value, 0) + modifier;
  const modifierText = modifier ? (modifier > 0 ? ' + ' : ' - ') + Math.abs(modifier) : '';
  return interaction.reply({ embeds: [baseEmbed('Dice roll: ' + raw, '**' + total + '** total').addFields({ name: 'Rolls', value: rolls.join(', '), inline: false }, { name: 'Formula', value: count + 'd' + sides + modifierText, inline: true })] });
}
async function handlePoll(interaction) {
  if (!hasPermission(interaction, PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: 'You need the Manage Messages permission to create a poll.', ephemeral: true });
  const options = ['option1', 'option2', 'option3', 'option4'].map(name => interaction.options.getString(name)).filter(Boolean).map(value => value.trim());
  if (new Set(options.map(value => value.toLowerCase())).size !== options.length) return interaction.reply({ content: 'Each poll option needs to be different.', ephemeral: true });
  const question = interaction.options.getString('question', true).trim();
  const hours = interaction.options.getInteger('hours', true);
  const multiple = Boolean(interaction.options.getBoolean('multiple'));
  return interaction.reply({
    poll: { question: { text: question }, answers: options.map(text => ({ text })), duration: hours, allowMultiselect: multiple },
    allowedMentions: { parse: [] }
  });
}
function handleAnnouncement(interaction) {
  if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'You need the Manage Server permission to post an announcement.', ephemeral: true });
  const title = interaction.options.getString('title', true).trim();
  const message = interaction.options.getString('message', true).trim();
  return interaction.reply({
    embeds: [baseEmbed(title, message).setAuthor({ name: interaction.guild?.name || 'Server announcement' }).addFields({ name: 'Posted by', value: interaction.user.toString(), inline: true })],
    allowedMentions: { parse: [] }
  });
}
async function handleVerificationSetup(interaction) {
  if (!interaction.guild) return interaction.reply({ content: 'Use this command inside the server where members will verify.', ephemeral: true });
  if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: 'You need the Manage Server permission to set up verification.', ephemeral: true });
  const role = interaction.options.getRole('role', true);
  const botMember = await getBotMember(interaction.guild);
  const setupError = verificationRoleError(role, interaction.guild, botMember);
  if (setupError) return interaction.reply({ content: setupError, ephemeral: true });
  const rules = interaction.options.getString('rules')?.trim() || 'I have read the server rules and agree to follow them.';
  const button = new ButtonBuilder()
    .setCustomId('coreshift:verify:' + role.id)
    .setLabel('I agree & verify')
    .setStyle(ButtonStyle.Success);
  return interaction.reply({
    embeds: [baseEmbed('Server verification', 'Read the server rules, then use the button below to receive access.')
      .addFields(
        { name: 'Rules acknowledgement', value: rules, inline: false },
        { name: 'Privacy notice', value: 'This verification does **not** collect IP addresses, VPN status, location, device identifiers, or browser data. It only assigns the selected Discord role.', inline: false },
        { name: 'Moderation notice', value: 'CoreShift cannot IP-ban members. Server moderators must use Discord’s built-in moderation and ban tools for enforcement.', inline: false }
      )],
    components: [new ActionRowBuilder().addComponents(button)],
    allowedMentions: { parse: [] }
  });
}
async function handleVerificationButton(interaction) {
  if (!interaction.customId.startsWith('coreshift:verify:')) return;
  await interaction.deferReply({ ephemeral: true });
  const roleId = interaction.customId.slice('coreshift:verify:'.length);
  if (!/^\d{16,22}$/.test(roleId)) return interaction.editReply({ content: 'This verification button is invalid. Ask a server manager to post a new one.' });
  if (!interaction.guild || !interaction.member) return interaction.editReply({ content: 'Use this verification button inside its server.' });
  if (interaction.message?.author?.id !== interaction.client.user?.id) return interaction.editReply({ content: 'For your safety, only use verification buttons posted by CoreShift.' });
  const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
  const botMember = await getBotMember(interaction.guild);
  const roleError = verificationRoleError(role, interaction.guild, botMember);
  if (roleError) return interaction.editReply({ content: roleError });
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return interaction.editReply({ content: 'I could not read your server membership. Please try again.' });
  if (member.roles.cache.has(role.id)) return interaction.editReply({ content: 'You are already verified.' });
  try {
    await member.roles.add(role, 'CoreShift member self-verification');
    return interaction.editReply({ content: 'Verified — you now have the ' + role.toString() + ' role. CoreShift did not collect your IP address, VPN status, location, or device information.', allowedMentions: { parse: [] } });
  } catch (error) {
    return interaction.editReply({ content: 'I could not assign that role. Make sure CoreShift has Manage Roles and its highest role is above the verification role.' });
  }
}
async function getBotMember(guild) {
  return guild.members.me || guild.members.fetchMe().catch(() => null);
}
function verificationRoleError(role, guild, botMember) {
  if (!role || role.guild?.id !== guild.id) return 'That verification role no longer exists in this server.';
  if (role.id === guild.id || role.managed) return 'Choose a normal server role for verification, not @everyone or an integration-managed role.';
  if (!botMember?.permissions?.has(PermissionFlagsBits.ManageRoles)) return 'CoreShift needs the Manage Roles permission before it can verify members.';
  if (!botMember.roles?.highest || role.position >= botMember.roles.highest.position) return 'Move the CoreShift role above the verification role in Server Settings → Roles, then try again.';
  return '';
}
function hasPermission(interaction, permission) {
  return Boolean(interaction.memberPermissions?.has(permission));
}
function describeRolePermissions(role) {
  if (role.permissions.has(PermissionFlagsBits.Administrator)) return 'Administrator';
  const labels = [
    [PermissionFlagsBits.ManageGuild, 'Manage Server'],
    [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
    [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    [PermissionFlagsBits.KickMembers, 'Kick Members'],
    [PermissionFlagsBits.BanMembers, 'Ban Members'],
    [PermissionFlagsBits.MentionEveryone, 'Mention Everyone']
  ].filter(([permission]) => role.permissions.has(permission)).map(([, label]) => label);
  return labels.length ? labels.join(', ') : 'No elevated server permissions';
}

async function handleReminder(interaction, getDbConnection) {
  const connection = getDbConnection();
  if (!connection) return mysqlOffline(interaction);
  await interaction.deferReply({ ephemeral: true });
  await ensureBotTables(connection);
  const minutes = interaction.options.getInteger('minutes', true);
  const message = interaction.options.getString('message', true);
  const remindAt = new Date(Date.now() + minutes * 60000);
  await connection.query('INSERT INTO discord_reminders (guild_id, channel_id, discord_user_id, reminder_text, remind_at) VALUES (?, ?, ?, ?, ?)', [interaction.guildId, interaction.channelId, interaction.user.id, message, remindAt]);
  return interaction.editReply({ content: 'Reminder saved for <t:' + Math.floor(remindAt.getTime() / 1000) + ':F> (<t:' + Math.floor(remindAt.getTime() / 1000) + ':R>).' });
}
async function handleSuggestion(interaction, getDbConnection) {
  const connection = getDbConnection();
  if (!connection) return mysqlOffline(interaction);
  await interaction.deferReply();
  await ensureBotTables(connection);
  const idea = interaction.options.getString('idea', true);
  const [result] = await connection.query('INSERT INTO discord_suggestions (guild_id, discord_user_id, discord_username, suggestion) VALUES (?, ?, ?, ?)', [interaction.guildId, interaction.user.id, interaction.user.username, idea]);
  return interaction.editReply({ embeds: [baseEmbed('Suggestion #' + result.insertId, idea).addFields({ name: 'Submitted by', value: interaction.user.toString() })] });
}
async function handleSuggestions(interaction, getDbConnection) {
  const connection = getDbConnection();
  if (!connection) return mysqlOffline(interaction);
  await interaction.deferReply();
  await ensureBotTables(connection);
  const [rows] = await connection.query('SELECT id, discord_username, suggestion, status FROM discord_suggestions WHERE guild_id = ? ORDER BY id DESC LIMIT 8', [interaction.guildId]);
  const lines = rows.map(row => '**#' + row.id + ' [' + escapeDiscord(row.status) + ']** ' + escapeDiscord(row.suggestion).slice(0, 240) + ' - ' + escapeDiscord(row.discord_username));
  return interaction.editReply({ embeds: [baseEmbed('Latest community suggestions', lines.join('\n\n') || 'No suggestions yet. Use /suggest to add one.')] });
}
async function handleClipShare(interaction, getDbConnection) {
  const connection = getDbConnection();
  if (!connection) return mysqlOffline(interaction);
  const rawUrl = interaction.options.getString('url', true);
  let url;
  try { url = new URL(rawUrl); } catch { return interaction.reply({ content: 'Enter a valid HTTPS clip URL.', ephemeral: true }); }
  if (url.protocol !== 'https:') return interaction.reply({ content: 'Clip links must use HTTPS.', ephemeral: true });
  await interaction.deferReply();
  await ensureBotTables(connection);
  const game = interaction.options.getString('game') || 'Unspecified game';
  const caption = interaction.options.getString('caption') || 'No caption supplied.';
  const [result] = await connection.query('INSERT INTO discord_shared_clips (guild_id, discord_user_id, discord_username, clip_url, game, caption) VALUES (?, ?, ?, ?, ?, ?)', [interaction.guildId, interaction.user.id, interaction.user.username, url.toString(), game, caption]);
  return interaction.editReply({ embeds: [baseEmbed('Clip #' + result.insertId + ': ' + game, caption).addFields({ name: 'Watch', value: '[Open clip](' + url.toString() + ')', inline: true }, { name: 'Shared by', value: interaction.user.toString(), inline: true })] });
}
async function handleClips(interaction, getDbConnection) {
  const connection = getDbConnection();
  if (!connection) return mysqlOffline(interaction);
  await interaction.deferReply();
  await ensureBotTables(connection);
  const [rows] = await connection.query('SELECT id, discord_username, clip_url, game, caption FROM discord_shared_clips WHERE guild_id = ? ORDER BY id DESC LIMIT 6', [interaction.guildId]);
  const lines = rows.map(row => '**#' + row.id + ' ' + escapeDiscord(row.game) + '** - [' + escapeDiscord(row.discord_username) + '](' + row.clip_url + ')\n' + escapeDiscord(row.caption).slice(0, 220));
  return interaction.editReply({ embeds: [baseEmbed('Recent community clips', lines.join('\n\n') || 'No clips yet. Use /clipshare to add one.')] });
}

async function handleMission(interaction, getDbConnection) {
  const connection = getDbConnection();
  if (!connection) return mysqlOffline(interaction);
  await interaction.deferReply();
  await ensureBotTables(connection);
  const action = interaction.options.getSubcommand();
  if (action === 'view') {
    const [rows] = await connection.query('SELECT title, description, reward, created_at FROM discord_missions WHERE guild_id = ? AND active = 1 ORDER BY id DESC LIMIT 1', [interaction.guildId]);
    if (!rows[0]) return interaction.editReply({ embeds: [baseEmbed('No active mission', 'A server manager can create one with /mission create.')] });
    const mission = rows[0];
    return interaction.editReply({ embeds: [baseEmbed(mission.title, mission.description).addFields({ name: 'Reward', value: mission.reward || 'Server recognition', inline: true }, { name: 'Launched', value: '<t:' + Math.floor(new Date(mission.created_at).getTime() / 1000) + ':R>', inline: true })] });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.editReply({ content: 'You need the Manage Server permission for that mission action.' });
  if (action === 'create') {
    const title = interaction.options.getString('title', true);
    const description = interaction.options.getString('description', true);
    const reward = interaction.options.getString('reward') || 'Server recognition';
    await connection.query('UPDATE discord_missions SET active = 0 WHERE guild_id = ?', [interaction.guildId]);
    await connection.query('INSERT INTO discord_missions (guild_id, title, description, reward, created_by_discord_id, active) VALUES (?, ?, ?, ?, ?, 1)', [interaction.guildId, title, description, reward, interaction.user.id]);
    return interaction.editReply({ embeds: [baseEmbed('Mission launched: ' + title, description).addFields({ name: 'Reward', value: reward })] });
  }
  await connection.query('UPDATE discord_missions SET active = 0 WHERE guild_id = ? AND active = 1', [interaction.guildId]);
  return interaction.editReply({ embeds: [baseEmbed('Mission closed', 'The active community mission has been archived.')] });
}

async function handleBenchmark(interaction, getDbConnection) {
  const connection = getDbConnection();
  if (!connection) return mysqlOffline(interaction);
  await interaction.deferReply();
  await ensureBotTables(connection);
  const action = interaction.options.getSubcommand();
  if (action === 'submit') {
    const game = interaction.options.getString('game', true);
    const before = interaction.options.getInteger('before', true);
    const after = interaction.options.getInteger('after', true);
    const notes = interaction.options.getString('notes') || '';
    await connection.query('INSERT INTO discord_benchmarks (guild_id, discord_user_id, discord_username, game, before_fps, after_fps, notes) VALUES (?, ?, ?, ?, ?, ?, ?)', [interaction.guildId, interaction.user.id, interaction.user.username, game, before, after, notes]);
    const difference = after - before;
    const percent = before ? difference / before * 100 : 0;
    return interaction.editReply({ embeds: [baseEmbed('Benchmark recorded: ' + game, '**' + before + ' FPS -> ' + after + ' FPS**').addFields({ name: 'Difference', value: (difference >= 0 ? '+' : '') + difference + ' FPS', inline: true }, { name: 'Change', value: (percent >= 0 ? '+' : '') + percent.toFixed(1) + '%', inline: true }, { name: 'Submitted by', value: interaction.user.toString(), inline: true }, { name: 'Notes', value: notes || 'No notes supplied.' })] });
  }
  const game = interaction.options.getString('game');
  const params = [interaction.guildId];
  let sql = 'SELECT discord_username, game, before_fps, after_fps FROM discord_benchmarks WHERE guild_id = ?';
  if (game) { sql += ' AND LOWER(game) = LOWER(?)'; params.push(game); }
  sql += ' ORDER BY (after_fps - before_fps) DESC, id DESC LIMIT 10';
  const [rows] = await connection.query(sql, params);
  const lines = rows.map((row, index) => {
    const difference = Number(row.after_fps) - Number(row.before_fps);
    return '**' + (index + 1) + '. ' + escapeDiscord(row.discord_username) + '** - ' + escapeDiscord(row.game) + ' - ' + row.before_fps + ' -> ' + row.after_fps + ' FPS (' + (difference >= 0 ? '+' : '') + difference + ')';
  });
  return interaction.editReply({ embeds: [baseEmbed(game ? game + ' benchmark leaderboard' : 'FPS improvement leaderboard', lines.join('\n') || 'No benchmarks have been submitted yet. Use /benchmark submit.')] });
}

async function ensureBotTables(connection) {
  await connection.query('CREATE TABLE IF NOT EXISTS discord_missions (id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(32) NOT NULL, title VARCHAR(100) NOT NULL, description TEXT NOT NULL, reward VARCHAR(200), created_by_discord_id VARCHAR(32) NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_discord_mission (guild_id, active))');
  await connection.query('CREATE TABLE IF NOT EXISTS discord_benchmarks (id INT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(32) NOT NULL, discord_user_id VARCHAR(32) NOT NULL, discord_username VARCHAR(100) NOT NULL, game VARCHAR(80) NOT NULL, before_fps INT NOT NULL, after_fps INT NOT NULL, notes VARCHAR(400), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_discord_benchmark (guild_id, game))');
  await connection.query('CREATE TABLE IF NOT EXISTS discord_reminders (id BIGINT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(32) NOT NULL, channel_id VARCHAR(32) NOT NULL, discord_user_id VARCHAR(32) NOT NULL, reminder_text VARCHAR(500) NOT NULL, remind_at DATETIME NOT NULL, delivered TINYINT NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_discord_reminder_due (delivered, remind_at))');
  await connection.query('CREATE TABLE IF NOT EXISTS discord_suggestions (id BIGINT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(32) NOT NULL, discord_user_id VARCHAR(32) NOT NULL, discord_username VARCHAR(100) NOT NULL, suggestion TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT "open", created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_discord_suggestion (guild_id, id))');
  await connection.query('CREATE TABLE IF NOT EXISTS discord_shared_clips (id BIGINT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(32) NOT NULL, discord_user_id VARCHAR(32) NOT NULL, discord_username VARCHAR(100) NOT NULL, clip_url TEXT NOT NULL, game VARCHAR(80), caption VARCHAR(300), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_discord_clips (guild_id, id))');
  await connection.query('CREATE TABLE IF NOT EXISTS discord_join_sources (id BIGINT AUTO_INCREMENT PRIMARY KEY, guild_id VARCHAR(32) NOT NULL, discord_user_id VARCHAR(32) NOT NULL, discord_username VARCHAR(100) NOT NULL, account_created_at DATETIME NOT NULL, joined_at DATETIME NOT NULL, source VARCHAR(64) NOT NULL, responded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_discord_join_source (guild_id, discord_user_id), INDEX idx_discord_join_source (guild_id, source))');
}

async function deliverDueReminders(client, getDbConnection) {
  const connection = getDbConnection();
  if (!connection || !client.isReady()) return;
  await ensureBotTables(connection);
  const [rows] = await connection.query('SELECT id, channel_id, discord_user_id, reminder_text FROM discord_reminders WHERE delivered = 0 AND remind_at <= NOW() ORDER BY remind_at ASC LIMIT 20');
  for (const row of rows) {
    const channel = await client.channels.fetch(row.channel_id).catch(() => null);
    if (!channel?.isTextBased?.()) {
      await connection.query('UPDATE discord_reminders SET delivered = -1 WHERE id = ?', [row.id]);
      continue;
    }
    try {
      await channel.send({ content: '<@' + row.discord_user_id + '> **Reminder:** ' + row.reminder_text, allowedMentions: { parse: [], users: [row.discord_user_id], roles: [] } });
      await connection.query('UPDATE discord_reminders SET delivered = 1 WHERE id = ?', [row.id]);
    } catch (error) {
      console.error('Discord reminder delivery failed:', cleanError(error));
    }
  }
}

function fpsGuideEmbed(game) {
  const value = game.toLowerCase();
  let tips = ['Use exclusive fullscreen when the game supports it.', 'Cap FPS slightly below a stable limit instead of chasing unstable peaks.', 'Lower shadows, volumetrics, reflections, and view distance before textures.', 'Keep GPU drivers current and close unnecessary capture tools.', 'Measure changes in the same location with the same conditions.'];
  if (/fortnite/.test(value)) tips = ['Try Performance Mode or DX12 and test both after shader compilation.', 'Disable Nanite/Lumen for competitive settings.', 'Use a stable frame cap matched to your monitor.', ...tips.slice(3)];
  else if (/valorant/.test(value)) tips = ['Enable Multithreaded Rendering.', 'Keep Material, Detail, and UI quality low for competitive play.', 'NVIDIA Reflex or AMD Anti-Lag can reduce latency when GPU-bound.', ...tips.slice(3)];
  else if (/minecraft/.test(value)) tips = ['Reduce render and simulation distance.', 'Use Sodium for Fabric or a trusted optimization pack for your loader.', 'Avoid assigning excessive RAM; 4-8 GB is normally enough for common modpacks.', ...tips.slice(3)];
  else if (/roblox/.test(value)) tips = ['Use automatic or manual graphics levels appropriate for the experience.', 'Disable heavy overlays and test fullscreen.', 'Performance depends heavily on each experience scripts and assets.', ...tips.slice(3)];
  return baseEmbed('FPS guide: ' + game, tips.map((tip, index) => '**' + (index + 1) + '.** ' + tip).join('\n')).setFooter({ text: 'CoreShift never promises fake FPS gains. Test one change at a time.' });
}
function baseEmbed(title, description) {
  return new EmbedBuilder().setColor(Colors.Green).setTitle(String(title).slice(0, 256)).setDescription(String(description).slice(0, 4096)).setTimestamp().setFooter({ text: 'CoreShift Operations Network' });
}
function mysqlOffline(interaction) {
  return interaction.reply({ content: 'CoreShift MySQL is offline. Start XAMPP and connect the desktop app first.', ephemeral: true });
}
function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return [days ? days + 'd' : '', hours ? hours + 'h' : '', minutes + 'm'].filter(Boolean).join(' ');
}
function syncMessage(sync) {
  const guildPart = sync.guildSync?.succeeded ? ' Instant server copies: ' + sync.guildSync.succeeded + '/' + (sync.guildSync.succeeded + sync.guildSync.failed) + '.' : '';
  const testGuildPart = sync.testGuildId ? ' Test server: ' + sync.guildCount + '/' + sync.expectedCount + '.' : '';
  const warning = sync.guildError ? ' Test-server mirror failed: ' + sync.guildError : '';
  const syncWarning = sync.guildSync?.failed ? ' ' + sync.guildSync.failed + ' server sync(s) failed.' : '';
  return 'Global commands synchronized: ' + sync.globalCount + '/' + sync.expectedCount + '.' + guildPart + testGuildPart + warning + syncWarning;
}
async function safeInteractionError(interaction, error) {
  const content = 'CoreShift command failed: ' + cleanError(error);
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => {});
  else await interaction.reply({ content, ephemeral: true }).catch(() => {});
}
function escapeDiscord(value) {
  return String(value || '').replace(/([\\`*_{}[\]()#+\-.!|>~])/g, '\\$1').slice(0, 1000);
}
function cleanDiscordError(error) {
  const message = cleanError(error);
  if (/token|401|unauthorized/i.test(message)) return 'Discord rejected the bot token. Reset it on the Developer Portal Bot page, then paste the new token into CoreShift.';
  if (/missing access|unknown guild|50001|10004/i.test(message)) return 'The bot cannot access the Test Server ID. Invite the bot to that server or clear the Test Server ID; global commands were still synchronized when possible.';
  if (/used disallowed intents|4014/i.test(message)) return 'Discord rejected a required gateway intent. Open Discord Developer Portal → Bot → Privileged Gateway Intents, enable Message Content Intent and Server Members Intent, then restart the bot.';
  return message;
}
function cleanError(error) {
  return String(error?.message || error || 'Discord bot operation failed.').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
}

module.exports = { registerDiscordBot, APPLICATION_ID, COMMANDS, COMMAND_NAMES, PREFIX_COMMANDS, FORBIDDEN_COMMAND_NAMES, isDestructiveCommandName, parsePrefixCommand, ensureBotTables };
