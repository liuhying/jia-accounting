-- 家APP - 公司记账模块 数据库初始化
-- 执行: mysql -u root jia_app < acc_init.sql

-- 收支分类
CREATE TABLE IF NOT EXISTS acc_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL COMMENT '分类名称',
  type ENUM('income','expense') NOT NULL DEFAULT 'expense' COMMENT '收支类型',
  parent_id INT DEFAULT NULL COMMENT '父分类ID',
  sort_order INT DEFAULT 0 COMMENT '排序',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 支付账户
CREATE TABLE IF NOT EXISTS acc_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL COMMENT '账户名称',
  type ENUM('cash','bank','wechat','alipay','other') NOT NULL DEFAULT 'other',
  balance DECIMAL(12,2) DEFAULT 0.00 COMMENT '当前余额',
  note VARCHAR(200) DEFAULT '' COMMENT '备注',
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 交易记录
CREATE TABLE IF NOT EXISTS acc_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('income','expense') NOT NULL COMMENT '收支类型',
  amount DECIMAL(12,2) NOT NULL COMMENT '金额',
  category_id INT NOT NULL COMMENT '分类ID',
  account_id INT DEFAULT NULL COMMENT '账户ID',
  date DATE NOT NULL COMMENT '发生日期',
  description VARCHAR(500) DEFAULT '' COMMENT '摘要',
  counterparty VARCHAR(100) DEFAULT '' COMMENT '对方名称',
  invoice_no VARCHAR(50) DEFAULT '' COMMENT '发票号',
  is_tax_deductible TINYINT(1) DEFAULT 0 COMMENT '是否可抵扣',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 初始分类
INSERT INTO acc_categories (name, type, sort_order) VALUES
('主营业务收入', 'income', 1),
('技术服务收入', 'income', 2),
('其他收入', 'income', 3),
('服务器/域名费', 'expense', 1),
('办公费用', 'expense', 2),
('差旅交通', 'expense', 3),
('业务招待', 'expense', 4),
('税费', 'expense', 5),
('软件/工具订阅', 'expense', 6),
('其他费用', 'expense', 9);

-- 初始账户
INSERT INTO acc_accounts (name, type, balance) VALUES
('现金', 'cash', 0),
('银行卡', 'bank', 0),
('微信支付', 'wechat', 0),
('支付宝', 'alipay', 0);
