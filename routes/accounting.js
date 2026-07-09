const express = require('express');
const router = express.Router();
const db = require('../config/database_as');
const auth = require('../middleware/auth');
const { requireRole } = require("../middleware/roles");
const { success, error, page } = require('../utils/response');

router.use(auth);

// ==================== 会计科目 ====================

router.get('/subjects', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, code, name, type, parent_id, direction FROM acc_subjects WHERE is_active=1 ORDER BY code');
    success(res, rows);
  } catch (err) { error(res, '查询科目失败: ' + err.message); }
});

router.get('/subjects/tree', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, code, name, type, parent_id, direction FROM acc_subjects WHERE is_active=1 ORDER BY code');
    const map = {}, roots = [];
    rows.forEach(s => { map[s.id] = { ...s, children: [] }; });
    rows.forEach(s => {
      if (s.parent_id && map[s.parent_id]) map[s.parent_id].children.push(map[s.id]);
      else roots.push(map[s.id]);
    });
    success(res, roots);
  } catch (err) { error(res, '查询科目树失败: ' + err.message); }
});

// ==================== 凭证号生成 ====================

async function genVoucherNo(vtype, date) {
  const d = new Date(date);
  const prefix = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  const [rows] = await db.query(
    `SELECT voucher_no FROM acc_vouchers WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`,
    [`${vtype}-${prefix}-%`]
  );
  let seq = 1;
  if (rows.length) {
    const last = rows[0].voucher_no.split('-');
    seq = parseInt(last[last.length-1]) + 1;
  }
  return `${vtype}-${prefix}-${String(seq).padStart(3,'0')}`;
}

// ==================== 凭证 CRUD ====================

router.get('/vouchers', async (req, res) => {
  try {
    const { page: p = 1, pageSize = 20, type, status, date_from, date_to } = req.query;
    const offset = (Number(p)-1) * Number(pageSize);
    let where = ['1=1'], params = [];
    if (type) { where.push('v.voucher_type = ?'); params.push(type); }
    if (status) { where.push('v.status = ?'); params.push(status); }
    if (date_from) { where.push('v.voucher_date >= ?'); params.push(date_from); }
    if (date_to) { where.push('v.voucher_date <= ?'); params.push(date_to); }
    const wh = where.join(' AND ');
    const [[{total}]] = await db.query(`SELECT COUNT(*) AS total FROM acc_vouchers v WHERE ${wh}`, params);
    const [rows] = await db.query(
      `SELECT v.*, c.code as currency_code, c.name as currency_name, c.symbol as currency_symbol, rv.voucher_no AS reversal_voucher_no
       FROM acc_vouchers v
       LEFT JOIN acc_currencies c ON v.currency_id = c.id
       LEFT JOIN acc_vouchers rv ON v.reversal_of = rv.id
       WHERE ${wh} ORDER BY v.voucher_date DESC, v.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), offset]
    );
    page(res, rows, total, Number(p), Number(pageSize));
  } catch (err) { error(res, '查询凭证失败: ' + err.message); }
});

router.get('/vouchers/:id', async (req, res) => {
  try {
    const [[v]] = await db.query(
      `SELECT v.*, c.code as currency_code, c.name as currency_name, c.symbol as currency_symbol, rv.voucher_no AS reversal_voucher_no
       FROM acc_vouchers v LEFT JOIN acc_currencies c ON v.currency_id = c.id LEFT JOIN acc_vouchers rv ON v.reversal_of = rv.id
       WHERE v.id = ?`, [req.params.id]);
    if (!v) return error(res, '凭证不存在', 404);
    const [entries] = await db.query(
      `SELECT ve.*, s.code AS subject_code, s.name AS subject_name
       FROM acc_voucher_entries ve LEFT JOIN acc_subjects s ON ve.subject_id = s.id
       WHERE ve.voucher_id = ? ORDER BY ve.line_no`, [req.params.id]
    );
    // 红字凭证: 金额取绝对值(前端展示用), 加 is_negative 标记
    const isReversal = !!v.reversal_of;
    const enriched = await Promise.all(entries.map(async e => {
      // 查询该分录的辅助核算关联
      let auxRows = [];
      try {
        const [ar] = await db.query(
          `SELECT ea.aux_type_id, ea.aux_item_id, at.name AS aux_type_name, ai.name AS aux_item_name, ai.code AS aux_item_code
           FROM acc_entry_auxiliary ea
           LEFT JOIN acc_auxiliary_types at ON ea.aux_type_id = at.id
           LEFT JOIN acc_auxiliary_items ai ON ea.aux_item_id = ai.id
           WHERE ea.entry_id = ?`, [e.id]
        );
        auxRows = ar;
      } catch(_) {}
      return {
        ...e,
        is_negative: isReversal,
        debit_amount: Math.abs(Number(e.debit_amount)),
        credit_amount: Math.abs(Number(e.credit_amount)),
        auxiliary: auxRows.map(a=>({type_id:a.aux_type_id,type_name:a.aux_type_name,item_id:a.aux_item_id,item_name:a.aux_item_name,item_code:a.aux_item_code}))
      };
    }));
    success(res, { ...v, entries: enriched, total_debit: Math.abs(Number(v.total_debit)), total_credit: Math.abs(Number(v.total_credit)) });
  } catch (err) { error(res, '查询凭证详情失败: ' + err.message); }
});

router.post('/vouchers', requireRole('super_admin','admin','accountant'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { voucher_type = '记', voucher_date, description, attachments = 0, entries, is_reversal = false } = req.body;
    if (!voucher_date) return error(res, '日期必填', 400);
    if (!entries || !entries.length || entries.length < 2) return error(res, '凭证至少需要两条分录', 400);

    let totalDebit = 0, totalCredit = 0;
    entries.forEach((e, i) => {
      const d = Number(e.debit_amount) || 0, c = Number(e.credit_amount) || 0;
      if (!e.subject_id) throw new Error(`第${i+1}行缺少科目`);
      if (d <= 0 && c <= 0) throw new Error(`第${i+1}行借/贷金额至少填一项`);
      if (d > 0 && c > 0) throw new Error(`第${i+1}行不能同时有借和贷`);
      totalDebit += d;
      totalCredit += c;
    });
    if (Math.abs(totalDebit - totalCredit) > 0.01) return error(res, '借贷不平衡: 借方' + totalDebit + ' ≠ 贷方' + totalCredit, 400);

    const voucherNo = await genVoucherNo(voucher_type, voucher_date);
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO acc_vouchers (voucher_no, voucher_type, currency_id, voucher_date, description, total_debit, total_credit, attachments, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [voucherNo, voucher_type, req.body.currency_id || 1, voucher_date, description || '', totalDebit, totalCredit, attachments, req.user?.username || 'admin']
    );
    const vId = result.insertId;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const [entryResult] = await conn.query(
        `INSERT INTO acc_voucher_entries (voucher_id, line_no, subject_id, summary, debit_amount, credit_amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [vId, i + 1, e.subject_id, e.summary || '', Number(e.debit_amount)||0, Number(e.credit_amount)||0]
      );
      const entryId = entryResult.insertId;
      // 绑定辅助核算
      if (e.auxiliary && Array.isArray(e.auxiliary)) {
        for (const a of e.auxiliary) {
          if (a.type_id && a.item_id) {
            await conn.query(
              `INSERT INTO acc_entry_auxiliary (entry_id, aux_type_id, aux_item_id) VALUES (?,?,?)`,
              [entryId, a.type_id, a.item_id]
            );
          }
        }
      }
    }
    await conn.commit();
    success(res, { id: vId, voucher_no: voucherNo }, '凭证创建成功');
  } catch (err) {
    await conn.rollback();
    error(res, '创建凭证失败: ' + err.message);
  } finally { conn.release(); }
});

// 审核凭证
router.post('/vouchers/:id/audit', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const [[v]] = await db.query('SELECT * FROM acc_vouchers WHERE id = ?', [req.params.id]);
    if (!v) return error(res, '凭证不存在', 404);
    if (v.status !== 'draft') return error(res, '只有草稿状态可审核', 400);
    await db.query(
      `UPDATE acc_vouchers SET status='audited', auditor=? WHERE id=?`,
      [req.user?.username || 'admin', req.params.id]
    );
    success(res, null, '审核通过');
  } catch (err) { error(res, '审核失败: ' + err.message); }
});

// 过账
router.post('/vouchers/:id/post', requireRole('super_admin','admin','accountant'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const [[v]] = await conn.query('SELECT * FROM acc_vouchers WHERE id = ?', [req.params.id]);
    if (!v) return error(res, '凭证不存在', 404);
    if (v.status !== 'audited') return error(res, '必须审核通过后才能过账', 400);

    const [entries] = await conn.query(
      `SELECT ve.*, s.type AS subject_type FROM acc_voucher_entries ve
       LEFT JOIN acc_subjects s ON ve.subject_id = s.id WHERE ve.voucher_id = ?`,
      [req.params.id]
    );

    await conn.beginTransaction();
    for (const e of entries) {
      const amount = e.debit_amount > 0 ? e.debit_amount : e.credit_amount;
      const transType = e.debit_amount > 0 ? 'expense' : 'income';
      await conn.query(
        `INSERT INTO acc_transactions (type, amount, subject_id, category_id, voucher_id, date, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [transType, Math.abs(Number(amount)), e.subject_id, e.subject_id, v.id, v.voucher_date, e.summary || v.description]
      );
    }
    await conn.query(`UPDATE acc_vouchers SET status='posted' WHERE id=?`, [req.params.id]);

    // 红字冲销凭证过账后, 标记被冲销凭证
    if (v.reversal_of) {
      await conn.query(`UPDATE acc_vouchers SET is_reversed=1 WHERE id=?`, [v.reversal_of]);
    }
    await conn.commit();
    success(res, null, '过账成功');
  } catch (err) {
    await conn.rollback();
    error(res, '过账失败: ' + err.message);
  } finally { conn.release(); }
});

// 反过账
router.post('/vouchers/:id/unpost', requireRole('super_admin','admin'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const [[v]] = await conn.query('SELECT * FROM acc_vouchers WHERE id = ?', [req.params.id]);
    if (!v) return error(res, '凭证不存在', 404);
    if (v.status !== 'posted') return error(res, '只有已过账凭证可反过账', 400);
    await conn.beginTransaction();
    await conn.query('DELETE FROM acc_transactions WHERE voucher_id = ?', [req.params.id]);
    await conn.query(`UPDATE acc_vouchers SET status='audited' WHERE id=?`, [req.params.id]);
    // 如果这是冲销凭证, 恢复被冲销凭证的标记
    if (v.reversal_of) {
      await conn.query(`UPDATE acc_vouchers SET is_reversed=0 WHERE id=?`, [v.reversal_of]);
    }
    await conn.commit();
    success(res, null, '反过账成功，相应交易已冲销');
  } catch (err) {
    await conn.rollback();
    error(res, '反过账失败: ' + err.message);
  } finally { conn.release(); }
});

// ===== 红字冲销 =====
router.post('/vouchers/:id/reverse', requireRole('super_admin','admin','accountant'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const [[orig]] = await conn.query('SELECT * FROM acc_vouchers WHERE id = ?', [req.params.id]);
    if (!orig) return error(res, '原凭证不存在', 404);
    if (orig.status !== 'posted') return error(res, '只能冲销已过账凭证', 400);
    if (orig.is_reversed) return error(res, '该凭证已被冲销，不可重复冲销', 400);

    const [entries] = await conn.query(
      'SELECT * FROM acc_voucher_entries WHERE voucher_id = ? ORDER BY line_no',
      [req.params.id]
    );

    // 红字冲销: 借贷互换、金额不变
    const revEntries = entries.map((e, i) => ({
      line_no: i + 1,
      subject_id: e.subject_id,
      summary: e.summary || '',
      // 原借方 → 红字贷方; 原贷方 → 红字借方
      debit_amount: Number(e.credit_amount) || 0,
      credit_amount: Number(e.debit_amount) || 0
    }));

    const voucherNo = await genVoucherNo(orig.voucher_type, orig.voucher_date);
    await conn.beginTransaction();

    const desc = `红字冲销 [${orig.voucher_no}] ${orig.description || ''}`;
    const [result] = await conn.query(
      `INSERT INTO acc_vouchers (voucher_no, voucher_type, voucher_date, description, total_debit, total_credit, attachments, reversal_of, reversal_notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [voucherNo, orig.voucher_type, orig.voucher_date, desc, orig.total_credit, orig.total_debit, 0, orig.id, `冲销 ${orig.voucher_no}`, req.user?.username || 'admin']
    );
    const reversalId = result.insertId;

    for (const e of revEntries) {
      await conn.query(
        `INSERT INTO acc_voucher_entries (voucher_id, line_no, subject_id, summary, debit_amount, credit_amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [reversalId, e.line_no, e.subject_id, e.summary, e.debit_amount, e.credit_amount]
      );
    }

    // 自动审核
    await conn.query(
      `UPDATE acc_vouchers SET status='audited', auditor=? WHERE id=?`,
      [req.user?.username || 'admin', reversalId]
    );

    // 自动过账 — 红字冲销：同科目、同方向、负金额
    for (const e of revEntries) {
      const amount = e.debit_amount > 0 ? e.debit_amount : e.credit_amount;
      // e 是借贷互换后的分录：e.credit_amount 是原始借方 → 原始为 expense
      // 红字在同方向用负金额，而不是移到对侧
      const transType = Number(e.credit_amount) > 0 ? 'expense' : 'income';
      await conn.query(
        `INSERT INTO acc_transactions (type, amount, subject_id, category_id, voucher_id, date, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [transType, -Math.abs(Number(amount)), e.subject_id, e.subject_id, reversalId, orig.voucher_date, e.summary || desc]
      );
    }
    await conn.query(`UPDATE acc_vouchers SET status='posted' WHERE id=?`, [reversalId]);
    await conn.query(`UPDATE acc_vouchers SET is_reversed=1 WHERE id=?`, [orig.id]);

    await conn.commit();
    success(res, { id: reversalId, voucher_no: voucherNo, description: desc }, '红字冲销凭证已自动创建、审核、过账');
  } catch (err) {
    await conn.rollback();
    error(res, '红字冲销失败: ' + err.message);
  } finally { conn.release(); }
});

// 删除凭证（仅草稿）
router.delete('/vouchers/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[v]] = await db.query('SELECT * FROM acc_vouchers WHERE id = ?', [req.params.id]);
    if (!v) return error(res, '凭证不存在', 404);
    if (v.status !== 'draft') return error(res, '仅草稿状态可删除', 400);
    await db.query('DELETE FROM acc_voucher_entries WHERE voucher_id = ?', [req.params.id]);
    await db.query('DELETE FROM acc_vouchers WHERE id = ?', [req.params.id]);
    success(res, null, '删除成功');
  } catch (err) { error(res, '删除失败: ' + err.message); }
});

// ==================== 账簿（含合计/累计） ====================

// 总账: 按科目汇总 + 合计行 + YTD 累计
router.get('/ledger/general', async (req, res) => {
  try {
    const { year, month } = req.query;

    // 默认当前月份；仅传年份时查全年；都传时用指定年月
    // 避免无参数/仅年份时期初查询拉取全量数据导致余额翻倍
    const now = new Date();
    const effYear = year ? Number(year) : now.getFullYear();
    const effMonth = month ? Number(month) : null;

    let dateFilter, params;
    if (effMonth) {
      const m = String(effMonth).padStart(2, '0');
      const firstDay = effYear + '-' + m + '-01';
      const lastDay = new Date(effYear, effMonth, 0).getDate();
      dateFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      params = [firstDay, effYear + '-' + m + '-' + String(lastDay).padStart(2, '0')];
    } else {
      dateFilter = ' AND YEAR(v.voucher_date) = ?';
      params = [effYear];
    }

    const joinWhere = (filter) => " FROM acc_subjects s" +
       " LEFT JOIN (" +
       "   SELECT e.subject_id, e.debit_amount, e.credit_amount" +
       "   FROM acc_voucher_entries e" +
       '   JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = "posted"' + filter +
       " ) pe ON s.id = pe.subject_id";

    // 1. Period amounts
    const [periodRows] = await db.query(
      "SELECT s.id, s.code, s.name, s.type, s.direction," +
      "  COALESCE(SUM(pe.debit_amount), 0) AS period_debit," +
      "  COALESCE(SUM(pe.credit_amount), 0) AS period_credit" +
      joinWhere(dateFilter) +
      " WHERE s.is_active = 1" +
      " GROUP BY s.id, s.code, s.name, s.type, s.direction" +
      " ORDER BY s.code",
      params
    );

    // 2. YTD: Jan 1 to end of period (for closing balance)
    // 3. Opening balance: entries strictly BEFORE the period start
    let ytdEnd, ytdParams, openingFilter, openingParams;
    if (effMonth) {
      const firstDay = effYear + '-' + String(effMonth).padStart(2, '0') + '-01';
      const lastDay = new Date(effYear, effMonth, 0).getDate();
      const lastDayStr = effYear + '-' + String(effMonth).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
      ytdEnd = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      ytdParams = [effYear + '-01-01', lastDayStr];
      openingFilter = ' AND v.voucher_date < ?';
      openingParams = [firstDay];
    } else {
      ytdEnd = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      ytdParams = [effYear + '-01-01', effYear + '-12-31'];
      openingFilter = ' AND v.voucher_date < ?';
      openingParams = [effYear + '-01-01'];
    }

    const [ytdRows] = await db.query(
      "SELECT s.id," +
      "  COALESCE(SUM(pe.debit_amount), 0) AS ytd_debit," +
      "  COALESCE(SUM(pe.credit_amount), 0) AS ytd_credit" +
      joinWhere(ytdEnd) +
      " WHERE s.is_active = 1" +
      " GROUP BY s.id",
      ytdParams
    );

    const [openingRows] = await db.query(
      "SELECT s.id," +
      "  COALESCE(SUM(pe.debit_amount), 0) AS open_debit," +
      "  COALESCE(SUM(pe.credit_amount), 0) AS open_credit" +
      joinWhere(openingFilter) +
      " WHERE s.is_active = 1" +
      " GROUP BY s.id",
      openingParams
    );

    const ytdMap = {}; ytdRows.forEach(r => { ytdMap[r.id] = r; });
    const openMap = {}; openingRows.forEach(r => { openMap[r.id] = r; });

    const list = periodRows.map(s => {
      const ytd = ytdMap[s.id] || { ytd_debit: 0, ytd_credit: 0 };
      const open = openMap[s.id] || { open_debit: 0, open_credit: 0 };
      const openDebit = Number(open.open_debit);
      const openCredit = Number(open.open_credit);

      const opening = s.direction === 'debit'
        ? openDebit - openCredit
        : openCredit - openDebit;

      const closing = s.direction === 'debit'
        ? opening + (Number(ytd.ytd_debit) - Number(ytd.ytd_credit))
        : opening + (Number(ytd.ytd_credit) - Number(ytd.ytd_debit));

      return {
        id: s.id, code: s.code, name: s.name, type: s.type, direction: s.direction,
        opening_balance: opening.toFixed(2),
        period_debit: Number(s.period_debit).toFixed(2),
        period_credit: Number(s.period_credit).toFixed(2),
        ytd_debit: Number(ytd.ytd_debit).toFixed(2),
        ytd_credit: Number(ytd.ytd_credit).toFixed(2),
        balance: closing.toFixed(2),
      };
    });

    const sumDebit = list.reduce((a, r) => a + Number(r.period_debit), 0);
    const sumCredit = list.reduce((a, r) => a + Number(r.period_credit), 0);
    const sumYtdDebit = list.reduce((a, r) => a + Number(r.ytd_debit), 0);
    const sumYtdCredit = list.reduce((a, r) => a + Number(r.ytd_credit), 0);

    success(res, {
      list,
      totals: {
        period_debit: sumDebit.toFixed(2),
        period_credit: sumCredit.toFixed(2),
        ytd_debit: sumYtdDebit.toFixed(2),
        ytd_credit: sumYtdCredit.toFixed(2),
      }
    });
  } catch (err) { error(res, '\u67e5\u8be2\u603b\u8d26\u5931\u8d25: ' + err.message); }
});
router.get('/ledger/detail/:subject_id', async (req, res) => {
  try {
    const { date_from, date_to, page: p = 1, pageSize = 50 } = req.query;
    const offset = (Number(p) - 1) * Number(pageSize);

    const [[s]] = await db.query('SELECT * FROM acc_subjects WHERE id = ?', [req.params.subject_id]);
    if (!s) return error(res, '科目不存在', 404);

    let entryWhere = 'e.subject_id = ?';
    let entryParams = [req.params.subject_id];
    if (date_from) { entryWhere += ' AND v.voucher_date >= ?'; entryParams.push(date_from); }
    if (date_to)   { entryWhere += ' AND v.voucher_date <= ?'; entryParams.push(date_to); }

    const vj = `JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'`;

    // opening balance
    let openingBalance = 0;
    if (date_from) {
      const [[ob]] = await db.query(
        `SELECT COALESCE(SUM(pe.debit_amount),0) AS d, COALESCE(SUM(pe.credit_amount),0) AS c
         FROM (SELECT e.debit_amount, e.credit_amount
               FROM acc_voucher_entries e ${vj}
               WHERE e.subject_id = ? AND v.voucher_date < ?) pe`,
        [req.params.subject_id, date_from]);
      openingBalance = s.direction === 'debit'
        ? Number(ob.d) - Number(ob.c)
        : Number(ob.c) - Number(ob.d);
    }

    // period totals
    const [[pt]] = await db.query(
      `SELECT COALESCE(SUM(pe.debit_amount),0) AS period_debit, COALESCE(SUM(pe.credit_amount),0) AS period_credit
       FROM (SELECT e.debit_amount, e.credit_amount FROM acc_voucher_entries e ${vj}
             WHERE ${entryWhere}) pe`, entryParams);

    // YTD totals
    const ytdEnd = date_to || new Date().toISOString().slice(0,10);
    const [[ytd]] = await db.query(
      `SELECT COALESCE(SUM(pe.debit_amount),0) AS ytd_debit, COALESCE(SUM(pe.credit_amount),0) AS ytd_credit
       FROM (SELECT e.debit_amount, e.credit_amount FROM acc_voucher_entries e ${vj}
             WHERE e.subject_id = ? AND v.voucher_date <= ?) pe`,
      [req.params.subject_id, ytdEnd]);
    const ytdBal = s.direction === 'debit'
      ? Number(ytd.ytd_debit) - Number(ytd.ytd_credit)
      : Number(ytd.ytd_credit) - Number(ytd.ytd_debit);

    // preBalance for pagination
    let preBalance = openingBalance;
    if (offset > 0) {
      const [[pre]] = await db.query(
        `SELECT COALESCE(SUM(pe.debit_amount),0) AS d, COALESCE(SUM(pe.credit_amount),0) AS c
         FROM (SELECT e.debit_amount, e.credit_amount FROM acc_voucher_entries e ${vj}
               WHERE ${entryWhere} ORDER BY v.voucher_date ASC, e.id ASC LIMIT ?) pe`,
        [...entryParams, offset]);
      preBalance = openingBalance + (s.direction === 'debit'
        ? Number(pre.d) - Number(pre.c)
        : Number(pre.c) - Number(pre.d));
    }

    // count
    const [[{total}]] = await db.query(
      `SELECT COUNT(*) AS total FROM acc_voucher_entries e ${vj}
       WHERE ${entryWhere}`, entryParams);

    // entries
    const [rows] = await db.query(
      `SELECT e.id, e.debit_amount, e.credit_amount, e.summary,
              v.voucher_date, v.voucher_no,
              COALESCE(v.description, e.summary) AS description
       FROM acc_voucher_entries e ${vj}
       WHERE ${entryWhere}
       ORDER BY v.voucher_date ASC, e.id ASC
       LIMIT ? OFFSET ?`,
      [...entryParams, Number(pageSize), offset]);

    // running balance
    let running = preBalance;
    for (const r of rows) {
      running += s.direction === 'debit'
        ? Number(r.debit_amount||0) - Number(r.credit_amount||0)
        : Number(r.credit_amount||0) - Number(r.debit_amount||0);
      r.running_balance = running;
    }

    success(res, {
      subject: s,
      openingBalance,
      preBalance,
      periodTotals: { debit: Number(pt.period_debit), credit: Number(pt.period_credit) },
      ytdTotals: { debit: Number(ytd.ytd_debit), credit: Number(ytd.ytd_credit), balance: ytdBal },
      balance: running,
      total,
      list: rows
    });
  } catch (err) { error(res, '查询明细账失败: ' + err.message); }
});

// 现金日记账 / 银行存款日记账

router.get('/ledger/journal/:type', async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    const subjectCode = req.params.type === 'cash' ? '1001' : '1002';
    let where = ['s.code LIKE ?'], params = [`${subjectCode}%`];
    if (date_from) { where.push('v.voucher_date >= ?'); params.push(date_from); }
    if (date_to)   { where.push('v.voucher_date <= ?'); params.push(date_to); }

    const [rows] = await db.query(
      `SELECT v.voucher_date, e.debit_amount, e.credit_amount, e.summary,
              s.code AS subject_code, s.name AS subject_name, v.voucher_no
       FROM acc_voucher_entries e
       JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
       JOIN acc_subjects s ON e.subject_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY v.voucher_date ASC, e.id ASC`,
      params);

    // opening balance
    let balance = 0;
    if (date_from) {
      const [[ob]] = await db.query(
        `SELECT COALESCE(SUM(pe.debit_amount),0) - COALESCE(SUM(pe.credit_amount),0) AS ob
         FROM (SELECT e.debit_amount, e.credit_amount
               FROM acc_voucher_entries e
               JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
               JOIN acc_subjects s ON e.subject_id = s.id
               WHERE s.code LIKE ? AND v.voucher_date < ?) pe`,
        [`${subjectCode}%`, date_from]);
      balance = Number(ob.ob);
    }

    // running balance + daily totals
    let runningBalance = balance;
    let dayDebit = 0, dayCredit = 0, lastDate = '';
    const list = [];
    const dailyTotals = [];

    for (const r of rows) {
      if (lastDate && r.voucher_date !== lastDate) {
        dailyTotals.push({ date: lastDate, debit: dayDebit, credit: dayCredit, balance: runningBalance });
        dayDebit = 0; dayCredit = 0;
      }
      const dr = Number(r.debit_amount) || 0;
      const cr = Number(r.credit_amount) || 0;
      dayDebit += dr;
      dayCredit += cr;
      runningBalance += dr - cr;
      lastDate = r.voucher_date;
      list.push({ ...r, running_balance: runningBalance });
    }
    if (lastDate) {
      dailyTotals.push({ date: lastDate, debit: dayDebit, credit: dayCredit, balance: runningBalance });
    }

    const periodDebit = dailyTotals.reduce((a, d) => a + d.debit, 0);
    const periodCredit = dailyTotals.reduce((a, d) => a + d.credit, 0);

    success(res, {
      type: req.params.type,
      openingBalance: balance,
      periodTotals: { debit: periodDebit, credit: periodCredit, balance: runningBalance },
      dailyTotals,
      count: list.length,
      list
    });
  } catch (err) { error(res, '查询日记账失败: ' + err.message); }
});

// ==================== 财务报表 ====================

// 试算平衡表
router.get('/statements/trial-balance', async (req, res) => {
  try {
    const { year, month } = req.query;
    let dateFilter = '', params = [];
    if (year && month) {
      const m = String(Number(month)).padStart(2, '0');
      const firstDay = year + '-' + m + '-01';
      const lastDay = new Date(Number(year), Number(month), 0).getDate();
      const lastDayStr = year + '-' + m + '-' + String(lastDay).padStart(2, '0');
      dateFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      params = [firstDay, lastDayStr];
    } else if (year) {
      dateFilter = ' AND YEAR(v.voucher_date) = ?';
      params = [Number(year)];
    }

    const [rows] = await db.query(
      `SELECT s.code, s.name, s.type, s.direction,
              COALESCE(SUM(pe.debit_amount), 0) AS total_debit,
              COALESCE(SUM(pe.credit_amount), 0) AS total_credit
       FROM acc_subjects s
       LEFT JOIN (
         SELECT e.subject_id, e.debit_amount, e.credit_amount
         FROM acc_voucher_entries e
         JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'${dateFilter}
       ) pe ON s.id = pe.subject_id
       WHERE s.is_active = 1
       GROUP BY s.id, s.code, s.name, s.type, s.direction
       HAVING total_debit > 0 OR total_credit > 0
       ORDER BY s.code`,
      params
    );

    const sumDebit = rows.reduce((a, r) => a + Number(r.total_debit), 0);
    const sumCredit = rows.reduce((a, r) => a + Number(r.total_credit), 0);
    const diff = Math.abs(sumDebit - sumCredit);

    success(res, {
      balanced: diff < 0.01,
      diff: diff.toFixed(2),
      totalDebit: sumDebit.toFixed(2),
      totalCredit: sumCredit.toFixed(2),
      items: rows.map(r => ({
        code: r.code,
        name: r.name,
        type: r.type,
        direction: r.direction,
        total_debit: Number(r.total_debit).toFixed(2),
        total_credit: Number(r.total_credit).toFixed(2),
      })),
    });
  } catch (err) { error(res, '试算平衡查询失败: ' + err.message); }
});

// 资产负债表
// 资产负债表: 资产 = 负债 + 所有者权益(含本期未分配利润)
router.get('/statements/balance-sheet', async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = Number(year) || new Date().getFullYear();
    const m = Number(month);
    let dateFilter = '', params = [];
    const yearStart = y + '-01-01';
    if (m) {
      const ms = String(m).padStart(2, '0');
      const lastDay = new Date(y, m, 0).getDate();
      const ld = String(lastDay).padStart(2, '0');
      dateFilter = ' AND v.voucher_date <= ?';
      params = [y + '-' + ms + '-' + ld];
    } else {
      dateFilter = ' AND v.voucher_date <= ?';
      params = [y + '-12-31'];
    }

    const entriesJoin = ` FROM acc_subjects s
      LEFT JOIN (
        SELECT e.subject_id, e.debit_amount, e.credit_amount
        FROM acc_voucher_entries e
        JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'`;

    // Period-end balances (closing)
    const [rows] = await db.query(
      `SELECT s.id, s.code, s.name, s.type, s.direction,
              COALESCE(SUM(pe.debit_amount), 0) AS total_debit,
              COALESCE(SUM(pe.credit_amount), 0) AS total_credit
       ${entriesJoin}${dateFilter}) pe ON s.id = pe.subject_id
       WHERE s.type IN ('asset', 'liability', 'equity') AND s.is_active = 1
       GROUP BY s.id, s.code, s.name, s.type, s.direction
       ORDER BY s.code`,
      params
    );

    // Opening balances (before year start)
    const prevYearEnd = (y - 1) + '-12-31';
    const [openRows] = await db.query(
      `SELECT s.id,
              COALESCE(SUM(oe.debit_amount), 0) AS open_debit,
              COALESCE(SUM(oe.credit_amount), 0) AS open_credit
       ${entriesJoin} AND v.voucher_date <= ?) oe ON s.id = oe.subject_id
       WHERE s.type IN ('asset', 'liability', 'equity') AND s.is_active = 1
       GROUP BY s.id`,
      [prevYearEnd]
    );
    const openMap = {};
    openRows.forEach(r => { openMap[r.id] = r; });

    // Profit/Loss for net profit inclusion in equity
    const [incomeRows] = await db.query(
      `SELECT s.type,
              COALESCE(SUM(pe.debit_amount), 0) AS total_debit,
              COALESCE(SUM(pe.credit_amount), 0) AS total_credit
       ${entriesJoin}${dateFilter}) pe ON s.id = pe.subject_id
       WHERE s.type IN ('revenue', 'cost', 'expense') AND s.is_active = 1
       GROUP BY s.type`,
      params
    );

    const incomeMap = {};
    incomeRows.forEach(r => { incomeMap[r.type] = r; });
    const totalRevenue = Number((incomeMap['revenue'] || {}).total_credit || 0) - Number((incomeMap['revenue'] || {}).total_debit || 0);
    const totalCost = Number((incomeMap['cost'] || {}).total_debit || 0) - Number((incomeMap['cost'] || {}).total_credit || 0);
    const totalExpense = Number((incomeMap['expense'] || {}).total_debit || 0) - Number((incomeMap['expense'] || {}).total_credit || 0);
    const netProfit = totalRevenue - totalCost - totalExpense;

    const calcBalance = (r, prefix) => {
      const dr = Number(r[prefix + 'debit']), cr = Number(r[prefix + 'credit']);
      return r.direction === 'debit' ? dr - cr : cr - dr;
    };

    // Classification helpers
    const isCurrentAsset = r => {
      const c = r.code;
      return ['1001','1002','1015','1122','1123','1221','1231','1403','1405'].some(p => c === p || c.startsWith(p));
    };
    const isNonCurrentAsset = r => {
      const c = r.code;
      return ['1601','1602','1701','1702','1811'].some(p => c === p || c.startsWith(p));
    };
    const isCurrentLiab = r => {
      const c = r.code;
      return ['2001','2202','2203','2211','2221','2241'].some(p => c === p || c.startsWith(p));
    };

    const enrich = r => {
      const openObj = openMap[r.id];
      const openDr = openObj ? Number(openObj.open_debit) : 0;
      const openCr = openObj ? Number(openObj.open_credit) : 0;
      const openBal = r.direction === 'debit' ? openDr - openCr : openCr - openDr;
      return {
        id: r.id, code: r.code, name: r.name, type: r.type, direction: r.direction,
        opening_balance: Number(openBal).toFixed(2),
        closing_balance: Number(calcBalance(r, 'total_')).toFixed(2),
        total_debit: Number(r.total_debit).toFixed(2),
        total_credit: Number(r.total_credit).toFixed(2),
      };
    };

    const allAssets = rows.filter(r => r.type === 'asset').map(enrich);
    const currentAssets = allAssets.filter(isCurrentAsset);
    const nonCurrentAssets = allAssets.filter(isNonCurrentAsset);
    const allLiabilities = rows.filter(r => r.type === 'liability').map(enrich);
    const currentLiabilities = allLiabilities.filter(isCurrentLiab);
    const nonCurrentLiabilities = allLiabilities.filter(r => !isCurrentLiab(r));
    const equityItems = rows.filter(r => r.type === 'equity').map(enrich);

    const sumClose = arr => arr.reduce((a, r) => a + Number(r.closing_balance), 0);
    const sumOpen = arr => arr.reduce((a, r) => a + Number(r.opening_balance), 0);

    const caClose = sumClose(currentAssets), caOpen = sumOpen(currentAssets);
    const ncaClose = sumClose(nonCurrentAssets), ncaOpen = sumOpen(nonCurrentAssets);
    const clClose = sumClose(currentLiabilities), clOpen = sumOpen(currentLiabilities);
    const nclClose = sumClose(nonCurrentLiabilities), nclOpen = sumOpen(nonCurrentLiabilities);
    const eqClose = sumClose(equityItems), eqOpen = sumOpen(equityItems);

    const totalAssets = caClose + ncaClose;
    const totalAssetsOpen = caOpen + ncaOpen;
    const totalLiabilities = clClose + nclClose;
    const totalLiabilitiesOpen = clOpen + nclOpen;
    const totalEquity = eqClose + netProfit;
    const totalEquityOpen = eqOpen;

    success(res, {
      reportDate: params[1] || params[0] || '',
      totalAssets: totalAssets.toFixed(2),
      totalAssetsOpen: totalAssetsOpen.toFixed(2),
      totalLiabilities: totalLiabilities.toFixed(2),
      totalLiabilitiesOpen: totalLiabilitiesOpen.toFixed(2),
      totalEquity: totalEquity.toFixed(2),
      totalEquityOpen: totalEquityOpen.toFixed(2),
      netProfit: netProfit.toFixed(2),
      balanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.01,
      currentAssets: { items: currentAssets, closing: caClose.toFixed(2), opening: caOpen.toFixed(2) },
      nonCurrentAssets: { items: nonCurrentAssets, closing: ncaClose.toFixed(2), opening: ncaOpen.toFixed(2) },
      currentLiabilities: { items: currentLiabilities, closing: clClose.toFixed(2), opening: clOpen.toFixed(2) },
      nonCurrentLiabilities: { items: nonCurrentLiabilities, closing: nclClose.toFixed(2), opening: nclOpen.toFixed(2) },
      equity: { items: equityItems, closing: eqClose.toFixed(2), opening: eqOpen.toFixed(2) },
      // Legacy flat arrays
      // (legacy assets/liabilities removed, use currentAssets etc. instead)
    });
  } catch (err) { error(res, '资产负债表查询失败: ' + err.message); }
});

router.get('/statements/income-statement', async (req, res) => {
  try {
    const { year, month } = req.query;
    let periodFilter = '', ytdFilter = '', periodParams = [], ytdParams = [];
    if (year && month) {
      const m = String(Number(month)).padStart(2, '0');
      const lastDay = new Date(Number(year), Number(month), 0).getDate();
      const ld = String(lastDay).padStart(2, '0');
      periodFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      periodParams = [year + '-' + m + '-01', year + '-' + m + '-' + ld];
      ytdFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      ytdParams = [year + '-01-01', year + '-' + m + '-' + ld];
    } else if (year) {
      periodFilter = ' AND YEAR(v.voucher_date) = ?';
      periodParams = [Number(year)];
      ytdFilter = ' AND YEAR(v.voucher_date) = ?';
      ytdParams = [Number(year)];
    }

    const entriesJoin = ` FROM acc_subjects s
      LEFT JOIN (
        SELECT e.subject_id, e.debit_amount, e.credit_amount
        FROM acc_voucher_entries e
        JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'`;

    const [periodRows] = await db.query(
      `SELECT s.id, s.code, s.name, s.type,
              COALESCE(SUM(pe.debit_amount), 0) AS debit_amount,
              COALESCE(SUM(pe.credit_amount), 0) AS credit_amount
       ${entriesJoin}${periodFilter}) pe ON s.id = pe.subject_id
       WHERE s.type IN ('revenue', 'cost', 'expense') AND s.is_active = 1
       GROUP BY s.id, s.code, s.name, s.type ORDER BY s.code`,
      periodParams
    );

    const [ytdRows] = ytdParams.length ? await db.query(
      `SELECT s.id,
              COALESCE(SUM(ye.debit_amount), 0) AS ytd_debit,
              COALESCE(SUM(ye.credit_amount), 0) AS ytd_credit
       ${entriesJoin}${ytdFilter}) ye ON s.id = ye.subject_id
       WHERE s.type IN ('revenue', 'cost', 'expense') AND s.is_active = 1
       GROUP BY s.id`,
      ytdParams
    ) : [[]];

    const ytdMap = {};
    ytdRows.forEach(r => { ytdMap[r.id] = r; });

    const enrich = list => list.map(r => {
      const ytd = ytdMap[r.id] || { ytd_debit: 0, ytd_credit: 0 };
      return {
        id: r.id, code: r.code, name: r.name, type: r.type,
        debit_amount: Number(r.debit_amount).toFixed(2),
        credit_amount: Number(r.credit_amount).toFixed(2),
        ytd_debit: Number(ytd.ytd_debit).toFixed(2),
        ytd_credit: Number(ytd.ytd_credit).toFixed(2),
      };
    });

    // ---- Tax-compliant classification ----
    // 营业收入 = 主营业务收入(6001) + 其他业务收入(6051)
    const isMainRevenue = r => r.type === 'revenue' && (r.code === '6001' || r.code.startsWith('6001') || r.code === '6051' || r.code.startsWith('6051'));
    const isNonOpRevenue = r => r.type === 'revenue' && (r.code === '6101' || r.code.startsWith('6101'));
    const isInvestment = r => r.type === 'revenue' && (r.code === '6111' || r.code.startsWith('6111'));
    const isCost = r => r.type === 'cost' && r.code !== '6403' && !r.code.startsWith('6403');
    const isTaxSurcharge = r => r.code === '6403' || r.code.startsWith('6403'); // 税金及附加
    const isAdminExp = r => r.code === '6601' || r.code.startsWith('6601');
    const isSellExp = r => r.code === '6602' || r.code.startsWith('6602');
    const isFinExp = r => r.code === '6603' || r.code.startsWith('6603');
    const isNonOpExp = r => r.code === '6711' || r.code.startsWith('6711');
    const isIncomeTax = r => r.code === '6802' || r.code.startsWith('6802');

    // Separate items
    const operatingRevenue = enrich(periodRows.filter(isMainRevenue));
    const nonOpRevenue = enrich(periodRows.filter(isNonOpRevenue));
    const investmentIncome = enrich(periodRows.filter(isInvestment));
    const operatingCost = enrich(periodRows.filter(isCost));
    const taxSurcharge = enrich(periodRows.filter(isTaxSurcharge));
    const adminExpenses = enrich(periodRows.filter(isAdminExp));
    const sellExpenses = enrich(periodRows.filter(isSellExp));
    const finExpenses = enrich(periodRows.filter(isFinExp));
    const nonOpExpenses = enrich(periodRows.filter(isNonOpExp));
    const incomeTax = enrich(periodRows.filter(isIncomeTax));

    // Compute totals (revenue: credit-debit, cost/expense: debit-credit)
    const revNet = arr => arr.reduce((a, r) => a + (Number(r.credit_amount) - Number(r.debit_amount)), 0);
    const expNet = arr => arr.reduce((a, r) => a + (Number(r.debit_amount) - Number(r.credit_amount)), 0);
    const ytdRevNet = arr => arr.reduce((a, r) => a + (Number(r.ytd_credit) - Number(r.ytd_debit)), 0);
    const ytdExpNet = arr => arr.reduce((a, r) => a + (Number(r.ytd_debit) - Number(r.ytd_credit)), 0);

    const opRev = revNet(operatingRevenue);
    const opCost = expNet(operatingCost);
    const taxSur = expNet(taxSurcharge);
    const sellExp = expNet(sellExpenses);
    const admExp = expNet(adminExpenses);
    const finExp = expNet(finExpenses);
    const invInc = revNet(investmentIncome);
    const nonOpInc = revNet(nonOpRevenue);
    const nonOpExp = expNet(nonOpExpenses);
    const incTax = expNet(incomeTax);

    // Operating profit = Revenue - Cost - Tax Surcharge - Sell - Admin - Fin + Investment
    const opProfit = opRev - opCost - taxSur - sellExp - admExp - finExp + invInc;
    // Total profit = Op Profit + NonOp Revenue - NonOp Expense
    const totalProfit = opProfit + nonOpInc - nonOpExp;
    // Net profit = Total Profit - Income Tax
    const netProfit = totalProfit - incTax;

    // YTD
    const ytdOpRev = ytdRevNet(operatingRevenue);
    const ytdOpCost = ytdExpNet(operatingCost);
    const ytdTaxSur = ytdExpNet(taxSurcharge);
    const ytdSellExp = ytdExpNet(sellExpenses);
    const ytdAdmExp = ytdExpNet(adminExpenses);
    const ytdFinExp = ytdExpNet(finExpenses);
    const ytdInvInc = ytdRevNet(investmentIncome);
    const ytdNonOpInc = ytdRevNet(nonOpRevenue);
    const ytdNonOpExp = ytdExpNet(nonOpExpenses);
    const ytdIncTax = ytdExpNet(incomeTax);
    const ytdOpProfit = ytdOpRev - ytdOpCost - ytdTaxSur - ytdSellExp - ytdAdmExp - ytdFinExp + ytdInvInc;
    const ytdTotalProfit = ytdOpProfit + ytdNonOpInc - ytdNonOpExp;
    const ytdNetProfit = ytdTotalProfit - ytdIncTax;

    success(res, {
      period: {
        operatingRevenue: opRev.toFixed(2),
        operatingCost: opCost.toFixed(2),
        taxSurcharge: taxSur.toFixed(2),
        sellExpense: sellExp.toFixed(2),
        adminExpense: admExp.toFixed(2),
        finExpense: finExp.toFixed(2),
        investmentIncome: invInc.toFixed(2),
        operatingProfit: opProfit.toFixed(2),
        nonOpRevenue: nonOpInc.toFixed(2),
        nonOpExpense: nonOpExp.toFixed(2),
        totalProfit: totalProfit.toFixed(2),
        incomeTax: incTax.toFixed(2),
        netProfit: netProfit.toFixed(2),
      },
      ytd: {
        operatingRevenue: ytdOpRev.toFixed(2),
        operatingCost: ytdOpCost.toFixed(2),
        taxSurcharge: ytdTaxSur.toFixed(2),
        sellExpense: ytdSellExp.toFixed(2),
        adminExpense: ytdAdmExp.toFixed(2),
        finExpense: ytdFinExp.toFixed(2),
        investmentIncome: ytdInvInc.toFixed(2),
        operatingProfit: ytdOpProfit.toFixed(2),
        nonOpRevenue: ytdNonOpInc.toFixed(2),
        nonOpExpense: ytdNonOpExp.toFixed(2),
        totalProfit: ytdTotalProfit.toFixed(2),
        incomeTax: ytdIncTax.toFixed(2),
        netProfit: ytdNetProfit.toFixed(2),
      },
      // Detail arrays for drill-down
      operatingRevenue, nonOpRevenue, investmentIncome,
      operatingCost, taxSurcharge,
      adminExpenses, sellExpenses, finExpenses,
      nonOpExpenses, incomeTax,
    });
  } catch (err) { error(res, '利润表查询失败: ' + err.message); }
});

// ==================== 交易记录（流水 — 含分页合计/累计）（流水 — 含分页合计/累计） ====================

router.get('/transactions', async (req, res) => {
  try {
    const { page: p = 1, pageSize = 20, type, subject_id, account_id,
            date_from, date_to, keyword, is_tax_deductible } = req.query;
    const offset = (Number(p) - 1) * Number(pageSize);
    // Build WHERE clause with db.escape() — avoids mysql2 prepared-statement caching bug
    const esc = v => db.escape(v);
    let where = ['1=1'];
    if (type) { where.push(`t.type = ${esc(type)}`); }
    if (subject_id) { where.push(`t.subject_id = ${esc(subject_id)}`); }
    if (account_id) { where.push(`t.account_id = ${esc(account_id)}`); }
    if (date_from) { where.push(`t.date >= ${esc(date_from)}`); }
    if (date_to) { where.push(`t.date <= ${esc(date_to)}`); }
    if (keyword) { where.push(`(t.description LIKE ${esc(`%${keyword}%`)} OR t.counterparty LIKE ${esc(`%${keyword}%`)})`); }
    if (is_tax_deductible !== undefined) { where.push(`t.is_tax_deductible = ${esc(is_tax_deductible)}`); }
    const whereClause = where.join(' AND ');

    const [[{total}]] = await db.query(`SELECT COUNT(*) AS total FROM acc_transactions t WHERE ${whereClause}`);
    const [rows] = await db.query(
      `SELECT t.*, s.name AS subject_name, s.code AS subject_code, a.name AS account_name
       FROM acc_transactions t
       LEFT JOIN acc_subjects s ON t.subject_id = s.id
       LEFT JOIN acc_accounts a ON t.account_id = a.id
       WHERE ${whereClause} ORDER BY t.date DESC, t.id DESC LIMIT ${Number(pageSize)} OFFSET ${offset}`
    );

    // 本页合计
    const pageExpense = rows.filter(r => r.type === 'expense').reduce((a, r) => a + Number(r.amount), 0);
    const pageIncome = rows.filter(r => r.type === 'income').reduce((a, r) => a + Number(r.amount), 0);

    // 本期合计（当前筛选条件全部数据）
    let periodExpense = pageExpense, periodIncome = pageIncome;
    if (total > rows.length) {
      const [[pt]] = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS e,
                COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS i
         FROM acc_transactions t WHERE ${whereClause}`
      );
      periodExpense = Number(pt.e); periodIncome = Number(pt.i);
    }

    // 重新查 YTD（不加日期筛选）— 从 where 中排除日期条件
    let ytdWhere = ['1=1'];
    if (type) { ytdWhere.push(`type = ${esc(type)}`); }
    if (subject_id) { ytdWhere.push(`subject_id = ${esc(subject_id)}`); }
    if (account_id) { ytdWhere.push(`account_id = ${esc(account_id)}`); }
    if (keyword) { ytdWhere.push(`(description LIKE ${esc(`%${keyword}%`)} OR counterparty LIKE ${esc(`%${keyword}%`)})`); }
    if (is_tax_deductible !== undefined) { ytdWhere.push(`is_tax_deductible = ${esc(is_tax_deductible)}`); }
    const [ytdRows] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS e,
              COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS i
       FROM acc_transactions WHERE ${ytdWhere.join(' AND ')}`
    );
    const ytdTotals = ytdRows[0];

    page(res, rows, total, Number(p), Number(pageSize), {
      pageTotals: { expense: pageExpense, income: pageIncome },
      periodTotals: { expense: periodExpense, income: periodIncome },
      ytdTotals: { expense: Number(ytdTotals.e), income: Number(ytdTotals.i) }
    });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

router.get('/transactions/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT t.*, s.name AS subject_name, s.code AS subject_code, a.name AS account_name
       FROM acc_transactions t
       LEFT JOIN acc_subjects s ON t.subject_id = s.id
       LEFT JOIN acc_accounts a ON t.account_id = a.id
       WHERE t.id = ?`, [req.params.id]);
    if (!rows.length) return error(res, '记录不存在', 404);
    success(res, rows[0]);
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

router.post('/transactions', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const { type, amount, subject_id, account_id, date, description, counterparty, invoice_no, is_tax_deductible } = req.body;
    if (!type || !amount || !subject_id || !date) return error(res, '类型/金额/科目/日期 必填', 400);
    const [result] = await db.query(
      `INSERT INTO acc_transactions (type, amount, subject_id, category_id, account_id, date, description, counterparty, invoice_no, is_tax_deductible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [type, amount, subject_id, subject_id, account_id || null, date, description || '', counterparty || '', invoice_no || '', is_tax_deductible ? 1 : 0]
    );
    success(res, { id: result.insertId }, '添加成功');
  } catch (err) { error(res, '添加失败: ' + err.message); }
});

router.put('/transactions/:id', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const { type, amount, subject_id, account_id, date, description, counterparty, invoice_no, is_tax_deductible } = req.body;
    await db.query(
      `UPDATE acc_transactions SET type=?, amount=?, subject_id=?, category_id=?, account_id=?, date=?,
       description=?, counterparty=?, invoice_no=?, is_tax_deductible=? WHERE id=?`,
      [type, amount, subject_id, subject_id, account_id || null, date, description || '', counterparty || '', invoice_no || '', is_tax_deductible ? 1 : 0, req.params.id]
    );
    success(res, null, '修改成功');
  } catch (err) { error(res, '修改失败: ' + err.message); }
});

router.delete('/transactions/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM acc_transactions WHERE id = ?', [req.params.id]);
    success(res, null, '删除成功');
  } catch (err) { error(res, '删除失败: ' + err.message); }
});

// ==================== 账户 CRUD ====================

router.get('/accounts', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM acc_accounts ORDER BY id');
    success(res, rows);
  } catch (err) { error(res, '查询账户失败: ' + err.message); }
});

router.post('/accounts', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { name, type, balance, note } = req.body;
    if (!name) return error(res, '名称必填', 400);
    const [result] = await db.query(
      'INSERT INTO acc_accounts (name, type, balance, note) VALUES (?, ?, ?, ?)',
      [name, type || 'other', balance || 0, note || '']
    );
    success(res, { id: result.insertId }, '账户添加成功');
  } catch (err) { error(res, '添加失败: ' + err.message); }
});

router.put('/accounts/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { name, balance, note, is_active } = req.body;
    await db.query('UPDATE acc_accounts SET name=?, balance=?, note=?, is_active=? WHERE id=?',
      [name, balance || 0, note || '', is_active !== undefined ? is_active : 1, req.params.id]);
    success(res, null, '修改成功');
  } catch (err) { error(res, '修改失败: ' + err.message); }
});

// ==================== 汇总 & 导出 ====================

router.get('/summary', async (req, res) => {
  try {
    const { year, month } = req.query;
    let dateFilter = '', ytdFilter = '', params = [], ytdParams = [];
    if (year && month) {
      const m = String(Number(month)).padStart(2, '0');
      const lastDay = String(new Date(Number(year), Number(month), 0).getDate()).padStart(2, '0');
      dateFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      params = [year+'-'+m+'-01', year+'-'+m+'-'+lastDay];
      ytdFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      ytdParams = [year+'-01-01', year+'-'+m+'-'+lastDay];
    } else if (year) {
      dateFilter = ' AND YEAR(v.voucher_date) = ?';
      params = [Number(year)];
      ytdFilter = ' AND YEAR(v.voucher_date) = ?';
      ytdParams = [Number(year)];
    }

    const baseQ = ` FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
      JOIN acc_subjects s ON e.subject_id = s.id AND s.is_active = 1`;

    // 本月收入/支出 (from voucher entries by subject type)
    const [[totals]] = await db.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN s.type='revenue' THEN e.credit_amount - e.debit_amount ELSE 0 END),0) AS incomeTotal,
        COALESCE(SUM(CASE WHEN s.type IN ('expense','cost') THEN e.debit_amount - e.credit_amount ELSE 0 END),0) AS expenseTotal
       ${baseQ} WHERE 1=1${dateFilter}`, params
    );

    // YTD
    const [[ytdTotals]] = ytdParams.length > 0 ? await db.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN s.type='revenue' THEN e.credit_amount - e.debit_amount ELSE 0 END),0) AS ytdIncome,
        COALESCE(SUM(CASE WHEN s.type IN ('expense','cost') THEN e.debit_amount - e.credit_amount ELSE 0 END),0) AS ytdExpense
       ${baseQ} WHERE 1=1${ytdFilter}`, ytdParams
    ) : [[{ytdIncome: 0, ytdExpense: 0}]];

    // 按科目分类汇总 (本月)
    const [bySubject] = await db.query(
      `SELECT s.name AS subject, s.type, 
        COALESCE(SUM(CASE WHEN s.type IN ('expense','cost') THEN e.debit_amount - e.credit_amount 
                          WHEN s.type='revenue' THEN e.credit_amount - e.debit_amount
                          ELSE 0 END),0) AS total,
        COUNT(DISTINCT v.id) AS count
       ${baseQ} WHERE 1=1${dateFilter}
       GROUP BY s.name, s.type HAVING total > 0 ORDER BY total DESC`, params
    );

    // 趋势 (近12个月)
    const [trend] = await db.query(
      `SELECT DATE_FORMAT(v.voucher_date, '%Y-%m') AS month,
        COALESCE(SUM(CASE WHEN s.type='revenue' THEN e.credit_amount - e.debit_amount ELSE 0 END),0) AS income,
        COALESCE(SUM(CASE WHEN s.type IN ('expense','cost') THEN e.debit_amount - e.credit_amount ELSE 0 END),0) AS expense
       FROM acc_voucher_entries e
       JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
       JOIN acc_subjects s ON e.subject_id = s.id AND s.is_active = 1
       WHERE v.voucher_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
       GROUP BY month ORDER BY month`
    );

    const transactionCount = params.length > 0 ? 
      (await db.query(`SELECT COUNT(DISTINCT v.id) AS cnt FROM acc_vouchers v JOIN acc_voucher_entries e ON e.voucher_id=v.id JOIN acc_subjects s ON e.subject_id=s.id WHERE v.status='posted'${dateFilter}`, params))[0][0].cnt
      : 0;

    success(res, {
      incomeTotal: Number(totals.incomeTotal) || 0,
      expenseTotal: Number(totals.expenseTotal) || 0,
      netProfit: (Number(totals.incomeTotal)||0) - (Number(totals.expenseTotal)||0),
      ytdIncome: Number(ytdTotals.ytdIncome) || 0,
      ytdExpense: Number(ytdTotals.ytdExpense) || 0,
      ytdNetProfit: (Number(ytdTotals.ytdIncome)||0) - (Number(ytdTotals.ytdExpense)||0),
      transactionCount,
      bySubject,
      byCategory: bySubject,
      trend
    });
  } catch (err) { error(res, '汇总失败: ' + err.message); }
});
router.get('/export', async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    let where = ['1=1'], params = [];
    if (date_from) { where.push('t.date >= ?'); params.push(date_from); }
    if (date_to) { where.push('t.date <= ?'); params.push(date_to); }
    const [rows] = await db.query(
      `SELECT t.date, t.type, t.amount, s.name AS subject, s.code AS subject_code, a.name AS account,
              t.description, t.counterparty, t.invoice_no, t.is_tax_deductible
       FROM acc_transactions t
       LEFT JOIN acc_subjects s ON t.subject_id = s.id
       LEFT JOIN acc_accounts a ON t.account_id = a.id
       WHERE ${where.join(' AND ')} ORDER BY t.date DESC`, params
    );
    const BOM = '\uFEFF';
    let csv = BOM + '日期,类型,金额,科目编码,科目,账户,摘要,对方,发票号,可抵扣\n';
    rows.forEach(r => {
      csv += `${r.date},${r.type==='income'?'收入':'支出'},${r.amount},${r.subject_code||''},${r.subject},${r.account||''},"${r.description}","${r.counterparty}",${r.invoice_no},${r.is_tax_deductible?'是':'否'}\n`;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="jiaapp_accounting_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (err) { error(res, '导出失败: ' + err.message); }
});

// ==================== 统一期间报表（月/季/年） ====================

router.get('/statements/report', async (req, res) => {
  try {
    const { period = 'monthly', year, month, quarter } = req.query;
    const y = Number(year) || new Date().getFullYear();

    // 期间范围
    let dateFrom, dateTo, periodLabel;
    if (period === 'monthly') {
      const m = Number(month) || new Date().getMonth() + 1;
      dateFrom = `${y}-${String(m).padStart(2, '0')}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      dateTo = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      periodLabel = `${y}年${m}月`;
    } else if (period === 'quarterly') {
      const q = Number(quarter) || Math.ceil((new Date().getMonth() + 1) / 3);
      const startMonth = (q - 1) * 3 + 1;
      dateFrom = `${y}-${String(startMonth).padStart(2, '0')}-01`;
      const lastDay = new Date(y, startMonth + 2, 0).getDate();
      dateTo = `${y}-${String(startMonth + 2).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      periodLabel = `${y}年第${q}季度`;
    } else {
      dateFrom = `${y}-01-01`;
      dateTo = `${y}-12-31`;
      periodLabel = `${y}年度`;
    }

    // 去年同期
    const prevFrom = period === 'annual'
      ? `${y - 1}-01-01` : `${y - 1}-${dateFrom.slice(5)}`;
    const prevTo = period === 'annual'
      ? `${y - 1}-12-31` : `${y - 1}-${dateTo.slice(5)}`;

    // ===== 1. 资产负债表（截至 dateTo，基于凭证分录） =====
    const [bsRows] = await db.query(
      `SELECT s.id, s.code, s.name, s.type, s.direction,
              COALESCE(SUM(ve.debit_amount), 0) AS total_debit,
              COALESCE(SUM(ve.credit_amount), 0) AS total_credit
       FROM acc_subjects s
       LEFT JOIN acc_voucher_entries ve ON s.id = ve.subject_id
       LEFT JOIN acc_vouchers v ON ve.voucher_id = v.id
       WHERE s.type IN ('asset','liability','equity') AND s.is_active = 1
         AND (v.status = 'posted' OR v.status IS NULL)
         AND (v.voucher_date <= ? OR v.voucher_date IS NULL)
       GROUP BY s.id, s.code, s.name, s.type, s.direction
       ORDER BY s.code`,
      [dateTo]
    );

    const calcBalance = r => r.direction === 'debit'
      ? Number(r.total_debit) - Number(r.total_credit)
      : Number(r.total_credit) - Number(r.total_debit);

    const assets = bsRows.filter(r => r.type === 'asset')
      .map(r => ({ code: r.code, name: r.name, balance: calcBalance(r) }));
    const liabilities = bsRows.filter(r => r.type === 'liability')
      .map(r => ({ code: r.code, name: r.name, balance: calcBalance(r) }));
    const equityRs = bsRows.filter(r => r.type === 'equity')
      .map(r => ({ code: r.code, name: r.name, balance: calcBalance(r) }));

    const totalAssets = assets.reduce((a, r) => a + r.balance, 0);
    const totalLiabilities = liabilities.reduce((a, r) => a + r.balance, 0);
    const totalEquityBase = equityRs.reduce((a, r) => a + r.balance, 0);

    // 净利润（截至 dateTo，含历史结转冲销，用于 BS 平衡）
    const [bsPlRows] = await db.query(
      `SELECT s.type,
              COALESCE(SUM(ve.debit_amount), 0) AS total_debit,
              COALESCE(SUM(ve.credit_amount), 0) AS total_credit
       FROM acc_voucher_entries ve
       JOIN acc_vouchers v ON ve.voucher_id = v.id AND v.status='posted'
       JOIN acc_subjects s ON ve.subject_id = s.id
       WHERE v.voucher_date <= ? AND s.type IN ('revenue','cost','expense') AND s.is_active = 1
       GROUP BY s.type`,
      [dateTo]
    );
    const bsNetMap = {}; bsPlRows.forEach(r => { bsNetMap[r.type] = r; });
    const bsRevenue = Number((bsNetMap['revenue']||{}).total_credit||0) - Number((bsNetMap['revenue']||{}).total_debit||0);
    const bsCost = Number((bsNetMap['cost']||{}).total_debit||0) - Number((bsNetMap['cost']||{}).total_credit||0);
    const bsExpense = Number((bsNetMap['expense']||{}).total_debit||0) - Number((bsNetMap['expense']||{}).total_credit||0);
    const bsNetProfit = bsRevenue - bsCost - bsExpense;
    const totalEquity = totalEquityBase + bsNetProfit;

    // ===== 2. 利润表（基于凭证分录，当期 + 本年累计） =====
    // 当期损益
    const [[isPeriod]] = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN s.type='revenue' AND s.direction='credit' THEN ve.credit_amount - ve.debit_amount ELSE 0 END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN s.type='revenue' AND s.direction='debit' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS revenue_dr,
         COALESCE(SUM(CASE WHEN s.type='cost' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS cost,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code LIKE '64%' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS tax_surcharge,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code LIKE '6601%' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS sell_expense,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code LIKE '6602%' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS admin_expense,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code LIKE '6603%' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS fin_expense,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code='6801' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS non_op_expense,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code='6802' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS income_tax,
         COALESCE(SUM(CASE WHEN s.type='income' THEN ve.credit_amount - ve.debit_amount ELSE 0 END), 0) AS non_op_revenue,
         COALESCE(SUM(CASE WHEN s.type='income' AND s.code LIKE '6111%' THEN ve.credit_amount - ve.debit_amount ELSE 0 END), 0) AS investment_income
       FROM acc_voucher_entries ve
       JOIN acc_vouchers v ON ve.voucher_id = v.id AND v.status='posted'
       JOIN acc_subjects s ON ve.subject_id = s.id
       WHERE v.voucher_date >= ? AND v.voucher_date <= ?`,
      [dateFrom, dateTo]
    );
    const pd = isPeriod;
    const periodRevenue = Number(pd.revenue || 0) + Number(pd.revenue_dr || 0);
    const periodCost = Number(pd.cost || 0);
    const periodTaxSurcharge = Number(pd.tax_surcharge || 0);
    const periodSellExp = Number(pd.sell_expense || 0);
    const periodAdminExp = Number(pd.admin_expense || 0);
    const periodFinExp = Number(pd.fin_expense || 0);
    const periodNonOpRev = Number(pd.non_op_revenue || 0);
    const periodNonOpExp = Number(pd.non_op_expense || 0);
    const periodInvIncome = Number(pd.investment_income || 0);
    const periodIncTax = Number(pd.income_tax || 0);
    const periodTotalExp = periodCost + periodTaxSurcharge + periodSellExp + periodAdminExp + periodFinExp;
    const periodOperatingProfit = periodRevenue - periodTotalExp;
    const periodTotalProfit = periodOperatingProfit + periodNonOpRev - periodNonOpExp + periodInvIncome;
    const periodNetProfit = periodTotalProfit - periodIncTax;

    // 本年累计（1月1日 ~ dateTo）
    const ytdFrom = `${y}-01-01`;
    const [[isYtd]] = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN s.type='revenue' AND s.direction='credit' THEN ve.credit_amount - ve.debit_amount ELSE 0 END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN s.type='revenue' AND s.direction='debit' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS revenue_dr,
         COALESCE(SUM(CASE WHEN s.type='cost' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS cost,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code LIKE '64%' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS tax_surcharge,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code LIKE '6601%' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS sell_expense,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code LIKE '6602%' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS admin_expense,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code LIKE '6603%' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS fin_expense,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code='6801' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS non_op_expense,
         COALESCE(SUM(CASE WHEN s.type='expense' AND s.code='6802' THEN ve.debit_amount - ve.credit_amount ELSE 0 END), 0) AS income_tax,
         COALESCE(SUM(CASE WHEN s.type='income' THEN ve.credit_amount - ve.debit_amount ELSE 0 END), 0) AS non_op_revenue,
         COALESCE(SUM(CASE WHEN s.type='income' AND s.code LIKE '6111%' THEN ve.credit_amount - ve.debit_amount ELSE 0 END), 0) AS investment_income
       FROM acc_voucher_entries ve
       JOIN acc_vouchers v ON ve.voucher_id = v.id AND v.status='posted'
       JOIN acc_subjects s ON ve.subject_id = s.id
       WHERE v.voucher_date >= ? AND v.voucher_date <= ?`,
      [ytdFrom, dateTo]
    );
    const yt = isYtd;
    const ytdRevenue = Number(yt.revenue || 0) + Number(yt.revenue_dr || 0);
    const ytdCost = Number(yt.cost || 0);
    const ytdTaxSurcharge = Number(yt.tax_surcharge || 0);
    const ytdSellExp = Number(yt.sell_expense || 0);
    const ytdAdminExp = Number(yt.admin_expense || 0);
    const ytdFinExp = Number(yt.fin_expense || 0);
    const ytdNonOpRev = Number(yt.non_op_revenue || 0);
    const ytdNonOpExp = Number(yt.non_op_expense || 0);
    const ytdInvIncome = Number(yt.investment_income || 0);
    const ytdIncTax = Number(yt.income_tax || 0);
    const ytdTotalExp = ytdCost + ytdTaxSurcharge + ytdSellExp + ytdAdminExp + ytdFinExp;
    const ytdOperatingProfit = ytdRevenue - ytdTotalExp;
    const ytdTotalProfit = ytdOperatingProfit + ytdNonOpRev - ytdNonOpExp + ytdInvIncome;
    const ytdNetProfit = ytdTotalProfit - ytdIncTax;

    // ===== 3. 现金流量表（基于凭证分录：现金科目） =====
    const [[cfTotals]] = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN s.code='1001' OR s.code LIKE '1002%' THEN ve.debit_amount ELSE 0 END), 0) AS inflow,
         COALESCE(SUM(CASE WHEN s.code='1001' OR s.code LIKE '1002%' THEN ve.credit_amount ELSE 0 END), 0) AS outflow
       FROM acc_voucher_entries ve
       JOIN acc_vouchers v ON ve.voucher_id = v.id AND v.status='posted'
       JOIN acc_subjects s ON ve.subject_id = s.id
       WHERE v.voucher_date >= ? AND v.voucher_date <= ?`,
      [dateFrom, dateTo]
    );
    const cashInflow = Number(cfTotals.inflow) || 0;
    const cashOutflow = Number(cfTotals.outflow) || 0;

    // ===== 4. 同期对比 =====
    const [[prevTotals]] = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END), 0) AS revenue,
              COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END), 0) AS expense
       FROM acc_transactions t WHERE t.date >= ? AND t.date <= ?`,
      [prevFrom, prevTo]
    );
    const prevRevenue = Number(prevTotals.revenue);
    const prevExpense = Number(prevTotals.expense);
    const prevNet = prevRevenue - prevExpense;
    const periodNet = periodNetProfit;
    const ytdNet = ytdNetProfit;

    // ===== 5. 税务汇总（从 acc_tax_reports JSON 提取） =====
    const taxPeriod = dateFrom.slice(0, 7);
    const taxPeriodEnd = dateTo.slice(0, 7);
    const [taxRows] = await db.query(
      `SELECT report_type, report_data FROM acc_tax_reports
       WHERE report_period >= ? AND report_period <= ?`,
      [taxPeriod, taxPeriodEnd]
    );

    success(res, {
      period: {
        type: period, year: y,
        month: period === 'monthly' ? (Number(month) || new Date().getMonth() + 1) : undefined,
        quarter: period === 'quarterly' ? (Number(quarter) || Math.ceil((new Date().getMonth() + 1) / 3)) : undefined,
        label: periodLabel, dateFrom, dateTo
      },
      balanceSheet: {
        totalAssets, totalLiabilities, totalEquity: Number(totalEquity.toFixed(2)),
        balanced: Math.abs(totalAssets - totalLiabilities - Number(totalEquity.toFixed(2))) < 0.01,
        assets, liabilities, equity: equityRs
      },
      incomeStatement: {
        period: {
          revenue: periodRevenue, cost: periodCost,
          taxSurcharge: periodTaxSurcharge,
          sellExpense: periodSellExp, adminExpense: periodAdminExp, finExpense: periodFinExp,
          nonOpRevenue: periodNonOpRev, nonOpExpense: periodNonOpExp,
          investmentIncome: periodInvIncome, incomeTax: periodIncTax,
          operatingProfit: periodOperatingProfit,
          totalProfit: periodTotalProfit,
          netProfit: periodNetProfit
        },
        ytd: {
          revenue: ytdRevenue, cost: ytdCost,
          taxSurcharge: ytdTaxSurcharge,
          sellExpense: ytdSellExp, adminExpense: ytdAdminExp, finExpense: ytdFinExp,
          nonOpRevenue: ytdNonOpRev, nonOpExpense: ytdNonOpExp,
          investmentIncome: ytdInvIncome, incomeTax: ytdIncTax,
          operatingProfit: ytdOperatingProfit,
          totalProfit: ytdTotalProfit,
          netProfit: ytdNetProfit
        }
      },
      cashFlow: {
        inflow: cashInflow, outflow: cashOutflow,
        netCashFlow: cashInflow - cashOutflow
      },
      comparison: {
        prevRevenue, prevExpense, prevNet: prevNet,
        revenueChange: prevRevenue
          ? ((periodRevenue - prevRevenue) / prevRevenue * 100).toFixed(1) + '%'
          : (periodRevenue > 0 ? '+∞' : '0.0%'),
        netChange: prevNet
          ? ((periodNet - prevNet) / Math.abs(prevNet) * 100).toFixed(1) + '%'
          : (periodNet > 0 ? '+∞' : '0.0%')
      },
      tax: taxRows.map(r => {
        let amount = 0, base = 0;
        try {
          const data = typeof r.report_data === 'string'
            ? JSON.parse(r.report_data) : r.report_data;
          amount = data.total_tax_amount || data.tax_amount || 0;
          base = data.total_taxable_base || data.taxable_base || 0;
        } catch (e) { /* ignore malformed JSON */ }
        return { type: r.report_type, amount: Number(amount), base: Number(base) };
      })
    });
  } catch (err) {
    error(res, '报表生成失败: ' + err.message);
  }
});

// ==================== 摘要 → 科目智能推荐 ====================

// 中文文本相似度（Jaccard 系数，基于字符集）
function charJaccard(a, b) {
  const sa = new Set(a.replace(/\s+/g, ''));
  const sb = new Set(b.replace(/\s+/g, ''));
  let intersect = 0;
  for (const c of sa) { if (sb.has(c)) intersect++; }
  const union = sa.size + sb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// 中文分词（2-gram + 单字）
function tokenize(text) {
  const cleaned = text.replace(/[\s\-_,，。！？、；：（）\(\)""''【】《》\[\]]/g, '');
  const tokens = [];
  for (let i = 0; i < cleaned.length; i++) {
    tokens.push(cleaned[i]);
    if (i + 1 < cleaned.length) tokens.push(cleaned[i] + cleaned[i + 1]);
  }
  return tokens;
}

// Token 覆盖率得分
function tokenOverlap(query, target) {
  const qt = tokenize(query);
  const tt = tokenize(target);
  let hits = 0;
  for (const t of qt) { if (tt.includes(t)) hits++; }
  return qt.length === 0 ? 0 : hits / qt.length;
}

router.post('/suggest-subjects', async (req, res) => {
  try {
    const { summary, topN = 5 } = req.body;
    if (!summary || summary.trim().length < 2) {
      return error(res, '请输入至少2个字的摘要内容', 400);
    }
    const q = summary.trim();

    const [subjects] = await db.query(
      'SELECT id, code, name, type, direction FROM acc_subjects WHERE is_active=1 ORDER BY code'
    );

    const [history] = await db.query(
      `SELECT DISTINCT ve.summary, ve.subject_id
       FROM acc_voucher_entries ve
       WHERE ve.summary IS NOT NULL AND ve.summary != ''
       ORDER BY ve.id DESC LIMIT 1000`
    );

    // 历史摘要匹配
    const historyScores = {};
    for (const h of history) {
      const jac = charJaccard(q, h.summary);
      const tok = tokenOverlap(q, h.summary);
      const score = jac * 0.5 + tok * 0.5;
      if (score === 0) continue;
      if (!historyScores[h.subject_id] || historyScores[h.subject_id].score < score) {
        historyScores[h.subject_id] = { score, matchedSummary: h.summary };
      }
    }

    // 科目名直接匹配
    const nameScores = {};
    for (const s of subjects) {
      if (q.includes(s.name) || s.name.includes(q)) {
        nameScores[s.id] = { score: q.includes(s.name) ? 1.0 : 0.8, matchType: '名称包含匹配' };
      } else {
        const jac = charJaccard(q, s.name);
        if (jac > 0.25) nameScores[s.id] = { score: jac * 0.7, matchType: '名称模糊匹配' };
      }
    }

    // 合并得分
    const results = subjects.map(s => {
      const h = historyScores[s.id];
      const n = nameScores[s.id];
      let score = 0, matchedBy = null, matchedSummary = null;
      if (h && n) {
        score = h.score * 0.55 + n.score * 0.45;
        matchedBy = h.score > n.score ? '历史摘要相似' : n.matchType;
        matchedSummary = h.matchedSummary;
      } else if (h) {
        score = h.score * 0.6;
        matchedBy = '历史摘要相似';
        matchedSummary = h.matchedSummary;
      } else if (n) {
        score = n.score * 0.8;
        matchedBy = n.matchType;
      }
      if (score === 0) { const tok = tokenOverlap(q, s.name); if (tok > 0) score = tok * 0.3; }
      return { subject_id: s.id, code: s.code, name: s.name, type: s.type, direction: s.direction, score: Math.round(score * 1000) / 1000, matched_by: matchedBy, matched_summary: matchedSummary };
    });

    const sorted = results.filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, Number(topN));

    success(res, { query: q, total_subjects: subjects.length, history_samples: history.length, suggestions: sorted });
  } catch (err) {
    error(res, '智能推荐失败: ' + err.message);
  }
});

// ==================== 辅助核算 ====================

// --- 辅助核算类型 CRUD ---

router.get('/auxiliary/types', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM acc_auxiliary_types WHERE is_active=1 ORDER BY sort_order'
    );
    success(res, rows);
  } catch (err) { error(res, '查询辅助类型失败: ' + err.message); }
});

router.post('/auxiliary/types', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { code, name, description, sort_order } = req.body;
    if (!code || !name) return error(res, '类型编码和名称必填', 400);
    const [result] = await db.query(
      'INSERT INTO acc_auxiliary_types (code, name, description, sort_order) VALUES (?,?,?,?)',
      [code, name, description||'', sort_order||0]
    );
    success(res, { id: result.insertId }, '辅助类型创建成功');
  } catch (err) { error(res, '创建辅助类型失败: ' + err.message); }
});

router.put('/auxiliary/types/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { name, description, sort_order, is_active } = req.body;
    await db.query(
      'UPDATE acc_auxiliary_types SET name=?, description=?, sort_order=?, is_active=? WHERE id=?',
      [name, description||'', sort_order||0, is_active!==undefined?is_active:1, req.params.id]
    );
    success(res, null, '辅助类型更新成功');
  } catch (err) { error(res, '更新辅助类型失败: ' + err.message); }
});

router.delete('/auxiliary/types/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [items] = await db.query('SELECT COUNT(*) as cnt FROM acc_auxiliary_items WHERE type_id=?', [req.params.id]);
    if (items[0].cnt > 0) return error(res, '该类型下有项目，无法删除', 400);
    await db.query('DELETE FROM acc_auxiliary_types WHERE id=?', [req.params.id]);
    success(res, null, '辅助类型删除成功');
  } catch (err) { error(res, '删除辅助类型失败: ' + err.message); }
});

// --- 辅助核算项目 CRUD ---

router.get('/auxiliary/items', async (req, res) => {
  try {
    const { type_id, keyword } = req.query;
    let where = ['ai.is_active=1'], params = [];
    if (type_id) { where.push('ai.type_id=?'); params.push(type_id); }
    if (keyword) { where.push('(ai.name LIKE ? OR ai.code LIKE ? OR ai.contact LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
    const [rows] = await db.query(
      `SELECT ai.*, at.name AS type_name, at.code AS type_code
       FROM acc_auxiliary_items ai
       JOIN acc_auxiliary_types at ON ai.type_id = at.id
       WHERE ${where.join(' AND ')} ORDER BY at.sort_order, ai.code`,
      params
    );
    success(res, rows);
  } catch (err) { error(res, '查询辅助项目失败: ' + err.message); }
});

router.get('/auxiliary/items/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ai.*, at.name AS type_name, at.code AS type_code
       FROM acc_auxiliary_items ai
       JOIN acc_auxiliary_types at ON ai.type_id = at.id
       WHERE ai.id=?`, [req.params.id]
    );
    if (!rows.length) return error(res, '项目不存在', 404);
    success(res, rows[0]);
  } catch (err) { error(res, '查询项目失败: ' + err.message); }
});

router.post('/auxiliary/items', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const { type_id, code, name, contact, phone, address, note } = req.body;
    if (!type_id || !name) return error(res, '辅助类型和项目名称必填', 400);
    const [result] = await db.query(
      'INSERT INTO acc_auxiliary_items (type_id, code, name, contact, phone, address, note) VALUES (?,?,?,?,?,?,?)',
      [type_id, code||'', name, contact||'', phone||'', address||'', note||'']
    );
    success(res, { id: result.insertId }, '项目创建成功');
  } catch (err) { error(res, '创建项目失败: ' + err.message); }
});

router.put('/auxiliary/items/:id', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const { type_id, code, name, contact, phone, address, note, is_active } = req.body;
    await db.query(
      'UPDATE acc_auxiliary_items SET type_id=?, code=?, name=?, contact=?, phone=?, address=?, note=?, is_active=? WHERE id=?',
      [type_id, code||'', name, contact||'', phone||'', address||'', note||'', is_active!==undefined?is_active:1, req.params.id]
    );
    success(res, null, '项目更新成功');
  } catch (err) { error(res, '更新项目失败: ' + err.message); }
});

router.delete('/auxiliary/items/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [used] = await db.query('SELECT COUNT(*) as cnt FROM acc_entry_auxiliary WHERE aux_item_id=?', [req.params.id]);
    if (used[0].cnt > 0) return error(res, '该项目已被凭证使用，无法删除', 400);
    await db.query('DELETE FROM acc_auxiliary_items WHERE id=?', [req.params.id]);
    success(res, null, '项目删除成功');
  } catch (err) { error(res, '删除项目失败: ' + err.message); }
});

// --- 凭证分录关联辅助核算 ---

router.get('/auxiliary/entries/:entry_id', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT ea.*, at.name AS type_name, at.code AS type_code, ai.name AS item_name, ai.code AS item_code
       FROM acc_entry_auxiliary ea
       JOIN acc_auxiliary_types at ON ea.aux_type_id = at.id
       JOIN acc_auxiliary_items ai ON ea.aux_item_id = ai.id
       WHERE ea.entry_id = ?`,
      [req.params.entry_id]
    );
    success(res, rows);
  } catch (err) { error(res, '查询分录辅助核算失败: ' + err.message); }
});

router.post('/auxiliary/entries', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const { entry_id, aux_type_id, aux_item_id } = req.body;
    if (!entry_id || !aux_type_id || !aux_item_id) return error(res, '分录ID/辅助类型/辅助项目 必填', 400);
    // UPSERT
    await db.query(
      `INSERT INTO acc_entry_auxiliary (entry_id, aux_type_id, aux_item_id)
       VALUES (?,?,?) ON DUPLICATE KEY UPDATE aux_item_id=VALUES(aux_item_id)`,
      [entry_id, aux_type_id, aux_item_id]
    );
    success(res, null, '辅助核算关联成功');
  } catch (err) { error(res, '关联辅助核算失败: ' + err.message); }
});

router.delete('/auxiliary/entries', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { entry_id, aux_type_id } = req.body;
    if (!entry_id || !aux_type_id) return error(res, '分录ID和辅助类型必填', 400);
    await db.query('DELETE FROM acc_entry_auxiliary WHERE entry_id=? AND aux_type_id=?', [entry_id, aux_type_id]);
    success(res, null, '辅助核算解除成功');
  } catch (err) { error(res, '解除辅助核算失败: ' + err.message); }
});

// --- 凭证创建/更新时批量关联辅助核算 ---
// 在 POST /vouchers 完成后调用
const bindAuxiliary = async (entryId, auxiliary) => {
  if (!auxiliary || !Array.isArray(auxiliary)) return;
  for (const a of auxiliary) {
    if (a.type_id && a.item_id) {
      await db.query(
        `INSERT INTO acc_entry_auxiliary (entry_id, aux_type_id, aux_item_id)
         VALUES (?,?,?) ON DUPLICATE KEY UPDATE aux_item_id=VALUES(aux_item_id)`,
        [entryId, a.type_id, a.item_id]
      );
    }
  }
};

// ---- 辅助账查询 (核心) ----

router.get('/auxiliary/ledger', async (req, res) => {
  try {
    const { type_id, item_id, subject_id, year, month, date_from, date_to } = req.query;

    // 构建日期过滤
    let dateFilter = '', dateParams = [];
    if (date_from && date_to) {
      dateFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      dateParams = [date_from, date_to];
    } else if (year && month) {
      const m = String(Number(month)).padStart(2, '0');
      const firstDay = year + '-' + m + '-01';
      const lastDay = new Date(Number(year), Number(month), 0).getDate();
      dateFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      dateParams = [firstDay, year + '-' + m + '-' + String(lastDay).padStart(2, '0')];
    } else if (year) {
      dateFilter = ' AND YEAR(v.voucher_date) = ?';
      dateParams = [Number(year)];
    }

    // 辅助核算过滤
    let auxWhere = '1=1', auxParams = [];
    if (type_id) { auxWhere += ' AND ea.aux_type_id = ?'; auxParams.push(type_id); }
    if (item_id) { auxWhere += ' AND ea.aux_item_id = ?'; auxParams.push(item_id); }
    if (subject_id) { auxWhere += ' AND e.subject_id = ?'; auxParams.push(subject_id); }

    // 查询辅助账明细
    const [rows] = await db.query(
      `SELECT e.id AS entry_id, e.subject_id, e.summary, e.debit_amount, e.credit_amount,
              v.voucher_date, v.voucher_no, v.description AS voucher_desc,
              s.code AS subject_code, s.name AS subject_name, s.direction,
              ea.aux_type_id, ea.aux_item_id,
              at.name AS aux_type_name, at.code AS aux_type_code,
              ai.name AS aux_item_name, ai.code AS aux_item_code
       FROM acc_entry_auxiliary ea
       JOIN acc_voucher_entries e ON ea.entry_id = e.id
       JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
       JOIN acc_subjects s ON e.subject_id = s.id
       JOIN acc_auxiliary_types at ON ea.aux_type_id = at.id
       JOIN acc_auxiliary_items ai ON ea.aux_item_id = ai.id
       WHERE ${auxWhere}${dateFilter}
       ORDER BY v.voucher_date ASC, e.id ASC`,
      [...auxParams, ...dateParams]
    );

    // 按辅助项目+科目分组汇总
    const [summary] = await db.query(
      `SELECT ea.aux_type_id, ea.aux_item_id, at.name AS aux_type_name, ai.name AS aux_item_name, ai.code AS aux_item_code,
              e.subject_id, s.code AS subject_code, s.name AS subject_name, s.direction,
              COALESCE(SUM(e.debit_amount), 0) AS total_debit,
              COALESCE(SUM(e.credit_amount), 0) AS total_credit
       FROM acc_entry_auxiliary ea
       JOIN acc_voucher_entries e ON ea.entry_id = e.id
       JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
       JOIN acc_subjects s ON e.subject_id = s.id
       JOIN acc_auxiliary_types at ON ea.aux_type_id = at.id
       JOIN acc_auxiliary_items ai ON ea.aux_item_id = ai.id
       WHERE ${auxWhere}${dateFilter}
       GROUP BY ea.aux_type_id, ea.aux_item_id, at.name, ai.name, ai.code, e.subject_id, s.code, s.name, s.direction
       ORDER BY ai.code, s.code`,
      [...auxParams, ...dateParams]
    );

    // 计算每个组合的余额
    const enriched = summary.map(r => {
      const dr = Number(r.total_debit), cr = Number(r.total_credit);
      const balance = r.direction === 'debit' ? dr - cr : cr - dr;
      return {
        aux_type_name: r.aux_type_name,
        aux_item_id: r.aux_item_id,
        aux_item_name: r.aux_item_name,
        aux_item_code: r.aux_item_code,
        subject_id: r.subject_id,
        subject_code: r.subject_code,
        subject_name: r.subject_name,
        total_debit: dr.toFixed(2),
        total_credit: cr.toFixed(2),
        balance: balance.toFixed(2)
      };
    });

    // 按辅助项目聚合余额
    const itemMap = {};
    for (const r of enriched) {
      const key = `${r.aux_item_id}`;
      if (!itemMap[key]) {
        itemMap[key] = {
          aux_type_name: r.aux_type_name,
          aux_item_id: r.aux_item_id,
          aux_item_name: r.aux_item_name,
          aux_item_code: r.aux_item_code,
          total_debit: 0, total_credit: 0, balance: 0,
          subjects: []
        };
      }
      itemMap[key].total_debit += Number(r.total_debit);
      itemMap[key].total_credit += Number(r.total_credit);
      itemMap[key].balance += Number(r.balance);
      itemMap[key].subjects.push(r);
    }

    const items = Object.values(itemMap).map(i => ({
      ...i,
      total_debit: i.total_debit.toFixed(2),
      total_credit: i.total_credit.toFixed(2),
      balance: i.balance.toFixed(2)
    }));

    const totalDebit = items.reduce((a, i) => a + Number(i.total_debit), 0);
    const totalCredit = items.reduce((a, i) => a + Number(i.total_credit), 0);

    success(res, {
      filters: { type_id, item_id, subject_id, year, month, date_from, date_to },
      totals: { debit: totalDebit.toFixed(2), credit: totalCredit.toFixed(2) },
      items,
      details: rows.map(r => ({
        entry_id: r.entry_id,
        voucher_date: r.voucher_date,
        voucher_no: r.voucher_no,
        description: r.voucher_desc || r.summary,
        subject_code: r.subject_code,
        subject_name: r.subject_name,
        aux_type_name: r.aux_type_name,
        aux_item_name: r.aux_item_name,
        debit_amount: Number(r.debit_amount||0).toFixed(2),
        credit_amount: Number(r.credit_amount||0).toFixed(2)
      })),
      count: rows.length
    });
  } catch (err) { error(res, '查询辅助账失败: ' + err.message); }
});


// ==================== CSV 导出 ====================

// 试算平衡表 CSV 导出
router.get('/statements/trial-balance/export', async (req, res) => {
  try {
    const { year, month } = req.query;
    let dateFilter = '', params = [];
    if (year && month) {
      const m = String(Number(month)).padStart(2, '0');
      const firstDay = year + '-' + m + '-01';
      const lastDay = new Date(Number(year), Number(month), 0).getDate();
      dateFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      params = [firstDay, year + '-' + m + '-' + String(lastDay).padStart(2, '0')];
    } else if (year) {
      dateFilter = ' AND YEAR(v.voucher_date) = ?';
      params = [Number(year)];
    }
    const [rows] = await db.query(
      `SELECT s.code, s.name, s.type, s.direction,
              COALESCE(SUM(pe.debit_amount), 0) AS total_debit,
              COALESCE(SUM(pe.credit_amount), 0) AS total_credit
       FROM acc_subjects s
       LEFT JOIN (
         SELECT e.subject_id, e.debit_amount, e.credit_amount
         FROM acc_voucher_entries e
         JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'${dateFilter}
       ) pe ON s.id = pe.subject_id
       WHERE s.is_active = 1
       GROUP BY s.id, s.code, s.name, s.type, s.direction
       HAVING total_debit > 0 OR total_credit > 0
       ORDER BY s.code`, params);
    const BOM = '\uFEFF';
    let csv = BOM + '科目编码,科目名称,类型,方向,借方发生额,贷方发生额\n';
    rows.forEach(r => {
      const tLabel = {asset:'资产',liability:'负债',equity:'权益',cost:'成本',revenue:'收入',expense:'费用'};
      csv += `${r.code},${r.name},${tLabel[r.type]||r.type},${r.direction==='debit'?'借':'贷'},${Number(r.total_debit).toFixed(2)},${Number(r.total_credit).toFixed(2)}\n`;
    });
    const sd = rows.reduce((a,r)=>a+Number(r.total_debit),0);
    const sc = rows.reduce((a,r)=>a+Number(r.total_credit),0);
    csv += `合计,,,,${sd.toFixed(2)},${sc.toFixed(2)}\n`;
    csv += `差额,,,,,${Math.abs(sd-sc).toFixed(2)}\n`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="trial_balance_' + new Date().toISOString().slice(0,10) + '.csv"');
    res.send(csv);
  } catch(err){ error(res, '导出失败: '+err.message); }
});

// 资产负债表 CSV 导出
router.get('/statements/balance-sheet/export', async (req, res) => {
  try {
    const { year, month } = req.query;
    let dateFilter = '', params = [];
    if (year && month) {
      const m = String(Number(month)).padStart(2, '0');
      const lastDay = new Date(Number(year), Number(month), 0).getDate();
      dateFilter = ' AND v.voucher_date >= ? AND v.voucher_date <= ?';
      params = [year+'-'+m+'-01', year+'-'+m+'-'+String(lastDay).padStart(2,'0')];
    } else if (year) {
      dateFilter = ' AND YEAR(v.voucher_date) = ?';
      params = [Number(year)];
    }
    const q = ` FROM acc_subjects s
      LEFT JOIN (SELECT e.subject_id, e.debit_amount, e.credit_amount
        FROM acc_voucher_entries e
        JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'${dateFilter}
      ) pe ON s.id=pe.subject_id`;
    const [rows] = await db.query(
      `SELECT s.code,s.name,s.type,s.direction,COALESCE(SUM(pe.debit_amount),0) AS d,COALESCE(SUM(pe.credit_amount),0) AS c
       ${q} WHERE s.type IN ('asset','liability','equity') AND s.is_active=1 GROUP BY s.id,s.code,s.name,s.type,s.direction ORDER BY s.code`,params);
    const [ir] = await db.query(
      `SELECT s.type,COALESCE(SUM(pe.debit_amount),0) AS d,COALESCE(SUM(pe.credit_amount),0) AS c
       ${q} WHERE s.type IN ('revenue','cost','expense') AND s.is_active=1 GROUP BY s.type`,params);
    const im={}; ir.forEach(r=>{im[r.type]=r;});
    const tr=(Number((im['revenue']||{}).c||0)-Number((im['revenue']||{}).d||0));
    const tc=(Number((im['cost']||{}).d||0)-Number((im['cost']||{}).c||0));
    const te=(Number((im['expense']||{}).d||0)-Number((im['expense']||{}).c||0));
    const np=tr-tc-te;
    const bal=r=>r.direction==='debit'?Number(r.d)-Number(r.c):Number(r.c)-Number(r.d);
    const BOM='\uFEFF'; let csv=BOM+'资产负债表\n,,,\n项目,期末余额,项目,期末余额\n';
    const as=rows.filter(r=>r.type==='asset'), li=rows.filter(r=>r.type==='liability'), eq=rows.filter(r=>r.type==='equity');
    const max=Math.max(as.length,li.length+eq.length+1);
    for(let i=0;i<max;i++){
      const a=as[i], l=i<li.length?li[i]:null, e=i<li.length?null:eq[i-li.length-1];
      csv+=`${a?a.name+' ('+a.code+')':''},${a?bal(a).toFixed(2):''},`;
      if(l) csv+=`${l.name+' ('+l.code+')'},${bal(l).toFixed(2)}`;
      else if(e) csv+=`${e.name+' ('+e.code+')'},${bal(e).toFixed(2)}`;
      else if(i===li.length) csv+=`未分配利润,${np.toFixed(2)}`;
      else csv+=',';
      csv+='\n';
    }
    const ta=as.reduce((a,r)=>a+bal(r),0);
    const tl=li.reduce((a,r)=>a+bal(r),0);
    const teq=eq.reduce((a,r)=>a+bal(r),0)+np;
    csv+=`资产总计,${ta.toFixed(2)},负债和所有者权益总计,${(tl+teq).toFixed(2)}\n`;
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="balance_sheet_'+new Date().toISOString().slice(0,10)+'.csv"');
    res.send(csv);
  } catch(err){ error(res,'导出失败: '+err.message); }
});

// 利润表 CSV 导出
router.get('/statements/income-statement/export', async (req, res) => {
  try {
    const { year, month } = req.query;
    let per='', ytd='', pp=[], yp=[];
    if(year&&month){
      const m=String(Number(month)).padStart(2,'0');
      const ld=String(new Date(Number(year),Number(month),0).getDate()).padStart(2,'0');
      per=' AND v.voucher_date>=? AND v.voucher_date<=?'; pp=[year+'-'+m+'-01',year+'-'+m+'-'+ld];
      ytd=' AND v.voucher_date>=? AND v.voucher_date<=?'; yp=[year+'-01-01',year+'-'+m+'-'+ld];
    } else if(year){
      per=' AND YEAR(v.voucher_date)=?'; pp=[Number(year)];
      ytd=' AND YEAR(v.voucher_date)=?'; yp=[Number(year)];
    }
    const q=` FROM acc_subjects s LEFT JOIN (SELECT e.subject_id,e.debit_amount,e.credit_amount
      FROM acc_voucher_entries e JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'`;
    const [pr]=await db.query(`SELECT s.code,s.name,s.type,COALESCE(SUM(pe.debit_amount),0) AS d,COALESCE(SUM(pe.credit_amount),0) AS c
      ${q}${per}) pe ON s.id=pe.subject_id WHERE s.type IN ('revenue','cost','expense') AND s.is_active=1 GROUP BY s.id,s.code,s.name,s.type ORDER BY s.code`,pp);
    const [yr]=yp.length?await db.query(`SELECT s.id,COALESCE(SUM(ye.debit_amount),0) AS yd,COALESCE(SUM(ye.credit_amount),0) AS yc
      ${q}${ytd}) ye ON s.id=ye.subject_id WHERE s.type IN ('revenue','cost','expense') AND s.is_active=1 GROUP BY s.id`,yp):[[]];
    const ym={}; yr.forEach(r=>{ym[r.id]=r;});
    const rev=pr.filter(r=>r.type==='revenue'), cos=pr.filter(r=>r.type==='cost'), exp=pr.filter(r=>r.type==='expense');
    const amt=(r,t)=>{const y=ym[r.id]||{};return t==='d'?Number(r.d):t==='c'?Number(r.c):t==='yd'?Number(y.yd||0):Number(y.yc||0);};
    const BOM='\uFEFF';
    let csv=BOM+'利润表\n,,\n项目,本月数,本年累计数\n';
    csv+='一、营业收入\n';
    rev.forEach(r=>{csv+=`  ${r.name}(${r.code}),${(amt(r,'c')-amt(r,'d')).toFixed(2)},${(amt(r,'yc')-amt(r,'yd')).toFixed(2)}\n`;});
    const tr=rev.reduce((a,r)=>a+amt(r,'c')-amt(r,'d'),0);
    const yr2=rev.reduce((a,r)=>a+amt(r,'yc')-amt(r,'yd'),0);
    csv+=`营业收入合计,${tr.toFixed(2)},${yr2.toFixed(2)}\n\n二、营业成本\n`;
    cos.forEach(r=>{csv+=`  ${r.name}(${r.code}),${(amt(r,'d')-amt(r,'c')).toFixed(2)},${(amt(r,'yd')-amt(r,'yc')).toFixed(2)}\n`;});
    const tc2=cos.reduce((a,r)=>a+amt(r,'d')-amt(r,'c'),0);
    const ytc=cos.reduce((a,r)=>a+amt(r,'yd')-amt(r,'yc'),0);
    csv+=`营业成本合计,${tc2.toFixed(2)},${ytc.toFixed(2)}\n\n毛利,${(tr-tc2).toFixed(2)},${(yr2-ytc).toFixed(2)}\n\n三、期间费用\n`;
    exp.forEach(r=>{csv+=`  ${r.name}(${r.code}),${(amt(r,'d')-amt(r,'c')).toFixed(2)},${(amt(r,'yd')-amt(r,'yc')).toFixed(2)}\n`;});
    const te2=exp.reduce((a,r)=>a+amt(r,'d')-amt(r,'c'),0);
    const yte=exp.reduce((a,r)=>a+amt(r,'yd')-amt(r,'yc'),0);
    csv+=`期间费用合计,${te2.toFixed(2)},${yte.toFixed(2)}\n\n四、净利润,${(tr-tc2-te2).toFixed(2)},${(yr2-ytc-yte).toFixed(2)}\n`;
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="income_statement_'+new Date().toISOString().slice(0,10)+'.csv"');
    res.send(csv);
  } catch(err){ error(res,'导出失败: '+err.message); }
});

// 综合财务报表 HTML (可打印/保存PDF)
router.get('/statements/financial-report', async (req, res) => {
  try {
    const { year, month } = req.query;
    const title = year ? (month ? year+'年'+month+'月' : year+'年') : '全部期间';
    let df='', p=[];
    if(year&&month){
      const m=String(Number(month)).padStart(2,'0');
      const ld=String(new Date(Number(year),Number(month),0).getDate()).padStart(2,'0');
      df=' AND v.voucher_date>=? AND v.voucher_date<=?'; p=[year+'-'+m+'-01',year+'-'+m+'-'+ld];
    } else if(year){ df=' AND YEAR(v.voucher_date)=?'; p=[Number(year)]; }
    const q=` FROM acc_subjects s LEFT JOIN (SELECT e.subject_id,e.debit_amount,e.credit_amount
      FROM acc_voucher_entries e JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'${df}) pe ON s.id=pe.subject_id`;
    // all subjects
    const [rows]=await db.query(`SELECT s.code,s.name,s.type,s.direction,COALESCE(SUM(pe.debit_amount),0) AS d,COALESCE(SUM(pe.credit_amount),0) AS c
      ${q} WHERE s.is_active=1 GROUP BY s.id,s.code,s.name,s.type,s.direction ORDER BY s.code`,p);
    const bal=r=>r.direction==='debit'?Number(r.d)-Number(r.c):Number(r.c)-Number(r.d);
    const as=rows.filter(r=>r.type==='asset'); const li=rows.filter(r=>r.type==='liability');
    const eq=rows.filter(r=>r.type==='equity'); const rev=rows.filter(r=>r.type==='revenue');
    const cos=rows.filter(r=>r.type==='cost'); const exp=rows.filter(r=>r.type==='expense');
    const ta=as.reduce((a,r)=>a+bal(r),0); const tl=li.reduce((a,r)=>a+bal(r),0);
    const teq=eq.reduce((a,r)=>a+bal(r),0); const trv=rev.reduce((a,r)=>a+Number(r.c)-Number(r.d),0);
    const tcos=cos.reduce((a,r)=>a+Number(r.d)-Number(r.c),0); const texp=exp.reduce((a,r)=>a+Number(r.d)-Number(r.c),0);
    const np=trv-tcos-texp;
    const row=(cells)=>'<tr>'+cells.map(c=>`<td>${c||''}</td>`).join('')+'</tr>';
    const rowsHtml=(list,fmt)=>list.map(r=>row([r.code,r.name,fmt(r)])).join('');
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>财务报表-${title}</title>
<style>body{font-family:'Microsoft YaHei',sans-serif;max-width:900px;margin:0 auto;padding:20px;color:#333}
h1{text-align:center;font-size:20px;margin-bottom:5px}h3{text-align:center;color:#666;font-size:14px;margin-top:0}
h2{font-size:16px;border-bottom:2px solid #1a73e8;padding-bottom:5px;margin-top:30px}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
th{background:#1a73e8;color:#fff}tr:nth-child(even){background:#f8f9fa}
.total{font-weight:bold;background:#e8f0fe!important}
.balanced{color:green}.unbalanced{color:red}
.section{display:flex;gap:20px}.section>div{flex:1}
@media print{body{padding:0}@page{size:A4;margin:10mm}}</style></head><body>
<h1>家记账系统 - 财务报表</h1><h3>${title}</h3>
<h2>一、资产负债表</h2><div class="section"><div><h4>资产</h4><table><tr><th>编码</th><th>科目</th><th>期末余额</th></tr>
${rowsHtml(as,r=>bal(r).toFixed(2))}<tr class="total"><td></td><td>资产总计</td><td>${ta.toFixed(2)}</td></tr></table></div>
<div><h4>负债及所有者权益</h4><table><tr><th>编码</th><th>科目</th><th>期末余额</th></tr>
${rowsHtml(li,r=>bal(r).toFixed(2))}${rowsHtml(eq,r=>bal(r).toFixed(2))}
<tr><td></td><td>未分配利润</td><td>${np.toFixed(2)}</td></tr>
<tr class="total"><td></td><td>负债及权益合计</td><td>${(tl+teq+np).toFixed(2)}</td></tr></table></div></div>
<p>资产总计: ${ta.toFixed(2)} = 负债及权益: ${(tl+teq+np).toFixed(2)} ${Math.abs(ta-tl-teq-np)<0.01?'✅ 平衡':'❌ 差额: '+(ta-tl-teq-np).toFixed(2)}</p>
<h2>二、利润表</h2><table><tr><th>编码</th><th>科目</th><th>本期金额</th></tr>
<tr><td colspan="2"><b>营业收入</b></td><td></td></tr>${rowsHtml(rev,r=>(Number(r.c)-Number(r.d)).toFixed(2))}
<tr class="total"><td></td><td>营业收入合计</td><td>${trv.toFixed(2)}</td></tr>
<tr><td colspan="2"><b>营业成本</b></td><td></td></tr>${rowsHtml(cos,r=>(Number(r.d)-Number(r.c)).toFixed(2))}
<tr class="total"><td></td><td>营业成本合计</td><td>${tcos.toFixed(2)}</td></tr>
<tr class="total"><td></td><td>毛利</td><td>${(trv-tcos).toFixed(2)}</td></tr>
<tr><td colspan="2"><b>期间费用</b></td><td></td></tr>${rowsHtml(exp,r=>(Number(r.d)-Number(r.c)).toFixed(2))}
<tr class="total"><td></td><td>期间费用合计</td><td>${texp.toFixed(2)}</td></tr>
<tr class="total" style="background:#e8f5e9!important"><td></td><td>净利润</td><td>${np.toFixed(2)}</td></tr></table>
<h2>三、试算平衡表</h2><table><tr><th>编码</th><th>科目</th><th>类型</th><th>方向</th><th>借方发生额</th><th>贷方发生额</th></tr>
${rows.map(r=>{const tl={asset:'资产',liability:'负债',equity:'权益',cost:'成本',revenue:'收入',expense:'费用'};
return row([r.code,r.name,tl[r.type]||r.type,r.direction==='debit'?'借':'贷',Number(r.d).toFixed(2),Number(r.c).toFixed(2)]);}).join('')}
<tr class="total"><td></td><td></td><td></td><td>合计</td><td>${rows.reduce((a,r)=>a+Number(r.d),0).toFixed(2)}</td><td>${rows.reduce((a,r)=>a+Number(r.c),0).toFixed(2)}</td></tr></table>
<p style="text-align:center;color:#999;margin-top:30px">报告生成时间: ${new Date().toLocaleString('zh-CN')} | 家记账系统</p>
</body></html>`;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(html);
  } catch(err){ error(res,'生成失败: '+err.message); }
});

// === 多币种 ===

// 获取币种列表
router.get('/currencies', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM acc_currencies WHERE is_active=1 ORDER BY sort_order');
    success(res, rows);
  } catch(err){ error(res,'查询币种失败: '+err.message); }
});

// 获取单个币种
router.get('/currencies/:id', async (req, res) => {
  try {
    const [[r]] = await db.query('SELECT * FROM acc_currencies WHERE id=?', [req.params.id]);
    if(!r) return error(res,'币种不存在',404);
    success(res, r);
  } catch(err){ error(res,'查询失败: '+err.message); }
});

// 新增币种
router.post('/currencies', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { code, name, symbol, rate, decimal_places, sort_order } = req.body;
    if(!code||!name) return error(res,'币种代码和名称必填',400);
    const [result] = await db.query(
      'INSERT INTO acc_currencies (code, name, symbol, rate, decimal_places, sort_order) VALUES (?,?,?,?,?,?)',
      [code, name, symbol||'', rate||1, decimal_places||2, sort_order||0]
    );
    success(res, { id: result.insertId, code }, '币种添加成功');
  } catch(err){
    if(err.code==='ER_DUP_ENTRY') return error(res,'币种代码已存在',409);
    error(res,'添加失败: '+err.message);
  }
});

// 更新币种
router.put('/currencies/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { code, name, symbol, rate, decimal_places, sort_order, is_active } = req.body;
    await db.query(
      'UPDATE acc_currencies SET code=?,name=?,symbol=?,rate=?,decimal_places=?,sort_order=?,is_active=? WHERE id=?',
      [code, name, symbol||'', rate||1, decimal_places||2, sort_order||0, is_active!==undefined?is_active:1, req.params.id]
    );
    success(res, null, '币种更新成功');
  } catch(err){
    if(err.code==='ER_DUP_ENTRY') return error(res,'币种代码已存在',409);
    error(res,'更新失败: '+err.message);
  }
});

// 删除币种
router.delete('/currencies/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [vouchers] = await db.query('SELECT COUNT(*) as cnt FROM acc_vouchers WHERE currency_id=?', [req.params.id]);
    if(vouchers[0].cnt>0) return error(res,'该币种下有凭证，无法删除',400);
    await db.query('DELETE FROM acc_currencies WHERE id=?', [req.params.id]);
    success(res, null, '币种已删除');
  } catch(err){ error(res,'删除失败: '+err.message); }
});


// === 银行对账 ===

// CSV 解析辅助函数
function parseBankCSV(text) {
  const lines = text.split(/[\r\n]+/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV内容为空');
  // 探测分隔符
  const sep = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') ? ';' : ',');
  const header = lines[0].split(sep).map(h => h.trim().replace(/[\uFEFF\u201C\u201D""]/g, ''));
  console.log('CSV header:', header, 'sep:', sep === '\t' ? 'TAB' : sep);
  
  // 映射列索引
  const idx = {
    date: header.findIndex(h => h.includes('日期') || h.toLowerCase().includes('date')),
    desc: header.findIndex(h => h.includes('摘要') || h.includes('说明') || h.toLowerCase().includes('desc')),
    debit: header.findIndex(h => h.includes('支出') || h.includes('借方') || h.toLowerCase().includes('debit')),
    credit: header.findIndex(h => h.includes('收入') || h.includes('贷方') || h.toLowerCase().includes('credit')),
    balance: header.findIndex(h => h.includes('余额') || h.toLowerCase().includes('balance'))
  };
  if (idx.date < 0) throw new Error('CSV缺少日期列，请确保包含"日期"列');
  
  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep).map(c => c.trim().replace(/["\u201C\u201D]/g, ''));
    if (!cols[idx.date]) continue;
    items.push({
      transaction_date: cols[idx.date],
      description: idx.desc >= 0 ? cols[idx.desc] : '',
      debit_amount: idx.debit >= 0 ? (parseFloat(cols[idx.debit]) || 0) : 0,
      credit_amount: idx.credit >= 0 ? (parseFloat(cols[idx.credit]) || 0) : 0,
      balance: idx.balance >= 0 ? (parseFloat(cols[idx.balance]) || 0) : 0
    });
  }
  return items;
}

// 获取银行对账单列表
router.get('/bank-statements', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT s.*, a.name as account_name FROM acc_bank_statements s 
       LEFT JOIN acc_accounts a ON s.account_id = a.id 
       ORDER BY s.created_at DESC`
    );
    success(res, rows);
  } catch(err) { error(res, '查询对账单失败: ' + err.message); }
});

// 获取单个对账单详情（含明细）
router.get('/bank-statements/:id', async (req, res) => {
  try {
    const [[st]] = await db.query(
      `SELECT s.*, a.name as account_name FROM acc_bank_statements s 
       LEFT JOIN acc_accounts a ON s.account_id = a.id WHERE s.id=?`, [req.params.id]
    );
    if (!st) return error(res, '对账单不存在', 404);
    const [items] = await db.query(
      `SELECT i.*, v.voucher_no 
       FROM acc_bank_statement_items i 
       LEFT JOIN acc_vouchers v ON i.voucher_id = v.id 
       WHERE i.statement_id=? ORDER BY i.line_no`, [req.params.id]
    );
    // 统计
    const totalDr = items.reduce((a,i) => a + Number(i.debit_amount||0), 0);
    const totalCr = items.reduce((a,i) => a + Number(i.credit_amount||0), 0);
    const matched = items.filter(i => i.match_status === 'matched').length;
    success(res, { 
      statement: st, 
      items, 
      summary: { total_debit: totalDr, total_credit: totalCr, matched, unmatched: items.length - matched, total: items.length }
    });
  } catch(err) { error(res, '查询失败: ' + err.message); }
});

// 上传银行对账单（CSV内容通过JSON body传入）
router.post('/bank-statements/upload', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const { account_id, statement_date, file_name, csv_content, opening_balance, closing_balance, note } = req.body;
    if (!account_id || !statement_date || !csv_content) return error(res, '缺少必要参数(account_id, statement_date, csv_content)', 400);
    
    const items = parseBankCSV(csv_content);
    if (!items.length) return error(res, 'CSV解析后无数据', 400);
    
    // 计算期初期末余额（如果未提供）
    const firstBal = items[0].balance;
    const lastBal = items[items.length - 1].balance;
    
    const [result] = await db.query(
      `INSERT INTO acc_bank_statements (account_id, statement_date, opening_balance, closing_balance, file_name, record_count, note)
       VALUES (?,?,?,?,?,?,?)`,
      [account_id, statement_date, opening_balance || firstBal, closing_balance || lastBal, file_name || '', items.length, note || '']
    );
    const stmtId = result.insertId;
    
    // 批量插入明细
    const values = items.map((it, i) => [
      stmtId, i + 1, it.transaction_date, it.description,
      it.debit_amount, it.credit_amount, it.balance, 'unmatched'
    ]);
    // 单条插入兜底
    for (const v of values) {
      await db.query(
        `INSERT INTO acc_bank_statement_items (statement_id, line_no, transaction_date, description, debit_amount, credit_amount, balance, match_status)
         VALUES (?,?,?,?,?,?,?,?)`, v
      );
    }
    
    success(res, { id: stmtId, record_count: items.length }, '导入成功');
  } catch(err) { error(res, '导入失败: ' + err.message); }
});

// 删除对账单
router.delete('/bank-statements/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM acc_bank_statements WHERE id=?', [req.params.id]);
    success(res, null, '已删除');
  } catch(err) { error(res, '删除失败: ' + err.message); }
});

// 获取未匹配项目（用于对账界面）
router.get('/bank-statements/:id/unmatched', async (req, res) => {
  try {
    const [items] = await db.query(
      `SELECT * FROM acc_bank_statement_items WHERE statement_id=? AND match_status='unmatched' ORDER BY line_no`,
      [req.params.id]
    );
    success(res, items);
  } catch(err) { error(res, '查询失败: ' + err.message); }
});

// 自动对账：匹配日期+金额相符的凭证分录
router.post('/bank-statements/:id/auto-reconcile', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    // 获取未匹配的明细
    const [items] = await db.query(
      `SELECT * FROM acc_bank_statement_items WHERE statement_id=? AND match_status='unmatched'`,
      [req.params.id]
    );
    
    let matched_count = 0;
    for (const item of items) {
      const amount = Number(item.debit_amount || 0) + Number(item.credit_amount || 0);
      if (amount <= 0) continue;
      
      // 查找匹配的凭证分录：同日期、同金额
      const [entries] = await db.query(
        `SELECT e.*, v.voucher_no, v.voucher_date 
         FROM acc_voucher_entries e 
         JOIN acc_vouchers v ON e.voucher_id = v.id 
         WHERE v.voucher_date = ? AND (e.debit_amount = ? OR e.credit_amount = ?)
         LIMIT 1`,
        [item.transaction_date, amount, amount]
      );
      
      if (entries.length === 1) {
        const entry = entries[0];
        // 更新明细状态
        await db.query(
          `UPDATE acc_bank_statement_items SET match_status='matched', voucher_id=? WHERE id=?`,
          [entry.voucher_id, item.id]
        );
        // 创建对账记录
        await db.query(
          `INSERT INTO acc_bank_reconciliations (statement_item_id, voucher_id, entry_id, match_type, matched_amount)
           VALUES (?,?,?,'auto',?)`,
          [item.id, entry.voucher_id, entry.id, amount]
        );
        matched_count++;
      }
    }
    
    // 更新批次状态
    const [summary] = await db.query(
      `SELECT COUNT(*) as total, SUM(CASE WHEN match_status='matched' THEN 1 ELSE 0 END) as matched 
       FROM acc_bank_statement_items WHERE statement_id=?`, [req.params.id]
    );
    let status = 'pending';
    if (summary[0].matched === summary[0].total) status = 'reconciled';
    else if (summary[0].matched > 0) status = 'partial';
    await db.query('UPDATE acc_bank_statements SET status=? WHERE id=?', [status, req.params.id]);
    
    success(res, { matched: matched_count, total: items.length, status }, `自动对账完成：${matched_count}/${items.length}`);
  } catch(err) { error(res, '对账失败: ' + err.message); }
});

// 手工对账单条
router.post('/bank-statements/items/:id/reconcile', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const { voucher_id, entry_id } = req.body;
    if (!voucher_id) return error(res, '请选择匹配的凭证', 400);
    
    // 获取明细金额
    const [[item]] = await db.query('SELECT * FROM acc_bank_statement_items WHERE id=?', [req.params.id]);
    if (!item) return error(res, '明细不存在', 404);
    if (item.match_status === 'matched') return error(res, '该明细已对账', 400);
    
    const amount = Number(item.debit_amount || 0) + Number(item.credit_amount || 0);
    
    // 更新明细
    await db.query(
      `UPDATE acc_bank_statement_items SET match_status='matched', voucher_id=? WHERE id=?`,
      [voucher_id, req.params.id]
    );
    // 记录对账
    await db.query(
      `INSERT INTO acc_bank_reconciliations (statement_item_id, voucher_id, entry_id, match_type, matched_amount, matched_by)
       VALUES (?,?,?,'manual',?,?)`,
      [req.params.id, voucher_id, entry_id || null, amount, req.body.matched_by || 'admin']
    );
    
    // 更新批次状态
    const [[st]] = await db.query('SELECT statement_id FROM acc_bank_statement_items WHERE id=?', [req.params.id]);
    const [summary] = await db.query(
      `SELECT COUNT(*) as total, SUM(CASE WHEN match_status='matched' THEN 1 ELSE 0 END) as matched 
       FROM acc_bank_statement_items WHERE statement_id=?`, [st.statement_id]
    );
    let status = 'pending';
    if (summary[0].matched === summary[0].total) status = 'reconciled';
    else if (summary[0].matched > 0) status = 'partial';
    await db.query('UPDATE acc_bank_statements SET status=? WHERE id=?', [status, st.statement_id]);
    
    success(res, null, '对账成功');
  } catch(err) { error(res, '对账失败: ' + err.message); }
});

// 取消对账
router.delete('/reconciliations/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[rec]] = await db.query('SELECT * FROM acc_bank_reconciliations WHERE id=?', [req.params.id]);
    if (!rec) return error(res, '记录不存在', 404);
    
    // 恢复明细状态
    const [itemResult] = await db.query(
      `UPDATE acc_bank_statement_items SET match_status='unmatched', voucher_id=NULL WHERE id=?`,
      [rec.statement_item_id]
    );
    // 删除对账记录
    await db.query('DELETE FROM acc_bank_reconciliations WHERE id=?', [req.params.id]);
    
    // 更新批次状态
    const [[item]] = await db.query('SELECT statement_id FROM acc_bank_statement_items WHERE id=?', [rec.statement_item_id]);
    if (item) {
      const [summary] = await db.query(
        `SELECT COUNT(*) as total, SUM(CASE WHEN match_status='matched' THEN 1 ELSE 0 END) as matched 
         FROM acc_bank_statement_items WHERE statement_id=?`, [item.statement_id]
      );
      let status = 'pending';
      if (summary[0].matched === summary[0].total && summary[0].total > 0) status = 'reconciled';
      else if (summary[0].matched > 0) status = 'partial';
      await db.query('UPDATE acc_bank_statements SET status=? WHERE id=?', [status, item.statement_id]);
    }
    
    success(res, null, '已取消对账');
  } catch(err) { error(res, '取消失败: ' + err.message); }
});

// 搜索可匹配的凭证（用于手工对账选择）
router.get('/match-candidates', async (req, res) => {
  try {
    const { date, amount, account_id } = req.query;
    let sql = `SELECT v.id, v.voucher_no, v.voucher_date, v.description, 
               e.id as entry_id, e.summary, e.debit_amount, e.credit_amount
               FROM acc_vouchers v 
               JOIN acc_voucher_entries e ON v.id = e.voucher_id 
               WHERE 1=1`;
    const params = [];
    if (date) { sql += ' AND v.voucher_date = ?'; params.push(date); }
    if (amount) { 
      sql += ' AND (e.debit_amount = ? OR e.credit_amount = ?)'; 
      params.push(Number(amount), Number(amount)); 
    }
    sql += ' ORDER BY v.voucher_date DESC, v.id DESC LIMIT 20';
    const [rows] = await db.query(sql, params);
    success(res, rows);
  } catch(err) { error(res, '查询失败: ' + err.message); }
});

// 取消单条对账
router.post('/bank-statements/:id/unmatch', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return error(res, '缺少明细ID', 400);
    // 删除对账记录
    await db.query('DELETE FROM acc_bank_reconciliations WHERE statement_item_id=?', [item_id]);
    // 恢复明细状态
    await db.query("UPDATE acc_bank_statement_items SET match_status='unmatched', voucher_id=NULL WHERE id=?", [item_id]);
    // 更新批次状态
    const [[item]] = await db.query('SELECT statement_id FROM acc_bank_statement_items WHERE id=?', [item_id]);
    if (item) {
      const [summary] = await db.query(
        'SELECT COUNT(*) as total, SUM(CASE WHEN match_status=\'matched\' THEN 1 ELSE 0 END) as matched FROM acc_bank_statement_items WHERE statement_id=?',
        [item.statement_id]
      );
      let status = 'pending';
      if (summary[0].matched === summary[0].total && summary[0].total > 0) status = 'reconciled';
      else if (summary[0].matched > 0) status = 'partial';
      await db.query('UPDATE acc_bank_statements SET status=? WHERE id=?', [status, item.statement_id]);
    }
    success(res, null, '已取消对账');
  } catch(err) { error(res, '取消失败: ' + err.message); }
});

// 取消单条对账
router.post('/bank-statements/:id/unmatch', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) return error(res, '缺少明细ID', 400);
    await db.query('DELETE FROM acc_bank_reconciliations WHERE statement_item_id=?', [item_id]);
    await db.query("UPDATE acc_bank_statement_items SET match_status='unmatched', voucher_id=NULL WHERE id=?", [item_id]);
    const [[item]] = await db.query('SELECT statement_id FROM acc_bank_statement_items WHERE id=?', [item_id]);
    if (item) {
      const [summary] = await db.query(
        "SELECT COUNT(*) as total, SUM(CASE WHEN match_status='matched' THEN 1 ELSE 0 END) as matched FROM acc_bank_statement_items WHERE statement_id=?",
        [item.statement_id]
      );
      let status = 'pending';
      if (summary[0].matched === summary[0].total && summary[0].total > 0) status = 'reconciled';
      else if (summary[0].matched > 0) status = 'partial';
      await db.query('UPDATE acc_bank_statements SET status=? WHERE id=?', [status, item.statement_id]);
    }
    success(res, null, '已取消对账');
  } catch(err) { error(res, '取消失败: ' + err.message); }
});


// ==================== 现金流量表 ====================

// 获取现金流量表项目列表
router.get('/statements/cash-flow-items', async (req, res) => {
  try {
    const [items] = await db.query(
      'SELECT * FROM acc_cash_flow_items WHERE is_active=1 ORDER BY sort_order'
    );
    success(res, items);
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 现金流量表（直接法）
router.get('/statements/cash-flow', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const endDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2,'0')}-${String(endDay).padStart(2,'0')}`;

    // 获取所有现金流量表项目
    const [cfItems] = await db.query(
      'SELECT * FROM acc_cash_flow_items WHERE is_active=1 ORDER BY sort_order'
    );

    // 获取现金类科目ID
    const [cashSubjects] = await db.query(
      `SELECT id, code, name FROM acc_subjects WHERE code LIKE '1001%' OR code LIKE '1002%'`
    );
    const cashIds = cashSubjects.map(s => s.id);
    if (!cashIds.length) {
      // 无现金科目
      const result = cfItems.map(it => ({ ...it, amount: it.is_subtotal ? 0 : null }));
      return success(res, { period: `${year}-${String(month).padStart(2,'0')}`, items: result, cashSubjects });
    }

    // 获取科目映射
    const [mappings] = await db.query(
      `SELECT m.*, i.direction as cf_direction
       FROM acc_cash_flow_mappings m
       JOIN acc_cash_flow_items i ON m.cf_item_id = i.id
       WHERE i.is_active = 1`
    );

    // 获取期间内所有已过账凭证（含现金科目的）
    const placeholders = cashIds.map(() => '?').join(',');
    const [cashEntries] = await db.query(`
      SELECT e.id, e.voucher_id, e.subject_id, e.debit_amount, e.credit_amount,
             s.code as subject_code, s.name as subject_name
      FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
      JOIN acc_subjects s ON e.subject_id = s.id
      WHERE v.voucher_date BETWEEN ? AND ?
        AND e.subject_id IN (${placeholders})
    `, [startDate, endDate, ...cashIds]);

    // 按CF项目汇总金额
    const cfAmounts = {};
    cfItems.forEach(it => { cfAmounts[it.id] = 0; });

    // 对每一笔现金分录，找同一凭证中的对方科目
    const voucherIds = [...new Set(cashEntries.map(e => e.voucher_id))];

    for (const vid of voucherIds) {
      // 获取该凭证所有分录
      const [allEntries] = await db.query(`
        SELECT e.id, e.voucher_id, e.subject_id, e.debit_amount, e.credit_amount,
               s.code as subj_code, s.name as subj_name
        FROM acc_voucher_entries e
        JOIN acc_subjects s ON e.subject_id = s.id
        WHERE e.voucher_id = ?
      `, [vid]);

      // 找出该凭证中的现金分录
      const vCashEntries = allEntries.filter(
        e => cashIds.includes(e.subject_id)
      );

      for (const ce of vCashEntries) {
        const debit = Number(ce.debit_amount) || 0;
        const credit = Number(ce.credit_amount) || 0;
        const amount = debit - credit; // 正=流入，负=流出
        if (Math.abs(amount) < 0.01) continue;

        // 找出对方分录（非现金、非当前分录）
        const counterparties = allEntries.filter(
          e => !cashIds.includes(e.subject_id)
        );

        if (!counterparties.length) continue;

        // 如果是现金流入(debit>0)，对方是贷方科目 → 按贷方科目分类
        // 如果是现金流出(credit>0)，对方是借方科目 → 按借方科目分类
        const absAmount = Math.abs(amount);

        // 按对方科目金额比例分摊到各CF项目
        for (const cp of counterparties) {
          const cpAmt = debit > 0
            ? (Number(cp.credit_amount) || 0)
            : (Number(cp.debit_amount) || 0);
          if (cpAmt <= 0) continue;

          // 匹配CF项目
          let matchedItemId = null;
          for (const m of mappings) {
            const pattern = m.subject_code_pattern;
            if (m.match_type === 'exact') {
              if (cp.subj_code === pattern) { matchedItemId = m.cf_item_id; break; }
            } else {
              if (cp.subj_code.startsWith(pattern)) { matchedItemId = m.cf_item_id; break; }
            }
          }

          // 未匹配则归入"其他"
          if (!matchedItemId) {
            // 找对应方向的"其他"项
            if (debit > 0) matchedItemId = 3; // 其他经营活动流入
            else matchedItemId = 8; // 其他经营活动流出
          }

          // 按比例分配金额
          const totalCounterparty = debit > 0
            ? counterparties.reduce((s, c) => s + (Number(c.credit_amount)||0), 0)
            : counterparties.reduce((s, c) => s + (Number(c.debit_amount)||0), 0);

          const ratio = totalCounterparty > 0 ? cpAmt / totalCounterparty : 1;
          cfAmounts[matchedItemId] = (cfAmounts[matchedItemId] || 0) + absAmount * ratio;
        }
      }
    }

    // 计算小计和净额
    // CFO流入小计 = CFO-01 + CFO-02 + CFO-03
    cfAmounts[4] = (cfAmounts[1]||0) + (cfAmounts[2]||0) + (cfAmounts[3]||0);
    // CFO流出小计 = CFO-04 + CFO-05 + CFO-06 + CFO-07
    cfAmounts[9] = (cfAmounts[5]||0) + (cfAmounts[6]||0) + (cfAmounts[7]||0) + (cfAmounts[8]||0);
    // CFO净额 = 流入小计 - 流出小计
    cfAmounts[10] = cfAmounts[4] - cfAmounts[9];
    // CFI流入小计
    cfAmounts[14] = (cfAmounts[11]||0) + (cfAmounts[12]||0) + (cfAmounts[13]||0);
    // CFI流出小计
    cfAmounts[17] = (cfAmounts[15]||0) + (cfAmounts[16]||0);
    // CFI净额
    cfAmounts[18] = cfAmounts[14] - cfAmounts[17];
    // CFF流入小计
    cfAmounts[21] = (cfAmounts[19]||0) + (cfAmounts[20]||0);
    // CFF流出小计
    cfAmounts[24] = (cfAmounts[22]||0) + (cfAmounts[23]||0);
    // CFF净额
    cfAmounts[25] = cfAmounts[21] - cfAmounts[24];
    // 汇率影响
    cfAmounts[26] = cfAmounts[26] || 0;
    // 净增加额
    cfAmounts[27] = cfAmounts[10] + cfAmounts[18] + cfAmounts[25] + cfAmounts[26];

    // 期初现金余额计算
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevStartDate = `${prevYear}-${String(prevMonth).padStart(2,'0')}-01`;
    const prevEndDay = new Date(prevYear, prevMonth, 0).getDate();
    const prevEndDate = `${prevYear}-${String(prevMonth).padStart(2,'0')}-${String(prevEndDay).padStart(2,'0')}`;

    // 计算期初 = 上期末 = 所有现金科目在期初的余额
    // 简化：从 subject balance 取
    let openingBalance = 0;
    for (const cs of cashSubjects) {
      const [ob] = await db.query(`
        SELECT COALESCE(SUM(CASE WHEN s.direction='debit'
          THEN COALESCE(e.debit_amount,0)-COALESCE(e.credit_amount,0)
          ELSE COALESCE(e.credit_amount,0)-COALESCE(e.debit_amount,0) END), 0) as balance
        FROM acc_voucher_entries e
        JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
        JOIN acc_subjects s ON e.subject_id = s.id
        WHERE e.subject_id = ? AND v.voucher_date < ?
      `, [cs.id, startDate]);
      openingBalance += Number(ob[0]?.balance || 0);
    }
    cfAmounts[28] = openingBalance;
    cfAmounts[29] = openingBalance + cfAmounts[27];

    // 组装结果
    const result = cfItems.map(it => ({
      ...it,
      amount: Number((cfAmounts[it.id] || 0).toFixed(2)),
      is_subtotal: !!it.is_subtotal
    }));

    success(res, {
      period: `${year}-${String(month).padStart(2,'0')}`,
      items: result,
      cashSubjects: cashSubjects.map(s => ({ id: s.id, code: s.code, name: s.name }))
    });
  } catch (err) { error(res, '现金流量表计算失败: ' + err.message); }
});

// 现金流量表导出
router.get('/statements/cash-flow/export', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const endDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2,'0')}-${String(endDay).padStart(2,'0')}`;

    const [cfItems] = await db.query('SELECT * FROM acc_cash_flow_items WHERE is_active=1 ORDER BY sort_order');
    const [cashSubjects] = await db.query("SELECT id, code, name FROM acc_subjects WHERE code LIKE '1001%' OR code LIKE '1002%'");
    const cashIds = cashSubjects.map(s => s.id);
    const [mappings] = await db.query(
      "SELECT m.*, i.direction as cf_direction FROM acc_cash_flow_mappings m JOIN acc_cash_flow_items i ON m.cf_item_id = i.id WHERE i.is_active = 1");

    const cfAmounts = {}; cfItems.forEach(it => { cfAmounts[it.id] = 0; });

    if (cashIds.length) {
      const ph = cashIds.map(() => '?').join(',');
      const [cashEntries] = await db.query(
        "SELECT e.id, e.voucher_id, e.subject_id, e.debit_amount, e.credit_amount FROM acc_voucher_entries e JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted' WHERE v.voucher_date BETWEEN ? AND ? AND e.subject_id IN (" + ph + ")",
        [startDate, endDate, ...cashIds]);

      const vids = [...new Set(cashEntries.map(e => e.voucher_id))];
      for (const vid of vids) {
        const [allEntries] = await db.query(
          "SELECT e.id, e.subject_id, e.debit_amount, e.credit_amount, s.code as sc FROM acc_voucher_entries e JOIN acc_subjects s ON e.subject_id = s.id WHERE e.voucher_id = ?",
          [vid]);
        const vce = allEntries.filter(e => cashIds.includes(e.subject_id));
        for (const ce of vce) {
          const d = Number(ce.debit_amount)||0, c = Number(ce.credit_amount)||0;
          const amt = d - c; if (Math.abs(amt) < 0.01) continue;
          const cp = allEntries.filter(e => !cashIds.includes(e.subject_id));
          if (!cp.length) continue;
          const absAmt = Math.abs(amt);
          for (const p of cp) {
            const pa = d > 0 ? (Number(p.credit_amount)||0) : (Number(p.debit_amount)||0);
            if (pa <= 0) continue;
            let mid = null;
            for (const m of mappings) {
              if (m.match_type==='exact' ? p.sc===m.subject_code_pattern : p.sc.startsWith(m.subject_code_pattern))
                { mid = m.cf_item_id; break; }
            }
            if (!mid) mid = d > 0 ? 3 : 8;
            const total = d > 0
              ? cp.reduce((s,x)=>s+(Number(x.credit_amount)||0),0)
              : cp.reduce((s,x)=>s+(Number(x.debit_amount)||0),0);
            cfAmounts[mid] = (cfAmounts[mid]||0) + absAmt * (total>0?pa/total:1);
          }
        }
      }
    }

    cfAmounts[4]=(cfAmounts[1]||0)+(cfAmounts[2]||0)+(cfAmounts[3]||0);
    cfAmounts[9]=(cfAmounts[5]||0)+(cfAmounts[6]||0)+(cfAmounts[7]||0)+(cfAmounts[8]||0);
    cfAmounts[10]=cfAmounts[4]-cfAmounts[9];
    cfAmounts[14]=(cfAmounts[11]||0)+(cfAmounts[12]||0)+(cfAmounts[13]||0);
    cfAmounts[17]=(cfAmounts[15]||0)+(cfAmounts[16]||0);
    cfAmounts[18]=cfAmounts[14]-cfAmounts[17];
    cfAmounts[21]=(cfAmounts[19]||0)+(cfAmounts[20]||0);
    cfAmounts[24]=(cfAmounts[22]||0)+(cfAmounts[23]||0);
    cfAmounts[25]=cfAmounts[21]-cfAmounts[24];
    cfAmounts[26]=cfAmounts[26]||0;
    cfAmounts[27]=cfAmounts[10]+cfAmounts[18]+cfAmounts[25]+cfAmounts[26];

    let opBal=0;
    for (const cs of cashSubjects) {
      const [ob] = await db.query(
        "SELECT COALESCE(SUM(CASE WHEN s.direction='debit' THEN COALESCE(e.debit_amount,0)-COALESCE(e.credit_amount,0) ELSE COALESCE(e.credit_amount,0)-COALESCE(e.debit_amount,0) END),0) as b FROM acc_voucher_entries e JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted' JOIN acc_subjects s ON e.subject_id=s.id WHERE e.subject_id=? AND v.voucher_date < ?",
        [cs.id, startDate]);
      opBal += Number(ob[0]?.b||0);
    }
    cfAmounts[28]=opBal; cfAmounts[29]=opBal+cfAmounts[27];

    let csv = '\uFEFF\u9879\u76ee,\u884c\u6b21,\u91d1\u989d\n'; let ln=0;
    for (const item of cfItems) {
      ln++;
      csv += item.item_name + ',' + ln + ',' + Number(cfAmounts[item.id]||0).toFixed(2) + '\n';
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + year + String(month).padStart(2,'0') + '_cash_flow.csv"');
    res.send(csv);
  } catch (err) { error(res, '\u5bfc\u51fa\u5931\u8d25: ' + err.message); }
});
router.get('/period-close/status', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || (new Date().getMonth() + 1);

    // 检查是否已结转
    const [existing] = await db.query(
      'SELECT * FROM acc_period_closes WHERE period_year=? AND period_month=?',
      [year, month]
    );

    // 计算当月损益
    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const endDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2,'0')}-${String(endDay).padStart(2,'0')}`;

    const [revenue] = await db.query(`
      SELECT COALESCE(SUM(e.credit_amount),0) as total
      FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
      JOIN acc_subjects s ON e.subject_id=s.id
      WHERE v.voucher_date BETWEEN ? AND ? AND s.type='revenue'
    `, [startDate, endDate]);

    const [expense] = await db.query(`
      SELECT COALESCE(SUM(e.debit_amount),0) as total
      FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
      JOIN acc_subjects s ON e.subject_id=s.id
      WHERE v.voucher_date BETWEEN ? AND ? AND s.type IN ('cost','expense')
    `, [startDate, endDate]);

    success(res, {
      period: `${year}-${String(month).padStart(2,'0')}`,
      closed: !!existing.length,
      closed_at: existing.length ? existing[0].closed_at : null,
      revenue_total: Number(revenue[0].total || 0),
      expense_total: Number(expense[0].total || 0),
      net_profit: Number((revenue[0].total || 0) - (expense[0].total || 0))
    });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 执行期末结转
router.post('/period-close', requireRole('super_admin','admin'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const year = Number(req.body.year) || new Date().getFullYear();
    const month = Number(req.body.month) || (new Date().getMonth() + 1);

    // 检查是否已结转
    const [existing] = await conn.query(
      'SELECT * FROM acc_period_closes WHERE period_year=? AND period_month=?',
      [year, month]
    );
    if (existing.length) {
      return error(res, `已结转：凭证号 ${existing[0].voucher_id}`, 400);
    }

    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const endDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2,'0')}-${String(endDay).padStart(2,'0')}`;

    // 获取收入类科目当月发生额
    const [revenueSubjects] = await conn.query(`
      SELECT s.id, s.code, s.name,
             COALESCE(SUM(e.credit_amount),0) as credit_total,
             COALESCE(SUM(e.debit_amount),0) as debit_total
      FROM acc_subjects s
      LEFT JOIN acc_voucher_entries e ON s.id=e.subject_id
      LEFT JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted' AND v.voucher_date BETWEEN ? AND ?
      WHERE s.type='revenue' AND s.is_active=1
      GROUP BY s.id, s.code, s.name
      HAVING credit_total > 0 OR debit_total > 0
    `, [startDate, endDate]);

    // 获取成本/费用类科目当月发生额
    const [expenseSubjects] = await conn.query(`
      SELECT s.id, s.code, s.name,
             COALESCE(SUM(e.debit_amount),0) as debit_total,
             COALESCE(SUM(e.credit_amount),0) as credit_total
      FROM acc_subjects s
      LEFT JOIN acc_voucher_entries e ON s.id=e.subject_id
      LEFT JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted' AND v.voucher_date BETWEEN ? AND ?
      WHERE s.type IN ('cost','expense') AND s.is_active=1
      GROUP BY s.id, s.code, s.name
      HAVING debit_total > 0 OR credit_total > 0
    `, [startDate, endDate]);

    const netRevenue = revenueSubjects.reduce((s, r) => s + (Number(r.credit_total)-Number(r.debit_total)), 0);
    const netExpense = expenseSubjects.reduce((s, r) => s + (Number(r.debit_total)-Number(r.credit_total)), 0);

    if (Math.abs(netRevenue) < 0.01 && Math.abs(netExpense) < 0.01) {
      return error(res, '当月无损益数据，无需结转', 400);
    }

    // 找本年利润科目
    const [[profitAcct]] = await conn.query(
      `SELECT id, code, name FROM acc_subjects WHERE code='4103' AND is_active=1`
    );
    if (!profitAcct) {
      return error(res, '科目"本年利润"(4103)不存在', 500);
    }

    // 生成结转凭证号
    const genVoucherNo = async (vtype, date) => {
      const d = new Date(date);
      const prefix = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const [rows] = await db.query(
        `SELECT voucher_no FROM acc_vouchers WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${vtype}-${prefix}-%`]
      );
      let seq = 1;
      if (rows.length) {
        const last = rows[0].voucher_no.split('-');
        seq = parseInt(last[last.length-1]) + 1;
      }
      return `${vtype}-${prefix}-${String(seq).padStart(3,'0')}`;
    };

    const voucherNo = await genVoucherNo('转', endDate);
    const entries = [];

    // 结转收入至本年利润
    for (const s of revenueSubjects) {
      const amt = Number(s.credit_total) - Number(s.debit_total);
      if (Math.abs(amt) < 0.01) continue;
      entries.push({
        subject_id: s.id,
        summary: `结转${s.name}至本年利润`,
        debit_amount: amt,
        credit_amount: 0
      });
      entries.push({
        subject_id: profitAcct.id,
        summary: `结转${s.name}至本年利润`,
        debit_amount: 0,
        credit_amount: amt
      });
    }

    // 结转费用至本年利润
    for (const s of expenseSubjects) {
      const amt = Number(s.debit_total) - Number(s.credit_total);
      if (Math.abs(amt) < 0.01) continue;
      entries.push({
        subject_id: profitAcct.id,
        summary: `结转${s.name}至本年利润`,
        debit_amount: amt,
        credit_amount: 0
      });
      entries.push({
        subject_id: s.id,
        summary: `结转${s.name}至本年利润`,
        debit_amount: 0,
        credit_amount: amt
      });
    }

    // 生成借贷总额
    const totalDebit = entries.reduce((s, e) => s + e.debit_amount, 0);
    const totalCredit = entries.reduce((s, e) => s + e.credit_amount, 0);

    await conn.beginTransaction();

    const description = `${year}年${month}月期末结转损益`;

    const [result] = await conn.query(
      `INSERT INTO acc_vouchers (voucher_no, voucher_type, currency_id, voucher_date, description, total_debit, total_credit, attachments, created_by, status)
       VALUES (?, '转', 1, ?, ?, ?, ?, 0, ?, 'posted')`,
      [voucherNo, endDate, description, totalDebit, totalCredit, req.user?.username || 'admin']
    );
    const vId = result.insertId;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      await conn.query(
        `INSERT INTO acc_voucher_entries (voucher_id, line_no, subject_id, summary, debit_amount, credit_amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [vId, i + 1, e.subject_id, e.summary, e.debit_amount, e.credit_amount]
      );
    }

    // 记录结转
    await conn.query(
      `INSERT INTO acc_period_closes (period_year, period_month, voucher_id, revenue_total, expense_total, net_profit, closed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [year, month, vId, netRevenue, netExpense, netRevenue - netExpense, req.user?.username || 'admin']
    );

    await conn.commit();
    success(res, {
      voucher_id: vId,
      voucher_no: voucherNo,
      revenue_total: Number(netRevenue.toFixed(2)),
      expense_total: Number(netExpense.toFixed(2)),
      net_profit: Number((netRevenue - netExpense).toFixed(2)),
      entries_count: entries.length
    }, '期末结转完成');
  } catch (err) {
    await conn.rollback();
    error(res, '期末结转失败: ' + err.message);
  } finally { conn.release(); }
});

// 反结转
router.post('/period-close/reverse', requireRole('super_admin','admin'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const year = Number(req.body.year) || new Date().getFullYear();
    const month = Number(req.body.month) || (new Date().getMonth() + 1);

    const [existing] = await conn.query(
      'SELECT * FROM acc_period_closes WHERE period_year=? AND period_month=?',
      [year, month]
    );
    if (!existing.length) return error(res, '该期间未结转', 400);

    await conn.beginTransaction();

    // 删除结转凭证
    await conn.query('DELETE FROM acc_voucher_entries WHERE voucher_id=?', [existing[0].voucher_id]);
    await conn.query('DELETE FROM acc_vouchers WHERE id=?', [existing[0].voucher_id]);
    await conn.query('DELETE FROM acc_period_closes WHERE id=?', [existing[0].id]);

    await conn.commit();
    success(res, null, '已取消结转');
  } catch (err) {
    await conn.rollback();
    error(res, '取消失败: ' + err.message);
  } finally { conn.release(); }
});


// ==================== 审计日志工具函数 ====================
async function auditLog(user, action, entityType, entityId, ref, changes) {
  try {
    await db.query(
      `INSERT INTO acc_audit_logs (user_name, action, entity_type, entity_id, entity_ref, changes, ip_address)
       VALUES (?,?,?,?,?,?,?)`,
      [user || 'system', action, entityType, String(entityId||''), ref||null,
       changes ? JSON.stringify(changes) : null, null]
    );
  } catch (e) { console.error('auditLog error:', e.message); }
}

// ==================== 固定资产管理 ====================

// 固定资产列表
router.get('/fixed-assets', async (req, res) => {
  try {
    const { status, search, page=1, pageSize=50 } = req.query;
    let where = ['1=1'], params = [];
    if (status) { where.push('fa.status=?'); params.push(status); }
    if (search) { where.push('(fa.asset_code LIKE ? OR fa.asset_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const offset = (Number(page)-1) * Number(pageSize);
    const [rows] = await db.query(
      `SELECT fa.*, s.code as subject_code, s.name as subject_name,
              ds.code as dep_subject_code, ds.name as dep_subject_name
       FROM acc_fixed_assets fa
       LEFT JOIN acc_subjects s ON fa.subject_id = s.id
       LEFT JOIN acc_subjects ds ON fa.dep_subject_id = ds.id
       WHERE ${where.join(' AND ')} ORDER BY fa.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), offset]
    );
    const [[{total}]] = await db.query(
      `SELECT COUNT(*) as total FROM acc_fixed_assets fa WHERE ${where.join(' AND ')}`, params);
    success(res, { list: rows, total, page: Number(page), pageSize: Number(pageSize) });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 固定资产详情
router.get('/fixed-assets/:id', async (req, res) => {
  try {
    const [[asset]] = await db.query(
      `SELECT fa.*, s.code as subject_code, s.name as subject_name,
              ds.code as dep_subject_code, ds.name as dep_subject_name
       FROM acc_fixed_assets fa
       LEFT JOIN acc_subjects s ON fa.subject_id = s.id
       LEFT JOIN acc_subjects ds ON fa.dep_subject_id = ds.id
       WHERE fa.id=?`, [req.params.id]);
    if (!asset) return error(res, '资产不存在', 404);
    // 折旧记录
    const [depRecords] = await db.query(
      `SELECT dr.*, v.voucher_no FROM acc_depreciation_records dr
       LEFT JOIN acc_vouchers v ON dr.voucher_id = v.id
       WHERE dr.asset_id=? ORDER BY dr.period_year, dr.period_month`,
      [req.params.id]);
    success(res, { asset, depreciation_records: depRecords });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 新增固定资产
router.post('/fixed-assets', requireRole('super_admin','admin'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { asset_code, asset_name, category='other', subject_id, dep_subject_id,
            purchase_date, original_value, residual_rate=0.05, useful_life,
            location, department, responsible_person, notes } = req.body;

    if (!asset_name || !subject_id || !purchase_date || !original_value || !useful_life) {
      return error(res, '资产名称/科目/购入日期/原值/使用年限必填', 400);
    }

    // 自动生成资产编号
    let code = asset_code;
    if (!code) {
      const [last] = await conn.query(
        "SELECT asset_code FROM acc_fixed_assets WHERE asset_code LIKE 'FA-%' ORDER BY id DESC LIMIT 1");
      let seq = 1;
      if (last.length) { seq = parseInt(last[0].asset_code.split('-')[1]) + 1; }
      code = `FA-${String(seq).padStart(4,'0')}`;
    }

    // 计算月折旧额（直线法）
    const months = Number(useful_life);
    const residual = Number(original_value) * Number(residual_rate);
    const depBase = Number(original_value) - residual;
    const monthlyDep = depBase / months;

    const [result] = await conn.query(
      `INSERT INTO acc_fixed_assets (asset_code, asset_name, category, subject_id, dep_subject_id,
        purchase_date, original_value, residual_rate, useful_life, monthly_depreciation,
        location, department, responsible_person, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [code, asset_name, category, subject_id, dep_subject_id || null,
       purchase_date, original_value, residual_rate, months, monthlyDep,
       location, department, responsible_person, notes]
    );

    await auditLog(req.user?.username, 'create', 'fixed_asset', result.insertId, code,
      { asset_name, original_value, useful_life, monthly_depreciation: monthlyDep });
    success(res, { id: result.insertId, asset_code: code }, '固定资产创建成功');
  } catch (err) {
    error(res, '创建失败: ' + err.message);
  } finally { conn.release(); }
});

// 更新固定资产
router.put('/fixed-assets/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[old]] = await db.query('SELECT * FROM acc_fixed_assets WHERE id=?', [req.params.id]);
    if (!old) return error(res, '资产不存在', 404);

    const { asset_name, category, dep_subject_id, location, department,
            responsible_person, notes, status } = req.body;
    const updates = [], params = [];

    if (asset_name !== undefined) { updates.push('asset_name=?'); params.push(asset_name); }
    if (category !== undefined) { updates.push('category=?'); params.push(category); }
    if (dep_subject_id !== undefined) { updates.push('dep_subject_id=?'); params.push(dep_subject_id); }
    if (location !== undefined) { updates.push('location=?'); params.push(location); }
    if (department !== undefined) { updates.push('department=?'); params.push(department); }
    if (responsible_person !== undefined) { updates.push('responsible_person=?'); params.push(responsible_person); }
    if (notes !== undefined) { updates.push('notes=?'); params.push(notes); }
    if (status !== undefined) { updates.push('status=?'); params.push(status); }

    if (!updates.length) return error(res, '无更新内容', 400);
    params.push(req.params.id);

    await db.query(`UPDATE acc_fixed_assets SET ${updates.join(',')} WHERE id=?`, params);
    await auditLog(req.user?.username, 'update', 'fixed_asset', req.params.id, old.asset_code, { before: old, after: req.body });
    success(res, null, '更新成功');
  } catch (err) { error(res, '更新失败: ' + err.message); }
});

// 删除固定资产
router.delete('/fixed-assets/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[asset]] = await db.query('SELECT * FROM acc_fixed_assets WHERE id=?', [req.params.id]);
    if (!asset) return error(res, '资产不存在', 404);
    if (asset.accumulated_depreciation > 0) return error(res, '已有折旧记录，无法删除', 400);

    await db.query('DELETE FROM acc_fixed_assets WHERE id=?', [req.params.id]);
    await auditLog(req.user?.username, 'delete', 'fixed_asset', req.params.id, asset.asset_code, { deleted: asset });
    success(res, null, '已删除');
  } catch (err) { error(res, '删除失败: ' + err.message); }
});

// 批量计提折旧
router.post('/fixed-assets/depreciation', requireRole('super_admin','admin'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const year = Number(req.body.year) || new Date().getFullYear();
    const month = Number(req.body.month) || (new Date().getMonth() + 1);
    const endDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2,'0')}-${endDay}`;

    // 查找所有在用的、未完全折旧的资产
    const [assets] = await conn.query(
      `SELECT * FROM acc_fixed_assets WHERE status='in_use'
       AND original_value > accumulated_depreciation AND monthly_depreciation > 0`);

    if (!assets.length) return error(res, '无待折旧资产', 400);

    // 检查本月是否已计提
    const [existing] = await conn.query(
      `SELECT asset_id FROM acc_depreciation_records
       WHERE period_year=? AND period_month=?`, [year, month]);
    const skipIds = new Set(existing.map(r => r.asset_id));

    const toDepreciate = assets.filter(a => !skipIds.has(a.id));
    if (!toDepreciate.length) return error(res, '本月已计提完毕', 400);

    // 生成计提折旧凭证
    const genVoucherNo = async (vtype, date) => {
      const d = new Date(date);
      const prefix = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const [rows] = await db.query(
        `SELECT voucher_no FROM acc_vouchers WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${vtype}-${prefix}-%`]
      );
      let seq = 1;
      if (rows.length) {
        const last = rows[0].voucher_no.split('-');
        seq = parseInt(last[last.length-1]) + 1;
      }
      return `${vtype}-${prefix}-${String(seq).padStart(3,'0')}`;
    };

    const voucherNo = await genVoucherNo('记', endDate);

    // 按费用科目分组汇总
    const groups = {};
    let totalDep = 0;
    for (const a of toDepreciate) {
      const depSubCode = a.dep_subject_id ? (await conn.query('SELECT code FROM acc_subjects WHERE id=?', [a.dep_subject_id]))[0][0]?.code || '6601.03' : '6601.03';
      const key = depSubCode;
      if (!groups[key]) { groups[key] = { subject_id: a.dep_subject_id || null, assets: [], total: 0 }; }
      groups[key].assets.push(a);
      groups[key].total += Number(a.monthly_depreciation);
      totalDep += Number(a.monthly_depreciation);
    }

    await conn.beginTransaction();

    // 创建凭证
    const description = `${year}年${month}月计提固定资产折旧`;
    const [vResult] = await conn.query(
      `INSERT INTO acc_vouchers (voucher_no, voucher_type, voucher_date, description, total_debit, total_credit, created_by, status)
       VALUES (?, '记', ?, ?, ?, ?, ?, 'posted')`,
      [voucherNo, endDate, description, totalDep, totalDep, req.user?.username || 'admin']
    );
    const vId = vResult.insertId;

    // 找到累计折旧科目
    const [[accDep]] = await conn.query("SELECT id FROM acc_subjects WHERE code='1602'");
    if (!accDep) { await conn.rollback(); return error(res, '累计折旧科目(1602)不存在', 500); }

    let lineNo = 1;

    // 贷方：累计折旧（一行汇总）
    await conn.query(
      `INSERT INTO acc_voucher_entries (voucher_id, line_no, subject_id, summary, debit_amount, credit_amount)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [vId, lineNo++, accDep.id, '计提当月折旧', totalDep]
    );

    // 借方：各费用科目
    for (const [key, group] of Object.entries(groups)) {
      // 找费用科目
      const depSubId = group.subject_id;
      let feeSubjId = depSubId;
      if (!feeSubjId) {
        const [subs] = await conn.query("SELECT id FROM acc_subjects WHERE code LIKE '6601.03%' OR code='660103' LIMIT 1");
        feeSubjId = subs.length ? subs[0].id : group.assets[0].subject_id;
      }
      await conn.query(
        `INSERT INTO acc_voucher_entries (voucher_id, line_no, subject_id, summary, debit_amount, credit_amount)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [vId, lineNo++, feeSubjId, `计提折旧-${group.assets.map(a=>a.asset_name).join(',')}`, group.total]
      );

      // 记录到折旧明细表
      for (const a of group.assets) {
        await conn.query(
          `INSERT INTO acc_depreciation_records (asset_id, period_year, period_month, depreciation_amount, voucher_id)
           VALUES (?,?,?,?,?)`,
          [a.id, year, month, a.monthly_depreciation, vId]
        );
        // 更新资产累计折旧
        await conn.query(
          `UPDATE acc_fixed_assets SET accumulated_depreciation = accumulated_depreciation + ? WHERE id=?`,
          [a.monthly_depreciation, a.id]
        );
      }
    }

    await conn.commit();
    await auditLog(req.user?.username, 'depreciation', 'fixed_asset', vId, voucherNo,
      { year, month, assets_count: toDepreciate.length, total_depreciation: totalDep });

    success(res, {
      voucher_id: vId, voucher_no: voucherNo,
      assets_count: toDepreciate.length, total_depreciation: Number(totalDep.toFixed(2))
    }, '计提折旧完成');
  } catch (err) {
    await conn.rollback();
    error(res, '计提折旧失败: ' + err.message);
  } finally { conn.release(); }
});

// ==================== 凭证模板 ====================

// 模板列表
router.get('/voucher-templates', async (req, res) => {
  try {
    const [templates] = await db.query(
      'SELECT * FROM acc_voucher_templates WHERE is_active=1 ORDER BY sort_order');
    for (const tpl of templates) {
      const [entries] = await db.query(
        `SELECT te.*, s.code as subj_code, s.name as subj_name
         FROM acc_voucher_template_entries te
         JOIN acc_subjects s ON te.subject_id = s.id
         WHERE te.template_id=? ORDER BY te.line_no`, [tpl.id]);
      tpl.entries = entries;
    }
    success(res, templates);
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 应用模板创建凭证
router.post('/voucher-templates/:id/apply', requireRole('super_admin','admin','accountant'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const [[tpl]] = await conn.query('SELECT * FROM acc_voucher_templates WHERE id=?', [req.params.id]);
    if (!tpl) return error(res, '模板不存在', 404);

    const [entries] = await conn.query(
      `SELECT * FROM acc_voucher_template_entries WHERE template_id=? ORDER BY line_no`, [req.params.id]);
    if (!entries.length) return error(res, '模板无分录', 400);

    const { voucher_date, amounts } = req.body;
    if (!voucher_date) return error(res, '凭证日期必填', 400);

    // 构建分录
    const voucherEntries = [];
    let totalDebit = 0, totalCredit = 0;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const amt = amounts && amounts[i] ? Number(amounts[i]) : 0;
      if (e.direction === 'debit') {
        totalDebit += amt;
        voucherEntries.push({ subject_id: e.subject_id, summary: e.summary, debit_amount: amt, credit_amount: 0 });
      } else {
        totalCredit += amt;
        voucherEntries.push({ subject_id: e.subject_id, summary: e.summary, debit_amount: 0, credit_amount: amt });
      }
    }

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return error(res, `借贷不平衡: ${totalDebit} ≠ ${totalCredit}`, 400);
    }

    // 生成凭证号
    const genVoucherNo = async (vtype, date) => {
      const d = new Date(date);
      const prefix = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const [rows] = await db.query(
        `SELECT voucher_no FROM acc_vouchers WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`,
        [`${vtype}-${prefix}-%`]);
      let seq = 1;
      if (rows.length) { const last = rows[0].voucher_no.split('-'); seq = parseInt(last[last.length-1]) + 1; }
      return `${vtype}-${prefix}-${String(seq).padStart(3,'0')}`;
    };

    const voucherNo = await genVoucherNo(tpl.voucher_type, voucher_date);

    await conn.beginTransaction();

    const [vResult] = await conn.query(
      `INSERT INTO acc_vouchers (voucher_no, voucher_type, voucher_date, description, total_debit, total_credit, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [voucherNo, tpl.voucher_type, voucher_date, tpl.name, totalDebit, totalCredit, req.user?.username || 'admin']
    );
    const vId = vResult.insertId;

    for (let i = 0; i < voucherEntries.length; i++) {
      const e = voucherEntries[i];
      await conn.query(
        `INSERT INTO acc_voucher_entries (voucher_id, line_no, subject_id, summary, debit_amount, credit_amount)
         VALUES (?,?,?,?,?,?)`,
        [vId, i+1, e.subject_id, e.summary, e.debit_amount, e.credit_amount]
      );
    }

    await conn.commit();
    await auditLog(req.user?.username, 'create_from_template', 'voucher', vId, voucherNo, { template_id: tpl.id, template_name: tpl.name });
    success(res, { id: vId, voucher_no: voucherNo, template_name: tpl.name }, '凭证创建成功');
  } catch (err) {
    await conn.rollback();
    error(res, '应用模板失败: ' + err.message);
  } finally { conn.release(); }
});

// 创建/更新模板
router.post('/voucher-templates', requireRole('super_admin','admin'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { name, description, voucher_type='记', entries } = req.body;
    if (!name || !entries || !entries.length) return error(res, '名称和分录必填', 400);

    await conn.beginTransaction();

    const [r] = await conn.query(
      `INSERT INTO acc_voucher_templates (name, description, voucher_type) VALUES (?,?,?)`,
      [name, description, voucher_type]);
    const tId = r.insertId;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      await conn.query(
        `INSERT INTO acc_voucher_template_entries (template_id, line_no, subject_id, summary, direction)
         VALUES (?,?,?,?,?)`,
        [tId, i+1, e.subject_id, e.summary, e.direction || 'debit']);
    }

    await conn.commit();
    await auditLog(req.user?.username, 'create', 'voucher_template', tId, name);
    success(res, { id: tId }, '模板创建成功');
  } catch (err) {
    await conn.rollback();
    error(res, '创建失败: ' + err.message);
  } finally { conn.release(); }
});

// 删除模板
router.delete('/voucher-templates/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[tpl]] = await db.query('SELECT * FROM acc_voucher_templates WHERE id=?', [req.params.id]);
    if (!tpl) return error(res, '模板不存在', 404);
    await db.query('DELETE FROM acc_voucher_templates WHERE id=?', [req.params.id]);
    await auditLog(req.user?.username, 'delete', 'voucher_template', req.params.id, tpl.name);
    success(res, null, '已删除');
  } catch (err) { error(res, '删除失败: ' + err.message); }
});

// ==================== 所有者权益变动表 ====================

router.get('/statements/equity-changes', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();

    // 权益科目
    const equitySubjects = [
      { code: '4001', name: '实收资本', key: 'paid_in_capital' },
      { code: '4002', name: '资本公积', key: 'capital_reserve' },
      { code: '4101', name: '盈余公积', key: 'surplus_reserve' },
      { code: '4104', name: '利润分配', key: 'profit_distribution' },
    ];

    const result = {
      year,
      items: []
    };

    // 计算本年利润（从期初结转）
    let currentYearProfit = 0;
    const [profitRows] = await db.query(
      `SELECT COALESCE(SUM(e.credit_amount - e.debit_amount), 0) as net
       FROM acc_voucher_entries e
       JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
       JOIN acc_subjects s ON e.subject_id=s.id
       WHERE s.code='4103' AND YEAR(v.voucher_date)=?`, [year]);
    currentYearProfit = Number(profitRows[0]?.net || 0);

    // 同时汇总 revenue-expense 作为补充
    const [pl] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN s.type='revenue' THEN e.credit_amount - e.debit_amount ELSE 0 END), 0) as revenue,
        COALESCE(SUM(CASE WHEN s.type IN ('cost','expense') THEN e.debit_amount - e.credit_amount ELSE 0 END), 0) as expense
      FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
      JOIN acc_subjects s ON e.subject_id=s.id
      WHERE YEAR(v.voucher_date)=?
    `, [year]);
    const netIncome = Number(pl[0].revenue) - Number(pl[0].expense);

    for (const subj of equitySubjects) {
      // 期初余额（本年初 = 上期末累计）
      const [[ob]] = await db.query(`
        SELECT COALESCE(SUM(CASE WHEN s.direction='debit'
          THEN e.debit_amount - e.credit_amount
          ELSE e.credit_amount - e.debit_amount END), 0) as balance
        FROM acc_voucher_entries e
        JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
        JOIN acc_subjects s ON e.subject_id=s.id
        WHERE s.code=? AND v.voucher_date < ?`, [subj.code, `${year}-01-01`]);

      // 本年借方发生额
      const [[dbAmt]] = await db.query(`
        SELECT COALESCE(SUM(e.debit_amount), 0) as amt
        FROM acc_voucher_entries e
        JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
        JOIN acc_subjects s ON e.subject_id=s.id
        WHERE s.code=? AND YEAR(v.voucher_date)=?`, [subj.code, year]);

      // 本年贷方发生额
      const [[crAmt]] = await db.query(`
        SELECT COALESCE(SUM(e.credit_amount), 0) as amt
        FROM acc_voucher_entries e
        JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
        JOIN acc_subjects s ON e.subject_id=s.id
        WHERE s.code=? AND YEAR(v.voucher_date)=?`, [subj.code, year]);

      const opening = Number(ob.balance);
      const yrIncrease = Number(crAmt.amt);
      const yrDecrease = Number(dbAmt.amt);
      const closing = opening + yrIncrease - yrDecrease;

      result.items.push({
        name: subj.name,
        code: subj.code,
        key: subj.key,
        opening_balance: opening,
        increase: yrIncrease,
        decrease: yrDecrease,
        closing_balance: closing
      });
    }

    // 加"未分配利润"行
    const prevProfit = currentYearProfit - netIncome;
    result.items.push({
      name: '未分配利润',
      code: '--',
      key: 'undistributed_profit',
      opening_balance: Number(prevProfit.toFixed(2)),
      increase: Number(Math.max(0, netIncome).toFixed(2)),
      decrease: Number(Math.max(0, -netIncome).toFixed(2)),
      closing_balance: Number((prevProfit + netIncome).toFixed(2))
    });

    // 合计行
    const totalOpening = result.items.reduce((s, i) => s + i.opening_balance, 0);
    const totalIncrease = result.items.reduce((s, i) => s + i.increase, 0);
    const totalDecrease = result.items.reduce((s, i) => s + i.decrease, 0);
    const totalClosing = result.items.reduce((s, i) => s + i.closing_balance, 0);
    result.total = { opening: totalOpening, increase: totalIncrease, decrease: totalDecrease, closing: totalClosing };

    success(res, result);
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 所有者权益变动表导出
router.get('/statements/equity-changes/export', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();

    // 内联计算（避免axios依赖）
    const equitySubjects = [
      { code: '4001', name: '实收资本' }, { code: '4002', name: '资本公积' },
      { code: '4101', name: '盈余公积' }, { code: '4104', name: '利润分配' },
    ];

    let items = [];
    for (const subj of equitySubjects) {
      const [[ob]] = await db.query(`
        SELECT COALESCE(SUM(CASE WHEN s.direction='debit' THEN e.debit_amount - e.credit_amount ELSE e.credit_amount - e.debit_amount END),0) as b
        FROM acc_voucher_entries e JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted' JOIN acc_subjects s ON e.subject_id=s.id
        WHERE s.code=? AND v.voucher_date < ?`, [subj.code, `${year}-01-01`]);
      const [[dbAmt]] = await db.query(`
        SELECT COALESCE(SUM(e.debit_amount),0) as a FROM acc_voucher_entries e JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
        JOIN acc_subjects s ON e.subject_id=s.id WHERE s.code=? AND YEAR(v.voucher_date)=?`, [subj.code, year]);
      const [[crAmt]] = await db.query(`
        SELECT COALESCE(SUM(e.credit_amount),0) as a FROM acc_voucher_entries e JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
        JOIN acc_subjects s ON e.subject_id=s.id WHERE s.code=? AND YEAR(v.voucher_date)=?`, [subj.code, year]);
      const op=Number(ob.b); const inc=Number(crAmt.a); const dec=Number(dbAmt.a);
      items.push({ name: subj.name, op, inc, dec, close: op+inc-dec });
    }

    // 未分配利润
    const [[pl]] = await db.query(`
      SELECT COALESCE(SUM(CASE WHEN s.type='revenue' THEN e.credit_amount-e.debit_amount ELSE 0 END),0) as rev,
             COALESCE(SUM(CASE WHEN s.type IN ('cost','expense') THEN e.debit_amount-e.credit_amount ELSE 0 END),0) as exp
      FROM acc_voucher_entries e JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted' JOIN acc_subjects s ON e.subject_id=s.id
      WHERE YEAR(v.voucher_date)=?`, [year]);
    const ni = Number(pl.rev) - Number(pl.exp);
    const [[pp]] = await db.query(`
      SELECT COALESCE(SUM(e.credit_amount-e.debit_amount),0) as n FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted' JOIN acc_subjects s ON e.subject_id=s.id
      WHERE s.code='4103' AND YEAR(v.voucher_date)=?`, [year]);
    const cp = Number(pp.n);
    const prev = cp - ni;
    items.push({ name: '未分配利润', op: prev, inc: Math.max(0,ni), dec: Math.max(0,-ni), close: prev+ni });

    // Summary line
    const top = items.reduce((s,i)=>s+i.op,0), tinc=items.reduce((s,i)=>s+i.inc,0);
    const tdec=items.reduce((s,i)=>s+i.dec,0), tcl=items.reduce((s,i)=>s+i.close,0);
    items.push({ name: '所有者权益合计', op: top, inc: tinc, dec: tdec, close: tcl });

    let csv = '\uFEFF项目,期初余额,本年增加,本年减少,期末余额\n';
    for (const it of items) {
      csv += `${it.name},${it.op.toFixed(2)},${it.inc.toFixed(2)},${it.dec.toFixed(2)},${it.close.toFixed(2)}\n`;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader("Content-Disposition", "attachment; filename=" + year + "_equity_changes.csv");
    res.send(csv);
  } catch (err) { error(res, '导出失败: ' + err.message); }
});

// ==================== 审计日志查询 ====================

router.get('/audit-logs', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { entity_type, entity_id, user_name, action, page=1, pageSize=50 } = req.query;
    let where = ['1=1'], params = [];
    if (entity_type) { where.push('entity_type=?'); params.push(entity_type); }
    if (entity_id) { where.push('entity_id=?'); params.push(entity_id); }
    if (user_name) { where.push('user_name=?'); params.push(user_name); }
    if (action) { where.push('action=?'); params.push(action); }

    const offset = (Number(page)-1) * Number(pageSize);
    const [rows] = await db.query(
      `SELECT * FROM acc_audit_logs WHERE ${where.join(' AND ')}
       ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), offset]);
    const [[{total}]] = await db.query(
      `SELECT COUNT(*) as total FROM acc_audit_logs WHERE ${where.join(' AND ')}`, params);

    success(res, { list: rows, total, page: Number(page), pageSize: Number(pageSize) });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});


// ==================== 往来核销 ====================

// 获取未核销的往来明细（按科目）
router.get('/reconciliation/outstanding', async (req, res) => {
  try {
    const { type, subject_id, start_date, end_date } = req.query;
    if (!type || !['ar','ap'].includes(type)) return error(res, 'type必须为ar或ap', 400);

    // AR/AP科目
    const arCodes = type==='ar' ? ["'1122'","'1123'","'1231'"] : ["'2202'","'2203'","'2241'"];
    let where = [`s.code IN (${arCodes.join(',')})`], params = [];
    if (subject_id) { where.push('e.subject_id=?'); params.push(subject_id); }
    if (start_date) { where.push('v.voucher_date>=?'); params.push(start_date); }
    if (end_date) { where.push('v.voucher_date<=?'); params.push(end_date); }

    // 查找已在核销记录中的entry_id
    const [reconciled] = await db.query(
      `SELECT DISTINCT ri.entry_id FROM acc_reconciliation_items ri
       JOIN acc_reconciliations r ON ri.recon_id=r.id
       WHERE r.recon_type=? AND r.status != 'cancelled'`, [type]);
    const reconciledIds = reconciled.map(r => r.entry_id);

    const [rows] = await db.query(`
      SELECT e.id as entry_id, e.voucher_id, e.subject_id,
             e.debit_amount, e.credit_amount, e.summary,
             v.voucher_no, v.voucher_date, v.description,
             s.code as subject_code, s.name as subject_name
      FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
      JOIN acc_subjects s ON e.subject_id=s.id AND s.is_active=1
      WHERE ${where.join(' AND ')} AND (e.debit_amount > 0 OR e.credit_amount > 0)
      ORDER BY v.voucher_date, v.voucher_no, e.line_no
    `, params);

    // 过滤已核销
    const outstanding = rows.filter(r => !reconciledIds.includes(r.entry_id));

    // 按科目分组汇总
    const groups = {};
    for (const row of outstanding) {
      const key = `${row.subject_code} ${row.subject_name}`;
      if (!groups[key]) groups[key] = { subject_id: row.subject_id, code: row.subject_code, name: row.subject_name, items: [], total_debit: 0, total_credit: 0 };
      groups[key].items.push(row);
      groups[key].total_debit += Number(row.debit_amount);
      groups[key].total_credit += Number(row.credit_amount);
    }

    const list = Object.values(groups);
    const totalDebit = list.reduce((s,g)=>s+g.total_debit,0);
    const totalCredit = list.reduce((s,g)=>s+g.total_credit,0);

    success(res, {
      type,
      groups: list,
      summary: { total_debit: Number(totalDebit.toFixed(2)), total_credit: Number(totalCredit.toFixed(2)), outstanding: outstanding.length }
    });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 执行核销
router.post('/reconciliation/reconcile', requireRole('super_admin','admin','accountant'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { type, entry_ids, notes } = req.body;
    if (!type || !entry_ids || !entry_ids.length) return error(res, 'type和entry_ids必填', 400);

    // 获取分录信息
    const [entries] = await conn.query(
      `SELECT e.*, s.code FROM acc_voucher_entries e
       JOIN acc_subjects s ON e.subject_id=s.id
       WHERE e.id IN (${entry_ids.map(()=>'?').join(',')})`, entry_ids);

    if (!entries.length) return error(res, '未找到分录', 404);
    const subjectId = entries[0].subject_id;
    const totalAmount = entries.reduce((s, e) => s + Number(e.debit_amount) + Number(e.credit_amount), 0);

    // 生成核销编号
    const now = new Date();
    const [lastRecon] = await conn.query(
      "SELECT recon_no FROM acc_reconciliations WHERE recon_no LIKE ? ORDER BY id DESC LIMIT 1",
      [`RC-${type.toUpperCase()}-${now.getFullYear()}%`]
    );
    let seq = 1;
    if (lastRecon.length) seq = parseInt(lastRecon[0].recon_no.split('-').pop()) + 1;
    const reconNo = `RC-${type.toUpperCase()}-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}-${String(seq).padStart(3,'0')}`;

    await conn.beginTransaction();

    const [rResult] = await conn.query(
      `INSERT INTO acc_reconciliations (recon_no, recon_type, subject_id, recon_date, total_amount, notes, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [reconNo, type, subjectId, now.toISOString().split('T')[0], totalAmount, notes, req.user?.username || 'admin']
    );
    const reconId = rResult.insertId;

    for (const e of entries) {
      await conn.query(
        `INSERT INTO acc_reconciliation_items (recon_id, entry_id, voucher_id, amount, direction)
         VALUES (?,?,?,?,?)`,
        [reconId, e.id, e.voucher_id, Number(e.debit_amount) || Number(e.credit_amount),
         Number(e.debit_amount) > 0 ? 'debit' : 'credit']
      );
    }

    await conn.commit();
    await auditLog(req.user?.username, 'reconcile', 'reconciliation', reconId, reconNo,
      { type, entry_ids, total_amount: totalAmount });

    success(res, { id: reconId, recon_no: reconNo, entries_count: entries.length, total_amount: totalAmount }, '核销成功');
  } catch (err) {
    await conn.rollback();
    error(res, '核销失败: ' + err.message);
  } finally { conn.release(); }
});

// 核销记录列表
router.get('/reconciliations', async (req, res) => {
  try {
    const { type, page=1, pageSize=50 } = req.query;
    let where = ['1=1'], params = [];
    if (type) { where.push('r.recon_type=?'); params.push(type); }
    const offset = (Number(page)-1)*Number(pageSize);
    const [rows] = await db.query(
      `SELECT r.*, s.code as subject_code, s.name as subject_name,
        (SELECT COUNT(*) FROM acc_reconciliation_items WHERE recon_id=r.id) as item_count
       FROM acc_reconciliations r
       LEFT JOIN acc_subjects s ON r.subject_id=s.id
       WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), offset]
    );
    const [[{total}]] = await db.query(`SELECT COUNT(*) as total FROM acc_reconciliations r WHERE ${where.join(' AND ')}`, params);
    success(res, { list: rows, total, page: Number(page), pageSize: Number(pageSize) });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 核销详情
router.get('/reconciliations/:id', async (req, res) => {
  try {
    const [[recon]] = await db.query(
      `SELECT r.*, s.code as subject_code, s.name as subject_name
       FROM acc_reconciliations r LEFT JOIN acc_subjects s ON r.subject_id=s.id WHERE r.id=?`, [req.params.id]);
    if (!recon) return error(res, '核销记录不存在', 404);
    const [items] = await db.query(
      `SELECT ri.*, v.voucher_no, v.voucher_date, e.summary, e.debit_amount, e.credit_amount
       FROM acc_reconciliation_items ri
       JOIN acc_voucher_entries e ON ri.entry_id=e.id
       JOIN acc_vouchers v ON ri.voucher_id=v.id
       WHERE ri.recon_id=?`, [req.params.id]);
    success(res, { recon, items });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 取消核销
router.post('/reconciliations/:id/cancel', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[recon]] = await db.query('SELECT * FROM acc_reconciliations WHERE id=?', [req.params.id]);
    if (!recon) return error(res, '核销记录不存在', 404);
    if (recon.status === 'cancelled') return error(res, '已取消', 400);

    await db.query("UPDATE acc_reconciliations SET status='cancelled' WHERE id=?", [req.params.id]);
    await auditLog(req.user?.username, 'cancel', 'reconciliation', req.params.id, recon.recon_no);
    success(res, null, '已取消核销');
  } catch (err) { error(res, '取消失败: ' + err.message); }
});

// ==================== 审批流程 ====================

// 提交审批
router.post('/vouchers/:id/submit', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const [[voucher]] = await db.query('SELECT * FROM acc_vouchers WHERE id=?', [req.params.id]);
    if (!voucher) return error(res, '凭证不存在', 404);
    if (voucher.status !== 'draft') return error(res, '只有草稿状态可提交审批', 400);

    await db.query("UPDATE acc_vouchers SET status='pending' WHERE id=?", [req.params.id]);
    await db.query(
      'INSERT INTO acc_approval_records (voucher_id, step, user_name, comment) VALUES (?,?,?,?)',
      [req.params.id, 'submit', req.user?.username || 'admin', req.body.comment || '提交审批']
    );
    await auditLog(req.user?.username, 'submit', 'voucher', req.params.id, voucher.voucher_no);
    success(res, null, '已提交审批');
  } catch (err) { error(res, '提交失败: ' + err.message); }
});

// 审批通过
router.post('/vouchers/:id/approve', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[voucher]] = await db.query('SELECT * FROM acc_vouchers WHERE id=?', [req.params.id]);
    if (!voucher) return error(res, '凭证不存在', 404);
    if (voucher.status !== 'pending') return error(res, '只有待审批状态可审核', 400);

    await db.query("UPDATE acc_vouchers SET status='audited', auditor=? WHERE id=?", [req.user?.username || 'admin', req.params.id]);
    await db.query(
      'INSERT INTO acc_approval_records (voucher_id, step, user_name, comment) VALUES (?,?,?,?)',
      [req.params.id, 'approve', req.user?.username || 'admin', req.body.comment || '审核通过']
    );
    await auditLog(req.user?.username, 'approve', 'voucher', req.params.id, voucher.voucher_no);
    success(res, null, '审核通过');
  } catch (err) { error(res, '审批失败: ' + err.message); }
});

// 驳回
router.post('/vouchers/:id/reject', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[voucher]] = await db.query('SELECT * FROM acc_vouchers WHERE id=?', [req.params.id]);
    if (!voucher) return error(res, '凭证不存在', 404);
    if (voucher.status !== 'pending') return error(res, '只有待审批状态可驳回', 400);

    await db.query("UPDATE acc_vouchers SET status='rejected' WHERE id=?", [req.params.id]);
    await db.query(
      'INSERT INTO acc_approval_records (voucher_id, step, user_name, comment) VALUES (?,?,?,?)',
      [req.params.id, 'reject', req.user?.username || 'admin', req.body.comment || '驳回']
    );
    await auditLog(req.user?.username, 'reject', 'voucher', req.params.id, voucher.voucher_no);
    success(res, null, '已驳回');
  } catch (err) { error(res, '驳回失败: ' + err.message); }
});

// 重新提交（从rejected回到draft）
router.post('/vouchers/:id/resubmit', requireRole('super_admin','admin','accountant'), async (req, res) => {
  try {
    const [[voucher]] = await db.query('SELECT * FROM acc_vouchers WHERE id=?', [req.params.id]);
    if (!voucher) return error(res, '凭证不存在', 404);
    if (voucher.status !== 'rejected') return error(res, '只有已驳回状态可重新提交', 400);

    await db.query("UPDATE acc_vouchers SET status='draft' WHERE id=?", [req.params.id]);
    await db.query(
      'INSERT INTO acc_approval_records (voucher_id, step, user_name, comment) VALUES (?,?,?,?)',
      [req.params.id, 'resubmit', req.user?.username || 'admin', '重新提交']
    );
    success(res, null, '已重新提交为草稿');
  } catch (err) { error(res, '重新提交失败: ' + err.message); }
});

// 审批记录
router.get('/vouchers/:id/approval-records', async (req, res) => {
  try {
    const [records] = await db.query(
      'SELECT * FROM acc_approval_records WHERE voucher_id=? ORDER BY id', [req.params.id]);
    success(res, records);
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 待审批列表
router.get('/approval-pending', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT v.*
       FROM acc_vouchers v
       WHERE v.status='pending' ORDER BY v.voucher_date, v.voucher_no`);
    success(res, rows);
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// ==================== 存货管理 ====================

// 存货项目列表
router.get('/inventory-items', async (req, res) => {
  try {
    const { search, category, page=1, pageSize=100 } = req.query;
    let where = ['i.is_active=1'], params = [];
    if (search) { where.push('(i.item_code LIKE ? OR i.item_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    if (category) { where.push('i.category=?'); params.push(category); }
    const offset = (Number(page)-1)*Number(pageSize);
    const [rows] = await db.query(
      `SELECT i.*, s.code as subject_code, s.name as subject_name
       FROM acc_inventory_items i
       LEFT JOIN acc_subjects s ON i.subject_id=s.id
       WHERE ${where.join(' AND ')} ORDER BY i.item_code LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), offset]
    );
    const [[{total}]] = await db.query(`SELECT COUNT(*) as total FROM acc_inventory_items i WHERE ${where.join(' AND ')}`, params);
    success(res, { list: rows, total, page: Number(page), pageSize: Number(pageSize) });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 存货详情
router.get('/inventory-items/:id', async (req, res) => {
  try {
    const [[item]] = await db.query(
      `SELECT i.*, s.code as subject_code, s.name as subject_name
       FROM acc_inventory_items i LEFT JOIN acc_subjects s ON i.subject_id=s.id WHERE i.id=?`, [req.params.id]);
    if (!item) return error(res, '存货不存在', 404);
    const [trans] = await db.query(
      `SELECT t.*, v.voucher_no FROM acc_inventory_transactions t
       LEFT JOIN acc_vouchers v ON t.voucher_id=v.id
       WHERE t.item_id=? ORDER BY t.trans_date DESC, t.id DESC LIMIT 200`, [req.params.id]);
    success(res, { item, transactions: trans });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// 新增存货
router.post('/inventory-items', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const { item_code, item_name, category='raw_material', spec, unit='个',
            unit_price=0, safety_stock=0, subject_id, notes } = req.body;
    if (!item_name || !subject_id) return error(res, '名称和科目必填', 400);

    let code = item_code;
    if (!code) {
      const [last] = await db.query(
        "SELECT item_code FROM acc_inventory_items WHERE item_code LIKE 'INV-%' ORDER BY id DESC LIMIT 1");
      let seq = last.length ? parseInt(last[0].item_code.split('-')[1])+1 : 1;
      code = `INV-${String(seq).padStart(4,'0')}`;
    }

    const [r] = await db.query(
      `INSERT INTO acc_inventory_items (item_code, item_name, category, spec, unit, unit_price, safety_stock, subject_id, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [code, item_name, category, spec, unit, unit_price, safety_stock, subject_id, notes]);
    await auditLog(req.user?.username, 'create', 'inventory_item', r.insertId, code, { item_name, category });
    success(res, { id: r.insertId, item_code: code }, '存货创建成功');
  } catch (err) { error(res, '创建失败: ' + err.message); }
});

// 更新存货
router.put('/inventory-items/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[old]] = await db.query('SELECT * FROM acc_inventory_items WHERE id=?', [req.params.id]);
    if (!old) return error(res, '存货不存在', 404);

    const { item_name, category, spec, unit, unit_price, safety_stock, subject_id, notes, is_active } = req.body;
    const ups = [], vals = [];
    if (item_name !== undefined) { ups.push('item_name=?'); vals.push(item_name); }
    if (category !== undefined) { ups.push('category=?'); vals.push(category); }
    if (spec !== undefined) { ups.push('spec=?'); vals.push(spec); }
    if (unit !== undefined) { ups.push('unit=?'); vals.push(unit); }
    if (unit_price !== undefined) { ups.push('unit_price=?'); vals.push(unit_price); }
    if (safety_stock !== undefined) { ups.push('safety_stock=?'); vals.push(safety_stock); }
    if (subject_id !== undefined) { ups.push('subject_id=?'); vals.push(subject_id); }
    if (notes !== undefined) { ups.push('notes=?'); vals.push(notes); }
    if (is_active !== undefined) { ups.push('is_active=?'); vals.push(is_active); }

    if (!ups.length) return error(res, '无更新内容', 400);
    vals.push(req.params.id);
    await db.query(`UPDATE acc_inventory_items SET ${ups.join(',')} WHERE id=?`, vals);
    await auditLog(req.user?.username, 'update', 'inventory_item', req.params.id, old.item_code);
    success(res, null, '更新成功');
  } catch (err) { error(res, '更新失败: ' + err.message); }
});

// 删除存货
router.delete('/inventory-items/:id', requireRole('super_admin','admin'), async (req, res) => {
  try {
    const [[item]] = await db.query('SELECT * FROM acc_inventory_items WHERE id=?', [req.params.id]);
    if (!item) return error(res, '存货不存在', 404);
    if (Number(item.current_stock) != 0) return error(res, '当前库存不为0，无法删除', 400);

    await db.query('UPDATE acc_inventory_items SET is_active=0 WHERE id=?', [req.params.id]);
    await auditLog(req.user?.username, 'delete', 'inventory_item', req.params.id, item.item_code);
    success(res, null, '已停用');
  } catch (err) { error(res, '删除失败: ' + err.message); }
});

// 存货入库
router.post('/inventory/stock-in', requireRole('super_admin','admin','accountant'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { item_id, quantity, unit_cost, voucher_date, batch_no, reference, notes, is_posted } = req.body;
    if (!item_id || !quantity || !unit_cost || !voucher_date) return error(res, '存货/数量/单价/日期必填', 400);
    const qty = Number(quantity);
    const cost = Number(unit_cost);
    if (qty <= 0 || cost <= 0) return error(res, '数量和单价必须大于0', 400);

    const [[item]] = await conn.query('SELECT i.*, s.code FROM acc_inventory_items i JOIN acc_subjects s ON i.subject_id=s.id WHERE i.id=?', [item_id]);
    if (!item) return error(res, '存货不存在', 404);

    const total = qty * cost;

    await conn.beginTransaction();

    // 更新库存
    await conn.query('UPDATE acc_inventory_items SET current_stock=current_stock+? WHERE id=?', [qty, item_id]);

    // 插入交易记录
    const [tResult] = await conn.query(
      `INSERT INTO acc_inventory_transactions (item_id, trans_type, trans_date, quantity, direction, unit_cost, total_cost, batch_no, voucher_id, reference, notes, created_by)
       VALUES (?, 'purchase', ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?)`,
      [item_id, voucher_date, qty, cost, total, batch_no, null, reference, notes, req.user?.username || 'admin']);
    const transId = tResult.insertId;

    // 如果要求记账，创建凭证
    let vId = null, vNo = null;
    if (is_posted) {
      // 找对方科目（采购来源科目）
      const [oppSubj] = await conn.query("SELECT id FROM acc_subjects WHERE code='2202'");
      const oppSubjectId = oppSubj.length ? oppSubj[0].id : item.subject_id;

      const genVoucherNo = async () => {
        const d = new Date(voucher_date);
        const pf = `记-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        const [rows] = await conn.query(`SELECT voucher_no FROM acc_vouchers WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`, [`${pf}-%`]);
        let seq = rows.length ? parseInt(rows[0].voucher_no.split('-').pop())+1 : 1;
        return `${pf}-${String(seq).padStart(3,'0')}`;
      };
      vNo = await genVoucherNo();

      const [vRes] = await conn.query(
        `INSERT INTO acc_vouchers (voucher_no, voucher_type, voucher_date, description, total_debit, total_credit, created_by, status)
         VALUES (?, '记', ?, ?, ?, ?, ?, 'posted')`,
        [vNo, voucher_date, `采购入库：${item.item_name} ${qty}${item.unit}`, total, total, req.user?.username || 'admin']);
      vId = vRes.insertId;

      await conn.query(
        `INSERT INTO acc_voucher_entries (voucher_id, line_no, subject_id, summary, debit_amount, credit_amount) VALUES (?,1,?,?,?,0),(?,2,?,?,0,?)`,
        [vId, item.subject_id, `采购入库：${item.item_name}`, total, vId, oppSubjectId, `采购入库：${item.item_name}`, total]);

      // 更新交易记录关联凭证
      await conn.query('UPDATE acc_inventory_transactions SET voucher_id=? WHERE id=?', [vId, transId]);
    }

    await conn.commit();
    await auditLog(req.user?.username, 'stock_in', 'inventory', item_id, item.item_code,
      { quantity: qty, unit_cost: cost, total, voucher_id: vId || null });

    success(res, {
      transaction_id: transId, item_code: item.item_code,
      quantity: qty, total_cost: total, voucher_no: vNo
    }, '入库成功');
  } catch (err) {
    await conn.rollback();
    error(res, '入库失败: ' + err.message);
  } finally { conn.release(); }
});

// 存货出库
router.post('/inventory/stock-out', requireRole('super_admin','admin','accountant'), async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { item_id, quantity, voucher_date, reference, notes, is_posted } = req.body;
    if (!item_id || !quantity || !voucher_date) return error(res, '存货/数量/日期必填', 400);
    const qty = Number(quantity);
    if (qty <= 0) return error(res, '数量必须大于0', 400);

    const [[item]] = await conn.query('SELECT * FROM acc_inventory_items WHERE id=?', [item_id]);
    if (!item) return error(res, '存货不存在', 404);
    if (Number(item.current_stock) < qty) return error(res, `库存不足（当前${item.current_stock}${item.unit}）`, 400);

    // 加权平均成本
    const [[costInfo]] = await conn.query(
      `SELECT COALESCE(SUM(total_cost)/SUM(quantity), unit_price) as avg_cost
       FROM acc_inventory_items i
       LEFT JOIN acc_inventory_transactions t ON i.id=t.item_id AND t.direction='in'
       WHERE i.id=?`, [item_id]);
    const avgCost = Number(costInfo.avg_cost) || Number(item.unit_price) || 0;
    const total = qty * avgCost;

    await conn.beginTransaction();

    await conn.query('UPDATE acc_inventory_items SET current_stock=current_stock-? WHERE id=?', [qty, item_id]);

    const [tResult] = await conn.query(
      `INSERT INTO acc_inventory_transactions (item_id, trans_type, trans_date, quantity, direction, unit_cost, total_cost, voucher_id, reference, notes, created_by)
       VALUES (?, 'production', ?, ?, 'out', ?, ?, ?, ?, ?, ?)`,
      [item_id, voucher_date, qty, avgCost, total, null, reference, notes, req.user?.username || 'admin']);
    const transId = tResult.insertId;

    let vId = null, vNo = null;
    if (is_posted) {
      const costSubj = await conn.query("SELECT id FROM acc_subjects WHERE code='5001'");
      const costId = costSubj[0].length ? costSubj[0][0].id : item.subject_id;

      const genVoucherNo = async () => {
        const d = new Date(voucher_date);
        const pf = `记-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        const [rows] = await conn.query(`SELECT voucher_no FROM acc_vouchers WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`, [`${pf}-%`]);
        let seq = rows.length ? parseInt(rows[0].voucher_no.split('-').pop())+1 : 1;
        return `${pf}-${String(seq).padStart(3,'0')}`;
      };
      vNo = await genVoucherNo();

      const [vRes] = await conn.query(
        `INSERT INTO acc_vouchers (voucher_no, voucher_type, voucher_date, description, total_debit, total_credit, created_by, status)
         VALUES (?, '记', ?, ?, ?, ?, ?, 'posted')`,
        [vNo, voucher_date, `生产领用：${item.item_name} ${qty}${item.unit}`, total, total, req.user?.username || 'admin']);
      vId = vRes.insertId;

      await conn.query(
        `INSERT INTO acc_voucher_entries (voucher_id, line_no, subject_id, summary, debit_amount, credit_amount) VALUES (?,1,?,?,?,0),(?,2,?,?,0,?)`,
        [vId, costId, `生产领用：${item.item_name}`, total, vId, item.subject_id, `生产领用：${item.item_name}`, total]);

      await conn.query('UPDATE acc_inventory_transactions SET voucher_id=? WHERE id=?', [vId, transId]);
    }

    await conn.commit();
    await auditLog(req.user?.username, 'stock_out', 'inventory', item_id, item.item_code,
      { quantity: qty, unit_cost: avgCost, total, voucher_id: vId || null });

    success(res, {
      transaction_id: transId, item_code: item.item_code,
      quantity: qty, avg_unit_cost: Number(avgCost.toFixed(4)), total_cost: Number(total.toFixed(2)), voucher_no: vNo
    }, '出库成功');
  } catch (err) {
    await conn.rollback();
    error(res, '出库失败: ' + err.message);
  } finally { conn.release(); }
});

// 存货收发存汇总表
router.get('/inventory/balance', async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = Number(year) || new Date().getFullYear();
    const m = Number(month) || (new Date().getMonth()+1);
    const startDate = `${y}-${String(m).padStart(2,'0')}-01`;
    const endDate = new Date(y, m, 0);
    const endStr = `${y}-${String(m).padStart(2,'0')}-${endDate.getDate()}`;

    const [items] = await db.query(
      `SELECT i.*, s.code as subject_code, s.name as subject_name
       FROM acc_inventory_items i
       LEFT JOIN acc_subjects s ON i.subject_id=s.id WHERE i.is_active=1 ORDER BY i.item_code`);

    const result = [];
    for (const item of items) {
      // 期初 = 截至上月累计
      const [[inBefore]] = await db.query(
        `SELECT COALESCE(SUM(quantity),0) as q, COALESCE(SUM(total_cost),0) as c
         FROM acc_inventory_transactions WHERE item_id=? AND trans_date < ? AND direction='in'`,
        [item.id, startDate]
      );
      const [[outBefore]] = await db.query(
        `SELECT COALESCE(SUM(quantity),0) as q, COALESCE(SUM(total_cost),0) as c
         FROM acc_inventory_transactions WHERE item_id=? AND trans_date < ? AND direction='out'`,
        [item.id, startDate]
      );
      const openingQty = Number(inBefore.q) - Number(outBefore.q);
      const openingAmt = Number(inBefore.c) - Number(outBefore.c);
      const openingPrice = openingQty > 0 ? openingAmt / openingQty : Number(item.unit_price);

      // 本期入库
      const [[inCurr]] = await db.query(
        `SELECT COALESCE(SUM(quantity),0) as q, COALESCE(SUM(total_cost),0) as c
         FROM acc_inventory_transactions WHERE item_id=? AND trans_date BETWEEN ? AND ? AND direction='in'`,
        [item.id, startDate, endStr]
      );
      // 本期出库
      const [[outCurr]] = await db.query(
        `SELECT COALESCE(SUM(quantity),0) as q, COALESCE(SUM(total_cost),0) as c
         FROM acc_inventory_transactions WHERE item_id=? AND trans_date BETWEEN ? AND ? AND direction='out'`,
        [item.id, startDate, endStr]
      );
      const closingQty = openingQty + Number(inCurr.q) - Number(outCurr.q);
      const closingAmt = openingAmt + Number(inCurr.c) - Number(outCurr.c);
      const closingPrice = closingQty > 0 ? closingAmt / closingQty : 0;

      result.push({
        item_code: item.item_code, item_name: item.item_name, unit: item.unit, subject_code: item.subject_code,
        opening: { quantity: Number(openingQty.toFixed(4)), amount: Number(openingAmt.toFixed(2)), unit_price: Number(openingPrice.toFixed(4)) },
        stock_in: { quantity: Number(Number(inCurr.q).toFixed(4)), amount: Number(Number(inCurr.c).toFixed(2)) },
        stock_out: { quantity: Number(Number(outCurr.q).toFixed(4)), amount: Number(Number(outCurr.c).toFixed(2)) },
        closing: { quantity: Number(closingQty.toFixed(4)), amount: Number(closingAmt.toFixed(2)), unit_price: Number(closingPrice.toFixed(4)) }
      });
    }

    success(res, { year: y, month: m, items: result });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});


// ==================== Account Sets (账套管理) ====================

// List all account sets
router.get('/account-sets', async (req, res) => {
  const dbReal = require('../config/database');
  try {
    const [rows] = await dbReal.query("SELECT * FROM acc_account_sets ORDER BY year DESC, id ASC");
    success(res, rows);
  } catch (err) { error(res, err.message); }
});

// Get current account set
router.get('/account-set/current', async (req, res) => {
  const dbReal = require('../config/database');
  try {
    const [[row]] = await dbReal.query("SELECT key_value FROM app_config WHERE key_name='current_account_set_id'");
    const asId = row ? parseInt(row.key_value) || 1 : 1;
    const [[info]] = await dbReal.query("SELECT * FROM acc_account_sets WHERE id=?", [asId]);
    success(res, info || { id: 1, name: 'Default', year: 2026 });
  } catch (err) { error(res, err.message); }
});

// Switch current account set
router.put('/account-set/current', requireRole('admin', 'super_admin'), async (req, res) => {
  const dbReal = require('../config/database');
  try {
    const { id } = req.body;
    if (!id) return error(res, 'Missing account set ID');
    const [[exists]] = await dbReal.query("SELECT id FROM acc_account_sets WHERE id=?", [id]);
    if (!exists) return error(res, 'Account set not found', 404);
    await dbReal.query("UPDATE app_config SET key_value=? WHERE key_name='current_account_set_id'", [String(id)]);
    success(res, { id }, 'Account set switched');
  } catch (err) { error(res, err.message); }
});

// Create account set
router.post('/account-sets', requireRole('admin', 'super_admin'), async (req, res) => {
  const dbReal = require('../config/database');
  try {
    const { name, company, year, start_date, end_date, currency } = req.body;
    if (!name || !year) return error(res, 'Name and year are required');
    const [result] = await dbReal.query(
      "INSERT INTO acc_account_sets (name, company, year, start_date, end_date, currency) VALUES (?,?,?,?,?,?)",
      [name, company||'', year, start_date||`${year}-01-01`, end_date||`${year}-12-31`, currency||'CNY']
    );
    success(res, { id: result.insertId, name, year }, 'Account set created');
  } catch (err) { error(res, err.message); }
});

// Update account set
router.put('/account-sets/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  const dbReal = require('../config/database');
  try {
    const { name, company, year, start_date, end_date, currency, is_active } = req.body;
    const fields = [], params = [];
    if (name !== undefined) { fields.push('name=?'); params.push(name); }
    if (company !== undefined) { fields.push('company=?'); params.push(company); }
    if (year !== undefined) { fields.push('year=?'); params.push(year); }
    if (start_date !== undefined) { fields.push('start_date=?'); params.push(start_date); }
    if (end_date !== undefined) { fields.push('end_date=?'); params.push(end_date); }
    if (currency !== undefined) { fields.push('currency=?'); params.push(currency); }
    if (is_active !== undefined) { fields.push('is_active=?'); params.push(is_active); }
    if (!fields.length) return error(res, 'No fields to update');
    params.push(req.params.id);
    await dbReal.query("UPDATE acc_account_sets SET " + fields.join(',') + " WHERE id=?", params);
    success(res, null, 'Account set updated');
  } catch (err) { error(res, err.message); }
});

// Delete account set
router.delete('/account-sets/:id', requireRole('super_admin'), async (req, res) => {
  const dbReal = require('../config/database');
  try {
    const { id } = req.params;
    if (id == 1) return error(res, 'Cannot delete default account set');
    const [[cnt]] = await dbReal.query("SELECT COUNT(*) as c FROM acc_vouchers WHERE account_set_id=?", [id]);
    if (cnt.c > 0) return error(res, 'Account set has vouchers, cannot delete');
    await dbReal.query("DELETE FROM acc_account_sets WHERE id=?", [id]);
    success(res, null, 'Account set deleted');
  } catch (err) { error(res, err.message); }
});

// ==================== AR/AP 应收应付 ====================

// AR/AP 汇总看板
router.get('/arap/summary', async (req, res) => {
  try {
    const arCodes = ["'1122'","'1123'"];
    const apCodes = ["'2202'","'2203'"];
    
    const [arRows] = await db.query(`
      SELECT COALESCE(SUM(e.debit_amount),0) as total_ar,
             COALESCE(SUM(e.credit_amount),0) as total_ar_paid
      FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
      JOIN acc_subjects s ON e.subject_id=s.id
      WHERE s.code IN (${arCodes.join(',')}) AND (e.debit_amount>0 OR e.credit_amount>0)
    `);
    
    const [apRows] = await db.query(`
      SELECT COALESCE(SUM(e.credit_amount),0) as total_ap,
             COALESCE(SUM(e.debit_amount),0) as total_ap_paid
      FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
      JOIN acc_subjects s ON e.subject_id=s.id
      WHERE s.code IN (${apCodes.join(',')}) AND (e.debit_amount>0 OR e.credit_amount>0)
    `);
    
    const [reconAR] = await db.query(`SELECT COALESCE(SUM(ri.amount),0) as reconciled FROM acc_reconciliation_items ri JOIN acc_reconciliations r ON ri.recon_id=r.id WHERE r.recon_type='ar' AND r.status!='cancelled'`);
    const [reconAP] = await db.query(`SELECT COALESCE(SUM(ri.amount),0) as reconciled FROM acc_reconciliation_items ri JOIN acc_reconciliations r ON ri.recon_id=r.id WHERE r.recon_type='ap' AND r.status!='cancelled'`);
    
    // Customer/supplier count
    const [custs] = await db.query(`SELECT COUNT(*) as cnt FROM acc_auxiliary_items WHERE type_id=1 AND is_active=1`);
    const [supps] = await db.query(`SELECT COUNT(*) as cnt FROM acc_auxiliary_items WHERE type_id=2 AND is_active=1`);
    
    const arBalance = Number(arRows[0].total_ar) - Number(arRows[0].total_ar_paid);
    const apBalance = Number(apRows[0].total_ap) - Number(apRows[0].total_ap_paid);
    
    success(res, {
      ar: { balance: Number(arBalance.toFixed(2)), total: arRows[0].total_ar, paid: arRows[0].total_ar_paid, reconciled: reconAR[0].reconciled || 0 },
      ap: { balance: Number(apBalance.toFixed(2)), total: apRows[0].total_ap, paid: apRows[0].total_ap_paid, reconciled: reconAP[0].reconciled || 0 },
      net_position: Number((arBalance - apBalance).toFixed(2)),
      customer_count: custs[0].cnt,
      supplier_count: supps[0].cnt
    });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

// AR/AP 账龄分析
router.get('/arap/aging', async (req, res) => {
  try {
    const { type, as_of } = req.query;
    if (!type || !['ar','ap'].includes(type)) return error(res, 'type必须为ar或ap', 400);
    
    const codes = type==='ar' ? ["'1122'","'1123'"] : ["'2202'","'2203'"];
    const asOfDate = as_of || new Date().toISOString().split('T')[0];
    
    // 已核销的分录
    const [reconciled] = await db.query(
      `SELECT DISTINCT ri.entry_id FROM acc_reconciliation_items ri
       JOIN acc_reconciliations r ON ri.recon_id=r.id
       WHERE r.recon_type=? AND r.status!='cancelled'`, [type]);
    const reconciledIds = reconciled.map(r => r.entry_id);
    
    // Step 1: query entries with explicit account_set_id to prevent wrapper injection collision
    const [rows] = await db.query(`
      SELECT e.id, e.voucher_id, e.subject_id, e.debit_amount, e.credit_amount, e.summary,
             v.voucher_no, v.voucher_date, v.description,
             s.code as subject_code, s.name as subject_name,
             DATEDIFF(?, v.voucher_date) as age_days
      FROM acc_voucher_entries e
      JOIN acc_vouchers v ON e.voucher_id=v.id AND v.status='posted'
      JOIN acc_subjects s ON e.subject_id=s.id
      WHERE e.account_set_id = 1 AND s.code IN (${codes.join(',')}) AND (e.debit_amount>0 OR e.credit_amount>0)
      ORDER BY v.voucher_date
    `, [asOfDate]);
    
    // Step 2: batch-load auxiliary items (avoids LEFT JOIN filter collision)
    const auxMap = {};
    const entryIds = rows.map(r => r.id);
    if (entryIds.length > 0) {
      const placeholders = entryIds.map(() => '?').join(',');
      const [auxRows] = await db.query(
        `SELECT ea.entry_id, ai.name as party_name, ai.code as party_code
         FROM acc_entry_auxiliary ea
         JOIN acc_auxiliary_items ai ON ea.aux_item_id=ai.id
         WHERE ea.entry_id IN (${placeholders})`,
        entryIds
      );
      for (const a of auxRows) {
        if (!auxMap[a.entry_id]) auxMap[a.entry_id] = [];
        auxMap[a.entry_id].push({ party_name: a.party_name, party_code: a.party_code });
      }
    }

    // Step 3: filter reconciled
    const outstanding = rows.filter(r => !reconciledIds.includes(r.id));
    
    // 按账龄分组
    const buckets = {
      'current': { label: '1-30天', min:0, max:30, items:[], total:0 },
      '31-60': { label: '31-60天', min:31, max:60, items:[], total:0 },
      '61-90': { label: '61-90天', min:61, max:90, items:[], total:0 },
      '91-180': { label: '91-180天', min:91, max:180, items:[], total:0 },
      '181-365': { label: '181-365天', min:181, max:365, items:[], total:0 },
      '365+': { label: '1年以上', min:366, max:99999, items:[], total:0 }
    };
    
    for (const row of outstanding) {
      const days = row.age_days;
      const net = type==='ar'
        ? Number(row.debit_amount) - Number(row.credit_amount)
        : Number(row.credit_amount) - Number(row.debit_amount);
      
      let bucket = '365+';
      if (days <= 30) bucket = 'current';
      else if (days <= 60) bucket = '31-60';
      else if (days <= 90) bucket = '61-90';
      else if (days <= 180) bucket = '91-180';
      else if (days <= 365) bucket = '181-365';
      
      const aux = auxMap[row.id] || [];
      buckets[bucket].items.push({...row, net: Number(net.toFixed(2)), party_name: aux.map(a=>a.party_name).join(', '), party_code: aux.map(a=>a.party_code).join(', ')});
      buckets[bucket].total += net;
    }
    
    for (const key of Object.keys(buckets)) {
      buckets[key].total = Number(buckets[key].total.toFixed(2));
      buckets[key].count = buckets[key].items.length;
    }
    
    const grandTotal = Object.values(buckets).reduce((s,b)=>s+b.total,0);
    
    success(res, {
      type, as_of: asOfDate,
      buckets,
      summary: { total_outstanding: outstanding.length, grand_total: Number(grandTotal.toFixed(2)) }
    });
  } catch (err) { error(res, '查询失败: ' + err.message); }
});

module.exports = router;


// ======== Admin Management Routes ========
// GET /admins - list users (admin+)
router.get('/admins', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, username, role, created_at, last_login FROM admins ORDER BY id'
    );
    res.json({ code: 0, data: rows });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// POST /admins - create user (admin+)
router.post('/admins', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.json({ code: 400, message: '用户名和密码不能为空' });
    }
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    await db.execute(
      'INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)',
      [username, hash, role || 'viewer']
    );
    res.json({ code: 0, message: '用户创建成功' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.json({ code: 400, message: '用户名已存在' });
    }
    res.status(500).json({ code: 500, message: err.message });
  }
});

// PUT /admins/:id - update user (admin+)
router.put('/admins/:id', requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!role) return res.json({ code: 400, message: '角色不能为空' });
    await db.execute('UPDATE admins SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ code: 0, message: '更新成功' });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// DELETE /admins/:id - delete user (super_admin only)
router.delete('/admins/:id', requireRole('super_admin'), async (req, res) => {
  try {
    if (req.params.id == req.user.id) {
      return res.json({ code: 400, message: '不能删除自己' });
    }
    await db.execute('DELETE FROM admins WHERE id = ?', [req.params.id]);
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// PUT /me/password - change own password
router.put('/me/password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.json({ code: 400, message: '新旧密码不能为空' });
    }
    const bcrypt = require('bcryptjs');
    const [rows] = await db.execute('SELECT password_hash FROM admins WHERE id = ?', [req.user.id]);
    const valid = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!valid) return res.json({ code: 400, message: '旧密码错误' });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    res.json({ code: 0, message: '密码修改成功' });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// GET /me - current user info
router.get('/me', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT id, username, role, created_at, last_login FROM admins WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) return res.json({ code: 404, message: '用户不存在' });
    res.json({ code: 0, data: rows[0] });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});
