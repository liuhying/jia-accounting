/**
 * Database pool with account_set_id auto-injection via AsyncLocalStorage.
 * Replace: const db = require('../config/database')
 * With:    const db = require('../config/database_as')
 */
const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config({ path: '/var/www/jia_app/.env' });

const realPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'jia_app',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

const als = new AsyncLocalStorage();

// Tables that need account_set_id filtering (exact table names, no aliases)
const ACC_TABLE_NAMES = [
  'acc_subjects', 'acc_vouchers', 'acc_voucher_entries',
  'acc_voucher_templates', 'acc_voucher_template_entries',
  'acc_transactions', 'acc_accounts', 'acc_currencies',
  'acc_auxiliary_types', 'acc_auxiliary_items',
  'acc_bank_statements', 'acc_bank_statement_items',
  'acc_bank_reconciliations', 'acc_reconciliations',
  'acc_reconciliation_items', 'acc_cash_flow_items',
  'acc_cash_flow_mappings', 'acc_fixed_assets',
  'acc_depreciation_records', 'acc_inventory_items',
  'acc_inventory_transactions', 'acc_period_closes',
  'acc_entry_auxiliary', 'acc_tax_reports', 'acc_tax_settings',
  'acc_approval_records', 'acc_audit_logs', 'acc_categories'
];

const SKIP_TABLES = ['app_config', 'admins', 'acc_account_sets', 'users',
  'shops', 'orders', 'order_items', 'products', 'categories', 'cities',
  'withdraws', 'announcements', 'user_feedback'];

function findAccTable(sql) {
  // Two pass: first look for tables after FROM, then after JOIN
  let best = null;
  for (const table of ACC_TABLE_NAMES) {
    const re = new RegExp('\\b' + table + '\\b', 'gi');
    let match;
    while ((match = re.exec(sql)) !== null) {
      const idx = match.index;
      // Check if preceded by LEFT/RIGHT JOIN (might be NULL, lower priority)
      const before = sql.slice(Math.max(0, idx - 30), idx);
      const isLeftJoin = /\b(?:LEFT|RIGHT)\s+JOIN\s*$/i.test(before);
      const after = sql.slice(idx + table.length);
      const aliasM = after.match(/^\s+(\w+)/);
      const alias = (aliasM && !/^(ON|WHERE|AND|SET|LEFT|RIGHT|INNER|JOIN|ORDER|GROUP|LIMIT|HAVING|UNION|ASC|DESC|BY)$/i.test(aliasM[1]))
        ? aliasM[1] : table;
      if (!isLeftJoin) {
        return { table, alias }; // FROM / INNER JOIN = highest priority
      }
      if (!best) best = { table, alias }; // LEFT JOIN = fallback
    }
  }
  return best;
}

function shouldSkip(sql) {
  if (!findAccTable(sql)) return true;
  if (/^\s*INSERT\b/i.test(sql)) return true;
  if (/INSERT\s+INTO\s+acc_account_sets/i.test(sql)) return true;
  if (/account_set_id\s*=/.test(sql)) return true;
  return false;
}

function injectAsFilter(sql) {
  const t = findAccTable(sql);
  if (!t) return sql;
  if (/^\s*INSERT\b/i.test(sql)) return sql;
  if (/INSERT\s+INTO\s+acc_account_sets/i.test(sql)) return sql;
  if (/account_set_id\s*=/.test(sql)) return sql;

  const filter = t.alias + '.account_set_id = ?';

  // APPEND filter at END of WHERE (correct param order for SELECT/UPDATE/DELETE)
  const whereMatch = sql.match(/\bWHERE\b/i);
  if (whereMatch) {
    const afterWhere = sql.slice(whereMatch.index + 5);
    const endRe = /\b(ORDER\s+BY|GROUP\s+BY|LIMIT|HAVING|FOR\s+UPDATE)\b/i;
    const endMatch = afterWhere.match(endRe);
    if (endMatch) {
      const injectPos = whereMatch.index + 5 + endMatch.index;
      return sql.slice(0, injectPos) + ' AND ' + filter + ' ' + sql.slice(injectPos);
    }
    const semi = sql.lastIndexOf(";");
    if (semi >= 0) {
      return sql.slice(0, semi) + ' AND ' + filter + sql.slice(semi);
    }
    return sql + ' AND ' + filter;
  }

  // No WHERE: insert WHERE before ORDER BY / GROUP BY / LIMIT / HAVING
  const boundaryRe = /\b(ORDER\s+BY|GROUP\s+BY|LIMIT|HAVING)\b/i;
  const boundary = sql.match(boundaryRe);
  if (boundary) {
    const pos = boundary.index;
    return sql.slice(0, pos) + ' WHERE ' + filter + ' ' + sql.slice(pos);
  }

  // No boundary keywords: append WHERE at the end of the statement
  const semicolon = sql.lastIndexOf(';');
  if (semicolon >= 0) {
    return sql.slice(0, semicolon) + ' WHERE ' + filter + sql.slice(semicolon);
  }
  return sql + ' WHERE ' + filter;
}

// Proxy wrapper
const wrapper = {
  async query(sql, params) {
    const store = als.getStore();
    const asId = (store && store.accountSetId) || 1;

    const modified = injectAsFilter(String(sql));

    let finalParams = params;
    if (modified !== sql) {
      if (params && Array.isArray(params) && params.length > 0) {
        finalParams = [...params, asId];
      } else {
        finalParams = [asId];
      }
    }

    return realPool.query(modified, finalParams);
  },

  execute(sql, params) {
    const store = als.getStore();
    const asId = (store && store.accountSetId) || 1;
    const modified = injectAsFilter(String(sql));
    let finalParams = params;
    if (modified !== sql) {
      if (params && Array.isArray(params) && params.length > 0) {
        finalParams = [...params, asId];
      } else {
        finalParams = [asId];
      }
    }
    return realPool.execute(modified, finalParams);
  },

  getConnection() { return realPool.getConnection(); }
};

module.exports = wrapper;
module.exports.als = als;
module.exports.REAL_POOL = realPool;
