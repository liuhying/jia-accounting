const express = require('express');
const router = express.Router();
const db = require('../config/database');
const auth = require('../middleware/auth');
const { success, error } = require('../utils/response');

router.use(auth);

// ==================== 税务设置 ====================

router.get('/settings', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, tax_key, tax_name, rate, category, sort_order, remark FROM acc_tax_settings WHERE is_active=1 ORDER BY sort_order'
    );
    success(res, rows);
  } catch (err) { error(res, '查询税务设置失败: ' + err.message); }
});

router.put('/settings/:id', async (req, res) => {
  try {
    const { rate, is_active, remark } = req.body;
    const fields = [], params = [];
    if (rate !== undefined) { fields.push('rate = ?'); params.push(rate); }
    if (is_active !== undefined) { fields.push('is_active = ?'); params.push(is_active); }
    if (remark !== undefined) { fields.push('remark = ?'); params.push(remark); }
    if (fields.length === 0) return error(res, '无更新内容', 400);
    params.push(req.params.id);
    await db.query(`UPDATE acc_tax_settings SET ${fields.join(', ')} WHERE id = ?`, params);
    success(res, null, '税率已更新');
  } catch (err) { error(res, '更新税率失败: ' + err.message); }
});

// ==================== 核心：从交易数据计算税额 ====================

// 获取期间的收入/支出按科目汇总
async function getSubjectSummary(year, month) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // 本月最后一天
  const endDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;

  // 从凭证分录取数：收入 = 收入类科目贷方，成本/费用 = 成本费用类科目借方
  // 注：acc_voucher_entries 无 is_tax_deductible 字段，暂将所有成本/费用均视为可抵扣
  const [rows] = await db.query(`
    SELECT
      s.id AS subject_id,
      s.code,
      s.name,
      s.type AS subject_type,
      s.direction,
      COALESCE(SUM(CASE WHEN s.type = 'revenue' THEN e.credit_amount ELSE 0 END), 0) AS income_amount,
      COALESCE(SUM(CASE WHEN s.type IN ('cost', 'expense') THEN e.debit_amount ELSE 0 END), 0) AS expense_amount,
      COALESCE(SUM(CASE WHEN s.type IN ('cost', 'expense') THEN e.debit_amount ELSE 0 END), 0) AS deductible_amount,
      COUNT(CASE WHEN s.type IN ('cost', 'expense') THEN 1 END) AS deductible_count
    FROM acc_subjects s
    INNER JOIN acc_voucher_entries e ON s.id = e.subject_id
    INNER JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
    WHERE v.voucher_date BETWEEN ? AND ? AND s.is_active = 1 AND s.type IN ('revenue', 'cost', 'expense')
    GROUP BY s.id, s.code, s.name, s.type, s.direction
    HAVING income_amount > 0 OR expense_amount > 0
  `, [startDate, endDate]);
  return rows;
}

// ==================== 增值税计算 ====================

router.get('/vat', async (req, res) => {
  try {
    const { year = new Date().getFullYear(), month = new Date().getMonth() + 1, taxpayer = 'general' } = req.query;
    const y = Number(year), m = Number(month);

    // 获取税率设置
    const [settings] = await db.query(
      `SELECT tax_key, rate FROM acc_tax_settings WHERE category='vat' AND is_active=1`
    );
    const rates = {};
    settings.forEach(s => rates[s.tax_key] = s.rate);

    // 如果是小规模纳税人，直接用征收率
    if (taxpayer === 'small') {
      const subjectSummary = await getSubjectSummary(y, m);
      const totalIncome = subjectSummary.reduce((sum, s) => sum + Number(s.income_amount), 0);
      const outputVat = totalIncome * (rates.vat_small_output || 0.03);

      // 小规模纳税人的附加税
      const surtaxRates = await getSurtaxRates();
      const surtaxDetails = computeSurtaxes(outputVat, surtaxRates);

      return success(res, {
        period: `${y}-${String(m).padStart(2, '0')}`,
        taxpayer_type: 'small',
        total_income: Number(totalIncome.toFixed(2)),
        output_vat: Number(outputVat.toFixed(2)),
        input_vat: 0,
        input_vat_detail: '小规模纳税人不可抵扣进项税额',
        vat_payable: Number(outputVat.toFixed(2)),
        surtax: surtaxDetails,
        total_tax: Number((outputVat + surtaxDetails.total).toFixed(2)),
        subjects_breakdown: subjectSummary.map(s => ({
          code: s.code, name: s.name,
          income: Number(s.income_amount),
          expense: Number(s.expense_amount),
          deductible: Number(s.deductible_amount)
        }))
      });
    }

    // 一般纳税人：分税率计算销项税
    const subjectSummary = await getSubjectSummary(y, m);

    let outputVat = 0, inputVat = 0;
    const outputDetail = [], inputDetail = [];

    for (const s of subjectSummary) {
      const income = Number(s.income_amount);
      const deductible = Number(s.deductible_amount);
      if (income > 0) {
        // 近似：按科目类型推测税率（后续可配科目级税率）
        const rate = guessVatRate(s.code, s.name, 'output', rates);
        const tax = income * rate;
        outputVat += tax;
        outputDetail.push({ code: s.code, name: s.name, amount: income, rate, tax: Number(tax.toFixed(2)) });
      }
      if (deductible > 0) {
        const rate = guessVatRate(s.code, s.name, 'input', rates);
        const tax = deductible * rate;
        inputVat += tax;
        inputDetail.push({ code: s.code, name: s.name, amount: deductible, rate, tax: Number(tax.toFixed(2)) });
      }
    }

    // 一般纳税人的附加税
    const vatPayable = Math.max(0, outputVat - inputVat);
    const surtaxRates = await getSurtaxRates();
    const surtaxDetails = computeSurtaxes(vatPayable, surtaxRates);

    success(res, {
      period: `${y}-${String(m).padStart(2, '0')}`,
      taxpayer_type: 'general',
      output_vat: Number(outputVat.toFixed(2)),
      output_detail: outputDetail,
      input_vat: Number(inputVat.toFixed(2)),
      input_detail: inputDetail,
      vat_payable: Number(vatPayable.toFixed(2)),
      surtax: surtaxDetails,
      total_tax: Number((vatPayable + surtaxDetails.total).toFixed(2)),
      summary: {
        total_income: Number(subjectSummary.reduce((s, r) => s + Number(r.income_amount), 0).toFixed(2)),
        total_expense: Number(subjectSummary.reduce((s, r) => s + Number(r.expense_amount), 0).toFixed(2)),
        total_deductible: Number(subjectSummary.reduce((s, r) => s + Number(r.deductible_amount), 0).toFixed(2)),
        subject_count: subjectSummary.length
      }
    });
  } catch (err) { error(res, '增值税计算失败: ' + err.message); }
});

// 根据科目代码/名称推测适用增值税税率
function guessVatRate(code, name, ioType, rates) {
  const codeStr = String(code);
  const nameStr = name || '';

  // 服务类科目 (5xxx, 6xxx 开头) → 6%
  if (/^5|^6/.test(codeStr)) return rates.vat_output_6 || 0.06;
  // 销售类科目 (6001 → 13%)
  if (nameStr.includes('销售') || nameStr.includes('产品')) return rates.vat_output_std || 0.13;
  // 运费/交通运输 → 9%
  if (nameStr.includes('运费') || nameStr.includes('交通') || nameStr.includes('运输')) return rates.vat_output_9 || 0.09;
  // 房租/不动产 → 9%
  if (nameStr.includes('房租') || nameStr.includes('租赁') || nameStr.includes('不动产')) return rates.vat_output_9 || 0.09;
  // 农产品 → 9%
  if (nameStr.includes('农产品') || nameStr.includes('粮食')) return rates.vat_output_9 || 0.09;
  // 餐饮/招待 → 6%
  if (nameStr.includes('餐饮') || nameStr.includes('招待') || nameStr.includes('住宿')) return rates.vat_output_6 || 0.06;
  // 贷款/利息 → 6%
  if (nameStr.includes('贷款') || nameStr.includes('利息') || nameStr.includes('金融')) return rates.vat_output_6 || 0.06;
  // 固定资产 → 13%
  if (nameStr.includes('设备') || nameStr.includes('固定') || nameStr.includes('不动产')) return rates.vat_output_std || 0.13;
  // 办公用品 → 13%
  if (nameStr.includes('办公')) return rates.vat_output_std || 0.13;

  // 非经营类科目（资产/负债/权益）不计增值税
  if (!/^[56]/.test(codeStr)) return 0;
  // 默认标准税率（仅成本类5xxx/损益类6xxx）
  return rates.vat_output_std || 0.13;
}

// ==================== 附加税计算 ====================

async function getSurtaxRates() {
  const [rows] = await db.query(
    `SELECT tax_key, rate FROM acc_tax_settings WHERE category='surtax' AND is_active=1`
  );
  const rates = {};
  rows.forEach(r => rates[r.tax_key] = Number(r.rate));
  return rates;
}

function computeSurtaxes(vatAmount, rates) {
  const urban = vatAmount * (rates.urban_maintenance || 0.07);
  const education = vatAmount * (rates.education_surcharge || 0.03);
  const local = vatAmount * (rates.local_education || 0.02);
  return {
    urban_maintenance: { name: '城市维护建设税', rate: rates.urban_maintenance || 0.07, amount: Number(urban.toFixed(2)) },
    education_surcharge: { name: '教育费附加', rate: rates.education_surcharge || 0.03, amount: Number(education.toFixed(2)) },
    local_education: { name: '地方教育附加', rate: rates.local_education || 0.02, amount: Number(local.toFixed(2)) },
    total: Number((urban + education + local).toFixed(2))
  };
}

// ==================== 企业所得税预缴 ====================

router.get('/cit', async (req, res) => {
  try {
    const { year = new Date().getFullYear(), quarter } = req.query;
    const y = Number(year), q = Number(quarter) || Math.ceil((new Date().getMonth() + 1) / 3);

    // 计算季度起止日期
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const startDate = `${y}-${String(startMonth).padStart(2, '0')}-01`;
    const endDay = new Date(y, endMonth, 0).getDate();
    const endDate = `${y}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;

    // YTD 开始日期（1月1日）
    const ytdStart = `${y}-01-01`;

    // 1. 期间内收入、成本、费用汇总（从凭证分录取数）
    const [periodRows] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN s.type = 'revenue' THEN e.credit_amount ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN s.type = 'cost' THEN e.debit_amount ELSE 0 END), 0) AS cost,
        COALESCE(SUM(CASE WHEN s.type NOT IN ('revenue', 'cost', 'tax') THEN e.debit_amount ELSE 0 END), 0) AS expense
      FROM acc_voucher_entries e
      INNER JOIN acc_subjects s ON e.subject_id = s.id
      INNER JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
      WHERE v.voucher_date BETWEEN ? AND ?
    `, [startDate, endDate]);
    const p = periodRows[0];

    // 2. 累计利润（全年至今，从凭证分录取数）
    const [ytdRows] = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN s.type = 'revenue' THEN e.credit_amount ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN s.type NOT IN ('revenue') THEN e.debit_amount ELSE 0 END), 0) AS ytd_profit
      FROM acc_voucher_entries e
      INNER JOIN acc_subjects s ON e.subject_id = s.id
      INNER JOIN acc_vouchers v ON e.voucher_id = v.id AND v.status = 'posted'
      WHERE v.voucher_date BETWEEN ? AND ?
    `, [ytdStart, endDate]);

    const revenue = Number(p.revenue || 0);
    const cost = Number(p.cost || 0);
    const expense = Number(p.expense || 0);
    const periodProfit = revenue - cost - expense;
    const ytdProfit = Number(ytdRows[0].ytd_profit || 0);

    // 3. 获取企业所得税税率
    const [rateRows] = await db.query(
      `SELECT rate FROM acc_tax_settings WHERE tax_key='cit_rate' AND is_active=1`
    );
    const citRate = rateRows.length > 0 ? Number(rateRows[0].rate) : 0.25;

    // 小微企业优惠：利润 ≤ 300 万 → 分段优惠
    let effectiveRate = citRate;
    let taxReduction = 0;
    if (ytdProfit <= 1000000) {
      effectiveRate = 0.025; // 实际2.5%
      taxReduction = ytdProfit * (citRate - effectiveRate);
    } else if (ytdProfit <= 3000000) {
      // 100万内 2.5%，100-300 万 5%
      const tier1 = 1000000 * 0.025;
      const tier2 = (ytdProfit - 1000000) * 0.05;
      const standardTax = ytdProfit * citRate;
      effectiveRate = (tier1 + tier2) / ytdProfit;
      taxReduction = standardTax - tier1 - tier2;
    }

    const citPayable = ytdProfit * effectiveRate;

    success(res, {
      period: `${y}-Q${q}`,
      period_range: `${startDate} ~ ${endDate}`,
      revenue: Number(revenue.toFixed(2)),
      cost: Number(cost.toFixed(2)),
      expense: Number(expense.toFixed(2)),
      period_profit: Number(periodProfit.toFixed(2)),
      ytd_profit: Number(ytdProfit.toFixed(2)),
      tax_rate: citRate,
      effective_rate: Number(effectiveRate.toFixed(4)),
      tax_reduction: Number(taxReduction.toFixed(2)),
      cit_payable: Number(citPayable.toFixed(2)),
      is_small_micro: ytdProfit <= 3000000 && revenue <= 50000000  // 小微企业判断
    });
  } catch (err) { error(res, '企业所得税计算失败: ' + err.message); }
});

// ==================== 附加税独立查询 ====================

router.get('/surtax', async (req, res) => {
  try {
    const { year = new Date().getFullYear(), month = new Date().getMonth() + 1 } = req.query;
    const y = Number(year), m = Number(month);

    // 先算增值税（小规模或一般纳税人）
    const [settings] = await db.query(`SELECT tax_key, rate FROM acc_tax_settings WHERE category='vat' AND is_active=1`);
    const rates = {};
    settings.forEach(s => rates[s.tax_key] = s.rate);

    const subjectSummary = await getSubjectSummary(y, m);
    const totalIncome = subjectSummary.reduce((sum, s) => sum + Number(s.income_amount), 0);

    let outputVat = totalIncome * (rates.vat_small_output || 0.03);
    let inputVat = 0;

    // 若有进项抵扣数据则按一般纳税人算
    const totalDeductible = subjectSummary.reduce((sum, s) => sum + Number(s.deductible_amount), 0);
    if (totalDeductible > 0) {
      outputVat = 0;
      for (const s of subjectSummary) {
        const income = Number(s.income_amount);
        if (income > 0) {
          const rate = guessVatRate(s.code, s.name, 'output', rates);
          outputVat += income * rate;
        }
      }
      inputVat = totalDeductible * (rates.vat_input_std || 0.13);
    }

    const vatPayable = Math.max(0, outputVat - inputVat);
    const surtaxRates = await getSurtaxRates();
    const surtaxDetails = computeSurtaxes(vatPayable, surtaxRates);

    success(res, {
      period: `${y}-${String(m).padStart(2, '0')}`,
      vat_payable: Number(vatPayable.toFixed(2)),
      surtax: surtaxDetails,
      // 印花税：按购销金额（收入 + 可抵扣支出）
      stamp_duty: {
        name: '印花税（购销合同）',
        base: Number((totalIncome + totalDeductible).toFixed(2)),
        rate: surtaxRates.stamp_duty || 0.0003,
        amount: Number(((totalIncome + totalDeductible) * (surtaxRates.stamp_duty || 0.0003)).toFixed(2))
      }
    });
  } catch (err) { error(res, '附加税计算失败: ' + err.message); }
});

// ==================== 综合纳税汇总表 ====================

router.get('/summary', async (req, res) => {
  try {
    const { year = new Date().getFullYear(), month = new Date().getMonth() + 1 } = req.query;
    const y = Number(year), m = Number(month);

    const [settings] = await db.query(`SELECT tax_key, rate FROM acc_tax_settings WHERE category='vat' AND is_active=1`);
    const rates = {};
    settings.forEach(s => rates[s.tax_key] = s.rate);

    const subjectSummary = await getSubjectSummary(y, m);
    const totalIncome = subjectSummary.reduce((sum, s) => sum + Number(s.income_amount), 0);
    const totalDeductible = subjectSummary.reduce((sum, s) => sum + Number(s.deductible_amount), 0);

    // 增值税（按小规模简化，有可抵扣时按一般纳税人）
    let outputVat = 0, inputVat = 0;
    if (totalDeductible > 0) {
      for (const s of subjectSummary) {
        const income = Number(s.income_amount);
        if (income > 0) outputVat += income * guessVatRate(s.code, s.name, 'output', rates);
      }
      inputVat = totalDeductible * (rates.vat_input_std || 0.13);
    } else {
      outputVat = totalIncome * (rates.vat_small_output || 0.03);
    }

    const vatPayable = Math.max(0, outputVat - inputVat);
    const surtaxRates = await getSurtaxRates();
    const surtaxDetails = computeSurtaxes(vatPayable, surtaxRates);

    // 季度判断
    const q = Math.ceil(m / 3);

    success(res, {
      period: `${y}-${String(m).padStart(2, '0')}`,
      generated_at: new Date().toISOString(),
      taxes: [
        {
          name: '增值税',
          type: 'vat',
          period: '月度',
          payable: Number(vatPayable.toFixed(2)),
          detail: {
            output_vat: Number(outputVat.toFixed(2)),
            input_vat: Number(inputVat.toFixed(2)),
            taxable_income: Number(totalIncome.toFixed(2))
          }
        },
        {
          name: '城市维护建设税',
          type: 'surtax',
          period: '月度',
          payable: surtaxDetails.urban_maintenance.amount,
          rate: surtaxDetails.urban_maintenance.rate
        },
        {
          name: '教育费附加',
          type: 'surtax',
          period: '月度',
          payable: surtaxDetails.education_surcharge.amount,
          rate: surtaxDetails.education_surcharge.rate
        },
        {
          name: '地方教育附加',
          type: 'surtax',
          period: '月度',
          payable: surtaxDetails.local_education.amount,
          rate: surtaxDetails.local_education.rate
        },
        {
          name: '企业所得税',
          type: 'cit',
          period: `季度(Q${q})`,
          payable: '详见 /cit 接口（基于全年累计利润计算）',
          rate: rates.cit_rate || 0.25
        }
      ],
      total_payable: Number((vatPayable + surtaxDetails.total).toFixed(2)),
      reminder: '企业所得税按季度预缴，请在季末调用 /cit 接口获取准确数据',
      export_hint: '调用 /tax/export?year=&month= 可导出税务局申报格式'
    });
  } catch (err) { error(res, '汇总失败: ' + err.message); }
});

// ==================== 导出（电子税务局兼容格式） ====================

router.get('/export', async (req, res) => {
  try {
    const { year = new Date().getFullYear(), month = new Date().getMonth() + 1, format = 'csv' } = req.query;
    const y = Number(year), m = Number(month);

    // 计算所有税种
    const [settings] = await db.query(`SELECT tax_key, rate FROM acc_tax_settings WHERE category='vat' AND is_active=1`);
    const rates = {};
    settings.forEach(s => rates[s.tax_key] = s.rate);

    const subjectSummary = await getSubjectSummary(y, m);
    const totalIncome = subjectSummary.reduce((sum, s) => sum + Number(s.income_amount), 0);
    const totalDeductible = subjectSummary.reduce((sum, s) => sum + Number(s.deductible_amount), 0);

    let outputVat = totalIncome * (rates.vat_small_output || 0.03);
    if (totalDeductible > 0) {
      outputVat = 0;
      for (const s of subjectSummary) {
        const income = Number(s.income_amount);
        if (income > 0) outputVat += income * guessVatRate(s.code, s.name, 'output', rates);
      }
    }
    const vatPayable = Math.max(0, outputVat - totalDeductible * (rates.vat_input_std || 0.13));
    const surtaxRates = await getSurtaxRates();
    const surtaxDetails = computeSurtaxes(vatPayable, surtaxRates);

    if (format === 'json') {
      return success(res, {
        period: `${y}-${String(m).padStart(2, '0')}`,
        vat: { output: Number(outputVat.toFixed(2)), input: Number((totalDeductible * (rates.vat_input_std || 0.13)).toFixed(2)), payable: Number(vatPayable.toFixed(2)) },
        surtax: surtaxDetails,
        stamp: { amount: Number(((totalIncome + totalDeductible) * (surtaxRates.stamp_duty || 0.0003)).toFixed(2)) }
      });
    }

    // CSV 格式 —— 电子税务局申报导入兼容
    const BOM = '\uFEFF';
    const period = `${y}年${m}月`;
    let csv = BOM + '税种,税款所属期,计税依据,税率,应纳税额,实缴税额\n';
    csv += `增值税,${period},${totalIncome.toFixed(2)},${(rates.vat_small_output || 0.03) * 100}%,${vatPayable.toFixed(2)},${vatPayable.toFixed(2)}\n`;
    csv += `城市维护建设税,${period},${vatPayable.toFixed(2)},${(surtaxRates.urban_maintenance || 0.07) * 100}%,${surtaxDetails.urban_maintenance.amount.toFixed(2)},${surtaxDetails.urban_maintenance.amount.toFixed(2)}\n`;
    csv += `教育费附加,${period},${vatPayable.toFixed(2)},${(surtaxRates.education_surcharge || 0.03) * 100}%,${surtaxDetails.education_surcharge.amount.toFixed(2)},${surtaxDetails.education_surcharge.amount.toFixed(2)}\n`;
    csv += `地方教育附加,${period},${vatPayable.toFixed(2)},${(surtaxRates.local_education || 0.02) * 100}%,${surtaxDetails.local_education.amount.toFixed(2)},${surtaxDetails.local_education.amount.toFixed(2)}\n`;
    csv += `印花税,${period},${(totalIncome + totalDeductible).toFixed(2)},${(surtaxRates.stamp_duty || 0.0003) * 100}%,${((totalIncome + totalDeductible) * (surtaxRates.stamp_duty || 0.0003)).toFixed(2)},${((totalIncome + totalDeductible) * (surtaxRates.stamp_duty || 0.0003)).toFixed(2)}\n`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tax_${y}${String(m).padStart(2,'0')}.csv"`);
    res.send(csv);
  } catch (err) { error(res, '导出失败: ' + err.message); }
});

module.exports = router;
