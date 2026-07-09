-- 家记账 - 辅助核算模块初始化
-- 辅助核算类型表
CREATE TABLE IF NOT EXISTS acc_auxiliary_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL COMMENT '类型编码',
  name VARCHAR(50) NOT NULL COMMENT '类型名称',
  description VARCHAR(200) DEFAULT '' COMMENT '说明',
  sort_order INT DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 辅助核算项目表
CREATE TABLE IF NOT EXISTS acc_auxiliary_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type_id INT NOT NULL COMMENT '辅助类型ID',
  code VARCHAR(30) DEFAULT '' COMMENT '项目编码',
  name VARCHAR(100) NOT NULL COMMENT '项目名称',
  contact VARCHAR(50) DEFAULT '' COMMENT '联系人',
  phone VARCHAR(30) DEFAULT '' COMMENT '联系电话',
  address VARCHAR(200) DEFAULT '' COMMENT '地址',
  note VARCHAR(200) DEFAULT '' COMMENT '备注',
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (type_id) REFERENCES acc_auxiliary_types(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 凭证分录辅助核算关联表
CREATE TABLE IF NOT EXISTS acc_entry_auxiliary (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entry_id INT NOT NULL COMMENT '分录ID (acc_voucher_entries.id)',
  aux_type_id INT NOT NULL COMMENT '辅助类型ID',
  aux_item_id INT NOT NULL COMMENT '辅助项目ID',
  PRIMARY KEY (entry_id, aux_type_id),
  FOREIGN KEY (entry_id) REFERENCES acc_voucher_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (aux_type_id) REFERENCES acc_auxiliary_types(id),
  FOREIGN KEY (aux_item_id) REFERENCES acc_auxiliary_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 插入默认辅助核算类型
INSERT INTO acc_auxiliary_types (code, name, description, sort_order) VALUES
('customer', '客户往来', '应收账款/应付账款按客户维度辅助核算', 1),
('supplier', '供应商往来', '应付账款/预付账款按供应商维度辅助核算', 2),
('department', '部门核算', '管理费用/销售费用按部门维度辅助核算', 3),
('project', '项目核算', '按项目维度核算收入成本费用', 4),
('personal', '个人往来', '其他应收款/其他应付款按个人维度辅助核算', 5)
ON DUPLICATE KEY UPDATE name=VALUES(name);
