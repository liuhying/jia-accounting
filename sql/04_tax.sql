-- 税务模块数据库迁移
-- 用途：添加税务设置表 + 税务报告存储表

CREATE TABLE IF NOT EXISTS acc_tax_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tax_key VARCHAR(64) NOT NULL UNIQUE COMMENT '税率键名',
  tax_name VARCHAR(128) NOT NULL COMMENT '税率中文名',
  rate DECIMAL(6,4) NOT NULL DEFAULT 0 COMMENT '税率（小数，如 0.13 = 13%）',
  category VARCHAR(32) DEFAULT NULL COMMENT '分类：vat/cit/surtax',
  sort_order INT DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  remark VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='税务设置表';

-- 标准中国税率预设（小规模纳税人 + 一般纳税人）
INSERT INTO acc_tax_settings (tax_key, tax_name, rate, category, sort_order, remark) VALUES
('vat_output_std', '增值税-销项-标准税率', 0.13, 'vat', 1, '一般纳税人标准'),
('vat_output_9', '增值税-销项-9%', 0.09, 'vat', 2, '交通运输/建筑/不动产等'),
('vat_output_6', '增值税-销项-6%', 0.06, 'vat', 3, '现代服务业'),
('vat_input_std', '增值税-进项-标准税率', 0.13, 'vat', 4, '一般纳税人可抵扣'),
('vat_input_9', '增值税-进项-9%', 0.09, 'vat', 5, '交通运输等可抵扣'),
('vat_input_6', '增值税-进项-6%', 0.06, 'vat', 6, '服务业进项'),
('vat_small_output', '增值税-小规模-征收率', 0.03, 'vat', 7, '小规模纳税人'),
('cit_rate', '企业所得税税率', 0.25, 'cit', 8, '标准税率25%，小微企业阶梯优惠'),
('urban_maintenance', '城市维护建设税', 0.07, 'surtax', 9, '市区7%，县城5%，其他1%'),
('stamp_duty', '印花税-资金账簿', 0.00025, 'surtax', 13, '实收资本+资本公积的万分之2.5'),
('education_surcharge', '教育费附加', 0.03, 'surtax', 10, ''),
('local_education', '地方教育附加', 0.02, 'surtax', 11, ''),
('stamp_tax', '印花税-购销合同', 0.0003, 'surtax', 12, '按购销金额万分之三')
ON DUPLICATE KEY UPDATE rate=VALUES(rate), remark=VALUES(remark);

-- 税务报告生成记录（可选：缓存已生成的报告）
CREATE TABLE IF NOT EXISTS acc_tax_reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  report_type VARCHAR(32) NOT NULL COMMENT 'vat/cit/surtax/summary',
  report_period VARCHAR(7) NOT NULL COMMENT '报告期间 如 2026-06',
  report_data JSON NOT NULL COMMENT '报告完整数据',
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_type_period (report_type, report_period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='税务报告缓存表';
