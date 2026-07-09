-- ============================================
-- 家记账 - 会计核心表 DDL
-- 表数: 27 | 字符集: utf8mb4
-- ============================================

-- 1. 会计科目表
CREATE TABLE IF NOT EXISTS acc_subjects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1 COMMENT '账套ID',
  code VARCHAR(16) NOT NULL COMMENT '科目编码',
  name VARCHAR(64) NOT NULL COMMENT '科目名称',
  type VARCHAR(16) NOT NULL COMMENT '类别: asset/liability/equity/cost/revenue/expense',
  parent_id INT DEFAULT NULL COMMENT '父科目ID',
  direction VARCHAR(8) NOT NULL DEFAULT 'debit' COMMENT '余额方向: debit/credit',
  is_active TINYINT(1) DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_code (code),
  KEY idx_parent (parent_id),
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 凭证主表
CREATE TABLE IF NOT EXISTS acc_vouchers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1 COMMENT '账套ID',
  voucher_no VARCHAR(32) NOT NULL COMMENT '凭证号',
  voucher_type ENUM('记','收','付','转') NOT NULL DEFAULT '记' COMMENT '凭证类型',
  currency_id INT DEFAULT 1,
  voucher_date DATE NOT NULL COMMENT '凭证日期',
  description VARCHAR(500) DEFAULT '' COMMENT '摘要',
  attachments INT DEFAULT 0 COMMENT '附件数',
  status ENUM('draft','audited','posted','reversed') NOT NULL DEFAULT 'draft' COMMENT '状态',
  total_debit DECIMAL(14,2) DEFAULT 0.00,
  total_credit DECIMAL(14,2) DEFAULT 0.00,
  created_by INT DEFAULT NULL,
  audited_by INT DEFAULT NULL,
  posted_by INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_voucher_no (voucher_no),
  KEY idx_date (voucher_date),
  KEY idx_status (status),
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. 凭证分录
CREATE TABLE IF NOT EXISTS acc_voucher_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1 COMMENT '账套ID',
  voucher_id INT NOT NULL,
  subject_id INT NOT NULL,
  line_no INT DEFAULT 1 COMMENT '行号',
  summary VARCHAR(500) DEFAULT '' COMMENT '摘要',
  debit_amount DECIMAL(14,2) DEFAULT 0.00,
  credit_amount DECIMAL(14,2) DEFAULT 0.00,
  currency_id INT DEFAULT 1,
  origin_debit DECIMAL(14,2) DEFAULT 0.00,
  origin_credit DECIMAL(14,2) DEFAULT 0.00,
  exchange_rate DECIMAL(10,6) DEFAULT 1.000000,
  FOREIGN KEY (voucher_id) REFERENCES acc_vouchers(id) ON DELETE CASCADE,
  KEY idx_subject (subject_id),
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. 账套
CREATE TABLE IF NOT EXISTS acc_account_sets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL COMMENT '账套名称',
  company VARCHAR(128) DEFAULT '' COMMENT '公司名称',
  year INT NOT NULL COMMENT '会计年度',
  start_date DATE NOT NULL COMMENT '启账日期',
  end_date DATE NOT NULL COMMENT '结账日期',
  currency VARCHAR(8) DEFAULT 'CNY' COMMENT '本位币',
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. 辅助核算类型
CREATE TABLE IF NOT EXISTS acc_auxiliary_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  name VARCHAR(32) NOT NULL COMMENT '类型名: 客户/供应商/项目/部门',
  code VARCHAR(16) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. 辅助核算项目
CREATE TABLE IF NOT EXISTS acc_auxiliary_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  type_id INT NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (type_id) REFERENCES acc_auxiliary_types(id) ON DELETE CASCADE,
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. 分录辅助核算关联
CREATE TABLE IF NOT EXISTS acc_entry_auxiliary (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_id INT NOT NULL,
  aux_type_id INT NOT NULL,
  aux_item_id INT NOT NULL,
  FOREIGN KEY (entry_id) REFERENCES acc_voucher_entries(id) ON DELETE CASCADE,
  KEY idx_aux_item (aux_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. 期末结转
CREATE TABLE IF NOT EXISTS acc_period_closes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  period_year INT NOT NULL,
  period_month INT NOT NULL,
  voucher_id INT DEFAULT NULL,
  closed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by INT DEFAULT NULL,
  FOREIGN KEY (voucher_id) REFERENCES acc_vouchers(id),
  UNIQUE KEY uk_period (account_set_id, period_year, period_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. 固定资产
CREATE TABLE IF NOT EXISTS acc_fixed_assets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  name VARCHAR(128) NOT NULL COMMENT '资产名称',
  code VARCHAR(32) DEFAULT '' COMMENT '资产编码',
  category VARCHAR(32) DEFAULT '' COMMENT '类别',
  purchase_date DATE COMMENT '购入日期',
  purchase_amount DECIMAL(14,2) NOT NULL COMMENT '原值',
  residual_rate DECIMAL(5,4) DEFAULT 0.0500 COMMENT '残值率',
  useful_life_months INT NOT NULL COMMENT '使用月数',
  monthly_depreciation DECIMAL(14,2) DEFAULT 0.00,
  accumulated_depreciation DECIMAL(14,2) DEFAULT 0.00 COMMENT '累计折旧',
  net_value DECIMAL(14,2) DEFAULT 0.00 COMMENT '净值',
  status ENUM('in_use','idle','scrapped') DEFAULT 'in_use',
  subject_id INT DEFAULT NULL COMMENT '资产科目',
  depreciation_subject_id INT DEFAULT NULL COMMENT '折旧科目',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. 折旧记录
CREATE TABLE IF NOT EXISTS acc_depreciation_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  asset_id INT NOT NULL,
  period_year INT NOT NULL,
  period_month INT NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  voucher_id INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (asset_id) REFERENCES acc_fixed_assets(id),
  UNIQUE KEY uk_asset_period (asset_id, period_year, period_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. 存货
CREATE TABLE IF NOT EXISTS acc_inventory_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  code VARCHAR(32) NOT NULL COMMENT '存货编码',
  name VARCHAR(128) NOT NULL COMMENT '存货名称',
  category VARCHAR(32) DEFAULT '' COMMENT '分类',
  unit VARCHAR(16) DEFAULT '个' COMMENT '单位',
  spec VARCHAR(64) DEFAULT '' COMMENT '规格',
  current_qty DECIMAL(14,4) DEFAULT 0 COMMENT '当前数量',
  avg_cost DECIMAL(14,4) DEFAULT 0 COMMENT '加权平均成本',
  total_amount DECIMAL(14,2) DEFAULT 0 COMMENT '总金额',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_code (code),
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 12. 存货交易
CREATE TABLE IF NOT EXISTS acc_inventory_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  item_id INT NOT NULL,
  type ENUM('in','out','adjust') NOT NULL COMMENT '类型',
  qty DECIMAL(14,4) NOT NULL,
  unit_cost DECIMAL(14,4) DEFAULT 0,
  amount DECIMAL(14,2) DEFAULT 0,
  reference VARCHAR(128) DEFAULT '' COMMENT '单据号',
  voucher_id INT DEFAULT NULL,
  trans_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_id) REFERENCES acc_inventory_items(id),
  KEY idx_date (trans_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 13. 银行对账单
CREATE TABLE IF NOT EXISTS acc_bank_statements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  account_id INT NOT NULL COMMENT '账户ID',
  file_name VARCHAR(128) DEFAULT '',
  statement_date DATE,
  opening_balance DECIMAL(14,2) DEFAULT 0,
  closing_balance DECIMAL(14,2) DEFAULT 0,
  status ENUM('pending','partial','matched') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 14. 银行对账单明细
CREATE TABLE IF NOT EXISTS acc_bank_statement_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  statement_id INT NOT NULL,
  line_no INT DEFAULT 1,
  transaction_date DATE NOT NULL,
  description VARCHAR(256) DEFAULT '',
  debit_amount DECIMAL(14,2) DEFAULT 0,
  credit_amount DECIMAL(14,2) DEFAULT 0,
  balance DECIMAL(14,2) DEFAULT 0,
  match_status ENUM('unmatched','matched','partial') DEFAULT 'unmatched',
  FOREIGN KEY (statement_id) REFERENCES acc_bank_statements(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 15. 银行对账记录
CREATE TABLE IF NOT EXISTS acc_bank_reconciliations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  statement_id INT NOT NULL,
  statement_item_id INT NOT NULL,
  voucher_entry_id INT DEFAULT NULL,
  amount DECIMAL(14,2) NOT NULL,
  status ENUM('matched','unmatched') DEFAULT 'matched',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (statement_id) REFERENCES acc_bank_statements(id),
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 16. 对账记录 (通用)
CREATE TABLE IF NOT EXISTS acc_reconciliations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  account_id INT DEFAULT NULL,
  type VARCHAR(32) DEFAULT 'bank',
  status VARCHAR(16) DEFAULT 'open',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 17. 对账明细
CREATE TABLE IF NOT EXISTS acc_reconciliation_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reconciliation_id INT NOT NULL,
  transaction_id INT DEFAULT NULL,
  bank_item_id INT DEFAULT NULL,
  matched_amount DECIMAL(14,2) DEFAULT 0,
  FOREIGN KEY (reconciliation_id) REFERENCES acc_reconciliations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 18. 审计日志
CREATE TABLE IF NOT EXISTS acc_audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  user_id INT DEFAULT NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) DEFAULT '',
  target_id INT DEFAULT NULL,
  detail TEXT,
  ip VARCHAR(45) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_account_set (account_set_id),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 19. 币种
CREATE TABLE IF NOT EXISTS acc_currencies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(8) NOT NULL COMMENT 'CNY/USD/EUR/JPY',
  name VARCHAR(32) NOT NULL,
  symbol VARCHAR(8) DEFAULT '',
  rate DECIMAL(10,6) DEFAULT 1.000000 COMMENT '对本位币汇率',
  is_active TINYINT(1) DEFAULT 1,
  UNIQUE KEY uk_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 20. 税务设置
CREATE TABLE IF NOT EXISTS acc_tax_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  tax_type VARCHAR(32) NOT NULL COMMENT 'vat/cit/surtax',
  rate DECIMAL(8,4) DEFAULT 0,
  description VARCHAR(128) DEFAULT '',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 21. 税务报告
CREATE TABLE IF NOT EXISTS acc_tax_reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  period_year INT NOT NULL,
  period_month INT DEFAULT NULL,
  tax_type VARCHAR(32) NOT NULL,
  taxable_amount DECIMAL(14,2) DEFAULT 0,
  tax_amount DECIMAL(14,2) DEFAULT 0,
  status VARCHAR(16) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 22. 现金流量映射
CREATE TABLE IF NOT EXISTS acc_cash_flow_mappings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  subject_id INT DEFAULT NULL,
  cf_category VARCHAR(32) NOT NULL COMMENT 'operating/investing/financing',
  cf_item VARCHAR(64) NOT NULL,
  KEY idx_account_set (account_set_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 23. 现金流量项目
CREATE TABLE IF NOT EXISTS acc_cash_flow_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  code VARCHAR(16) DEFAULT '',
  name VARCHAR(64) NOT NULL,
  category ENUM('operating','investing','financing') NOT NULL,
  direction ENUM('inflow','outflow') NOT NULL,
  sort_order INT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 24. 审批记录
CREATE TABLE IF NOT EXISTS acc_approval_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  voucher_id INT DEFAULT NULL,
  action VARCHAR(16) NOT NULL,
  user_id INT DEFAULT NULL,
  comment VARCHAR(256) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 25. 凭证模板
CREATE TABLE IF NOT EXISTS acc_voucher_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_set_id INT DEFAULT 1,
  name VARCHAR(64) NOT NULL,
  description VARCHAR(256) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 26. 凭证模板分录
CREATE TABLE IF NOT EXISTS acc_voucher_template_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  template_id INT NOT NULL,
  subject_id INT DEFAULT NULL,
  line_no INT DEFAULT 1,
  summary VARCHAR(256) DEFAULT '',
  debit_formula VARCHAR(64) DEFAULT '',
  credit_formula VARCHAR(64) DEFAULT '',
  FOREIGN KEY (template_id) REFERENCES acc_voucher_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 27. 管理员表 (扩展role字段)
ALTER TABLE admins MODIFY COLUMN role ENUM('super_admin','admin','accountant','viewer') NOT NULL DEFAULT 'admin';

-- ============================================
-- 默认种子数据
-- ============================================

-- 默认账套
INSERT IGNORE INTO acc_account_sets (id, name, company, year, start_date, end_date)
VALUES (1, '默认账套', '默认公司', 2026, '2026-01-01', '2026-12-31');

-- 币种
INSERT IGNORE INTO acc_currencies (code, name, symbol, rate) VALUES
('CNY', '人民币', '¥', 1.000000),
('USD', '美元', '$', 7.2500),
('EUR', '欧元', '€', 7.8500),
('JPY', '日元', '¥', 0.0480);

-- 标准科目体系 (企业会计准则)
INSERT IGNORE INTO acc_subjects (code, name, type, direction, sort_order) VALUES
-- 资产类 (1xxx)
('1001', '库存现金', 'asset', 'debit', 1),
('1002', '银行存款', 'asset', 'debit', 2),
('1012', '其他货币资金', 'asset', 'debit', 3),
('1101', '交易性金融资产', 'asset', 'debit', 4),
('1121', '应收票据', 'asset', 'debit', 5),
('1122', '应收账款', 'asset', 'debit', 6),
('1123', '预付账款', 'asset', 'debit', 7),
('1131', '应收股利', 'asset', 'debit', 8),
('1221', '其他应收款', 'asset', 'debit', 9),
('1231', '坏账准备', 'asset', 'credit', 10),
('1401', '材料采购', 'asset', 'debit', 11),
('1403', '原材料', 'asset', 'debit', 12),
('1405', '库存商品', 'asset', 'debit', 13),
('1411', '周转材料', 'asset', 'debit', 14),
('1471', '存货跌价准备', 'asset', 'credit', 15),
('1501', '持有至到期投资', 'asset', 'debit', 16),
('1511', '长期股权投资', 'asset', 'debit', 17),
('1521', '投资性房地产', 'asset', 'debit', 18),
('1601', '固定资产', 'asset', 'debit', 19),
('1602', '累计折旧', 'asset', 'credit', 20),
('1604', '在建工程', 'asset', 'debit', 21),
('1701', '无形资产', 'asset', 'debit', 22),
('1702', '累计摊销', 'asset', 'credit', 23),
('1801', '长期待摊费用', 'asset', 'debit', 24),
('1901', '待处理财产损溢', 'asset', 'debit', 25),
-- 负债类 (2xxx)
('2001', '短期借款', 'liability', 'credit', 26),
('2201', '应付票据', 'liability', 'credit', 27),
('2202', '应付账款', 'liability', 'credit', 28),
('2203', '预收账款', 'liability', 'credit', 29),
('2211', '应付职工薪酬', 'liability', 'credit', 30),
('2221', '应交税费', 'liability', 'credit', 31),
('2231', '应付利息', 'liability', 'credit', 32),
('2241', '其他应付款', 'liability', 'credit', 33),
('2501', '长期借款', 'liability', 'credit', 34),
('2701', '长期应付款', 'liability', 'credit', 35),
-- 权益类 (3xxx)
('3001', '清算备付金', 'equity', 'credit', 36),
('3101', '衍生工具', 'equity', 'credit', 37),
('4001', '实收资本', 'equity', 'credit', 38),
('4002', '资本公积', 'equity', 'credit', 39),
('4101', '盈余公积', 'equity', 'credit', 40),
('4103', '本年利润', 'equity', 'credit', 41),
('4104', '利润分配', 'equity', 'credit', 42),
-- 成本类 (4xxx)
('5001', '生产成本', 'cost', 'debit', 43),
('5101', '制造费用', 'cost', 'debit', 44),
('5201', '劳务成本', 'cost', 'debit', 45),
('5301', '研发支出', 'cost', 'debit', 46),
-- 损益-收入 (5xxx)
('6001', '主营业务收入', 'revenue', 'credit', 47),
('6051', '其他业务收入', 'revenue', 'credit', 48),
('6101', '公允价值变动损益', 'revenue', 'credit', 49),
('6111', '投资收益', 'revenue', 'credit', 50),
('6301', '营业外收入', 'revenue', 'credit', 51),
-- 损益-费用 (5xxx/6xxx)
('6401', '主营业务成本', 'expense', 'debit', 52),
('6402', '其他业务成本', 'expense', 'debit', 53),
('6403', '税金及附加', 'expense', 'debit', 54),
('6601', '销售费用', 'expense', 'debit', 55),
('6602', '管理费用', 'expense', 'debit', 56),
('6603', '财务费用', 'expense', 'debit', 57),
('6701', '资产减值损失', 'expense', 'debit', 58),
('6711', '营业外支出', 'expense', 'debit', 59),
('6801', '所得税费用', 'expense', 'debit', 60),
('6901', '以前年度损益调整', 'expense', 'debit', 61);

-- 默认税务设置
INSERT IGNORE INTO acc_tax_settings (tax_type, rate, description) VALUES
('vat', 0.13, '增值税税率(一般纳税人)'),
('vat_small', 0.03, '增值税税率(小规模)'),
('cit', 0.25, '企业所得税税率'),
('urban_construction', 0.07, '城市维护建设税'),
('education_surcharge', 0.03, '教育费附加'),
('local_education', 0.02, '地方教育附加');

-- 默认管理员 (admin/admin123)
INSERT IGNORE INTO admins (username, password_hash, role) VALUES
('admin', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'super_admin');
