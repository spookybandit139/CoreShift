'use strict';

const REGISTERED_CHANNELS = [
  'pia:panel',
  'pia:links:list',
  'pia:links:save',
  'pia:links:delete',
  'pia:formats:list',
  'pia:formats:save',
  'pia:formats:delete'
];

function registerPiaIpc({ ipcMain, fs, path, getDbConnection, getActiveAccount }) {
  for (const channel of REGISTERED_CHANNELS) ipcMain.removeHandler(channel);

  function handle(channel, operation) {
    ipcMain.handle(channel, async (_event, payload) => {
      try { return await operation(payload); }
      catch (error) { return { success: false, message: readableError(error) }; }
    });
  }

  function requireAdmin() {
    const account = getActiveAccount();
    if (!account || account.role !== 'admin') throw new Error('Administrator access is required for the PIA channel.');
    return account;
  }

  async function requireDatabase() {
    const account = requireAdmin();
    const connection = getDbConnection();
    if (!connection) throw new Error('The PIA channel requires an active MySQL connection.');
    await ensureTables(connection);
    return { account, connection };
  }

  async function ensureTables(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS pia_staff_links (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      team_name VARCHAR(100) NOT NULL,
      title VARCHAR(120) NOT NULL,
      url TEXT NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      created_by VARCHAR(40) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await connection.query(`CREATE TABLE IF NOT EXISTS pia_formats (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      section_name VARCHAR(100) NOT NULL,
      title VARCHAR(120) NOT NULL,
      content MEDIUMTEXT NOT NULL,
      created_by VARCHAR(40) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  handle('pia:panel', async () => {
    requireAdmin();
    const panelPath = path.join(__dirname, '..', 'html', 'panels', 'pia.html');
    const html = await fs.promises.readFile(panelPath, 'utf8');
    return { success: true, html };
  });

  handle('pia:links:list', async () => {
    const { connection } = await requireDatabase();
    const [rows] = await connection.query('SELECT id, team_name, title, url, description, created_by, created_at, updated_at FROM pia_staff_links ORDER BY team_name, title');
    return { success: true, rows };
  });

  handle('pia:links:save', async payload => {
    const { account, connection } = await requireDatabase();
    const id = optionalId(payload?.id);
    const teamName = requiredText(payload?.teamName, 'Team or division', 100);
    const title = requiredText(payload?.title, 'Link title', 120);
    const url = validHttpUrl(payload?.url);
    const description = optionalText(payload?.description, 500);
    if (id) {
      const [result] = await connection.query('UPDATE pia_staff_links SET team_name = ?, title = ?, url = ?, description = ? WHERE id = ?', [teamName, title, url, description, id]);
      if (!result.affectedRows) throw new Error('That staff link no longer exists.');
      return { success: true, id, message: 'PIA staff link updated in MySQL.' };
    }
    const [result] = await connection.query('INSERT INTO pia_staff_links (team_name, title, url, description, created_by) VALUES (?, ?, ?, ?, ?)', [teamName, title, url, description, account.username]);
    return { success: true, id: result.insertId, message: 'PIA staff link saved to MySQL.' };
  });

  handle('pia:links:delete', async payload => {
    const { connection } = await requireDatabase();
    const id = requiredId(payload?.id ?? payload);
    const [result] = await connection.query('DELETE FROM pia_staff_links WHERE id = ?', [id]);
    if (!result.affectedRows) throw new Error('That staff link no longer exists.');
    return { success: true, message: 'PIA staff link deleted.' };
  });

  handle('pia:formats:list', async () => {
    const { connection } = await requireDatabase();
    const [rows] = await connection.query('SELECT id, section_name, title, content, created_by, created_at, updated_at FROM pia_formats ORDER BY section_name, title');
    return { success: true, rows };
  });

  handle('pia:formats:save', async payload => {
    const { account, connection } = await requireDatabase();
    const id = optionalId(payload?.id);
    const sectionName = requiredText(payload?.sectionName, 'Format section', 100);
    const title = requiredText(payload?.title, 'Format title', 120);
    const content = requiredMultiline(payload?.content, 'Format content', 100000);
    if (id) {
      const [result] = await connection.query('UPDATE pia_formats SET section_name = ?, title = ?, content = ? WHERE id = ?', [sectionName, title, content, id]);
      if (!result.affectedRows) throw new Error('That format no longer exists.');
      return { success: true, id, message: 'PIA format updated in MySQL.' };
    }
    const [result] = await connection.query('INSERT INTO pia_formats (section_name, title, content, created_by) VALUES (?, ?, ?, ?)', [sectionName, title, content, account.username]);
    return { success: true, id: result.insertId, message: 'PIA format saved to MySQL.' };
  });

  handle('pia:formats:delete', async payload => {
    const { connection } = await requireDatabase();
    const id = requiredId(payload?.id ?? payload);
    const [result] = await connection.query('DELETE FROM pia_formats WHERE id = ?', [id]);
    if (!result.affectedRows) throw new Error('That format no longer exists.');
    return { success: true, message: 'PIA format deleted.' };
  });
}

function requiredText(value, label, maximum) {
  const output = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!output) throw new Error(`${label} is required.`);
  if (output.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer.`);
  return output;
}

function optionalText(value, maximum) {
  const output = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (output.length > maximum) throw new Error(`Description must be ${maximum} characters or fewer.`);
  return output;
}

function requiredMultiline(value, label, maximum) {
  const output = String(value ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!output) throw new Error(`${label} is required.`);
  if (output.length > maximum) throw new Error(`${label} must be ${maximum.toLocaleString()} characters or fewer.`);
  return output;
}

function validHttpUrl(value) {
  const raw = String(value ?? '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Enter a valid staff link URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Staff links must use HTTP or HTTPS.');
  if (raw.length > 2048) throw new Error('Staff link URLs must be 2,048 characters or fewer.');
  return parsed.toString();
}

function optionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  return requiredId(value);
}

function requiredId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid PIA record identifier.');
  return id;
}

function readableError(error) {
  return String(error?.message || 'PIA operation failed.').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
}

module.exports = { registerPiaIpc };
